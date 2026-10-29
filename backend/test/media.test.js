const {test}=require('node:test');
const assert=require('node:assert/strict');
const {validateUrl,publicAddress,safeError}=require('../src/services/extraction.service');
const {sanitizeFilename,failure}=require('../src/controllers/media.controller');
const {validateFastFormats}=require('../src/services/provider-engine');
test('public providers accepted after DNS validation',async()=>{assert.equal(await validateUrl('https://www.youtube.com/watch?v=123',async()=>[{address:'142.250.1.1'}]),'https://www.youtube.com/watch?v=123')});
test('metadata service, loopback and private addresses rejected',async()=>{for(const address of ['127.0.0.1','169.254.169.254','10.1.1.1','192.168.1.1','172.16.1.1','::1','::ffff:127.0.0.1'])assert.equal(publicAddress(address),false);await assert.rejects(validateUrl('https://local.invalid/video',async()=>[{address:'10.0.0.1'}]))});
test('credentials and non-web schemes rejected',async()=>{await assert.rejects(validateUrl('https://user:pass@example.com'));await assert.rejects(validateUrl('file:///etc/passwd'))});
test('error URLs redacted',()=>assert.equal(safeError('failed https://cdn.example/video?signature=secret'),'failed [link]'));
test('filename cannot inject a header or directory',()=>{assert.equal(sanitizeFilename('a/b\r\nX:yes','mp4'),'a_b__X_yes.mp4');assert.equal(sanitizeFilename('Video','mp3'),'Video.mp3')});
test('an unsatisfiable media Range keeps HTTP 416 and its Content-Range contract',()=>{const res={headers:{ETag:'old'},setHeader(k,v){this.headers[k]=v},removeHeader(k){delete this.headers[k]},status(code){this.code=code;return this},json(body){this.body=body}};failure(res,{status:416,message:'Range not satisfiable',headers:{'Content-Range':'bytes */123'}});assert.equal(res.code,416);assert.equal(res.headers['Content-Range'],'bytes */123');assert.equal(res.headers['Content-Type'],'application/json; charset=utf-8');assert.equal(res.headers.ETag,undefined);assert.equal(res.body.code,'range_not_satisfiable')});
test('fast delivery validates a shared public HTTPS host once and only returns safe headers',async()=>{
 const seen=[];const video={download_url:'https://api.example.com/stream',fast_download_url:'https://cdn.example.com/video.mp4?signature=public',fast_download_headers:{'user-agent':'Clip agent','Accept-Language':'en','Cookie':'secret','Authorization':'Bearer private','Origin':'https://example.com\r\nCookie: bad'},fast_filesize:12345};
 const source={video_formats:[video,{...video,fast_download_url:'https://cdn.example.com/other.mp4'}],audio_formats:[]};const data=await validateFastFormats(source,async origin=>{seen.push(origin);return origin});
 assert.deepEqual(seen,['https://cdn.example.com']);assert.deepEqual(data.video_formats[0].fast_download_headers,{'User-Agent':'Clip agent','Accept-Language':'en'});assert.equal(data.video_formats[0].fast_filesize,12345);assert.equal(data.video_formats[0].download_url,video.download_url);assert.equal(source.video_formats[0].fast_download_headers.Cookie,'secret');
});
test('invalid, private and session-bearing fast URL candidates retain only the normal delivery route',async()=>{
 const candidates=['http://cdn.example.com/v.mp4','https://user:secret@cdn.example.com/v.mp4','https://127.0.0.1/v.mp4','https://[::1]/v.mp4','https://169.254.169.254/v.mp4','https://cdn.example.com/v.mp4\r\nsecret'];
 const data=await validateFastFormats({video_formats:candidates.map(fast_download_url=>({format_id:'v',fast_download_url,fast_download_headers:{'User-Agent':'agent'},fast_filesize:100})),audio_formats:[]});
 for(const choice of data.video_formats){assert.equal(choice.format_id,'v');assert.equal(choice.fast_download_url,undefined);assert.equal(choice.fast_download_headers,undefined);assert.equal(choice.fast_filesize,undefined)}
});
test('fast delivery never labels an audio source as directly downloadable MP3',async()=>{
 const data=await validateFastFormats({video_formats:[],audio_formats:[{ext:'mp3',fast_download_url:'https://cdn.example.com/aac.m4a',fast_download_headers:{'User-Agent':'agent'},fast_filesize:100}]});assert.deepEqual(data.audio_formats,[{ext:'mp3'}]);
});
test('optional direct-host validation is bounded and never blocks the normal format list',async()=>{
 const choices=Array.from({length:12},(_,i)=>({format_id:String(i),fast_download_url:'https://cdn'+i+'.example.com/v.mp4'}));let lookups=0;
 const data=await validateFastFormats({video_formats:choices},async()=>{lookups++});assert.equal(lookups,8);assert.equal(data.video_formats.length,12);assert.equal(data.video_formats.filter(f=>f.fast_download_url).length,8);
});
