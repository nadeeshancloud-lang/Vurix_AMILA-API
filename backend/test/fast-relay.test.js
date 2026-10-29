const {test}=require('node:test');
const assert=require('node:assert/strict');
const {EventEmitter}=require('node:events');
const {Readable,Writable}=require('node:stream');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {createFastRelay}=require('../src/services/fast-relay');
const {createMediaService,publicAddress}=require('../src/services/extraction.service');
const {failure,downloadLinks}=require('../src/controllers/media.controller');
const format={format_id:'p',ext:'mp4',vcodec:'avc1',acodec:'mp4a',fast_download_url:'https://cdn.example/video.mp4',fast_download_headers:{'User-Agent':'Provider','Referer':'https://source.example/','Cookie':'never forward','Authorization':'never forward'}};
function output(){const chunks=[];const res=new Writable({write(chunk,_encoding,callback){chunks.push(Buffer.from(chunk));callback()}});res.headers={};res.setHeader=(key,value)=>{res.headers[key]=value};res.removeHeader=key=>{delete res.headers[key]};res.body=()=>Buffer.concat(chunks);res.download=(file,_name,_options,callback)=>{fs.readFile(file).then(data=>{res.setHeader('Content-Length',String(data.length));res.end(data,()=>callback())},callback)};return res}
function incoming(body='video bytes',headers={},status=200){const response=Readable.from([Buffer.from(body)]);response.statusCode=status;response.headers={'content-type':'video/mp4','content-length':String(Buffer.byteLength(body)),...headers};return response}
function mockRequest(handler){return (url,options,callback)=>{const request=new EventEmitter();request.setTimeout=()=>request;request.end=()=>queueMicrotask(()=>handler(url,options,callback));request.destroy=reason=>{if(reason)request.emit('error',reason)};options.signal.addEventListener('abort',()=>request.destroy(options.signal.reason),{once:true});return request}}
function input(headers={}){const req=new EventEmitter();req.headers=headers;return req}
const publicLookup=async()=>[{address:'93.184.216.34',family:4}];

test('relay pins the public DNS answer including all:true and streams without leaking headers',async()=>{
 let sent;const relay=createFastRelay({lookup:publicLookup,request:mockRequest((url,options,callback)=>{sent=options;assert.equal(url.hostname,'cdn.example');options.lookup(url.hostname,{all:true},(error,answers)=>{assert.equal(error,null);assert.deepEqual(answers,[{address:'93.184.216.34',family:4}])});callback(incoming('video bytes',{'set-cookie':'private session',etag:'"source"','accept-ranges':'bytes'}))})});
 const res=output();await relay.relay({format,req:input(),res,filename:'සිංහල.mp4',maxBytes:1024});assert.equal(res.body().toString(),'video bytes');assert.equal(res.headers['Content-Length'],'11');assert.equal(res.headers['Content-Type'],'video/mp4');assert.match(res.headers['Content-Disposition'],/filename\*=UTF-8/);assert.equal(res.headers['Set-Cookie'],undefined);assert.equal(res.headers['X-Vurix-Verified'],undefined);assert.equal(sent.headers.Cookie,undefined);assert.equal(sent.headers.Authorization,undefined);assert.equal(sent.headers['Accept-Encoding'],'identity');relay.close();
});
test('relay revalidates every redirect and rejects a private address before requesting it',async()=>{
 let calls=0;const relay=createFastRelay({lookup:async host=>[{address:host==='cdn.example'?'93.184.216.34':'127.0.0.1',family:4}],request:mockRequest((_url,_options,callback)=>{calls++;callback(incoming('',{location:'https://private.example/secret'},302))})});
 await assert.rejects(relay.relay({format,req:input(),res:output(),filename:'v.mp4',maxBytes:100}),/not public/);assert.equal(calls,1);assert.equal(publicAddress('ff02::1'),false);relay.close();
});
test('relay DNS lookup has the same finite header deadline',async()=>{
 const relay=createFastRelay({lookup:()=>new Promise(()=>{}),headerTimeoutMs:20,request:()=>{throw Error('must not request')}});
 await assert.rejects(relay.relay({format,req:input(),res:output(),filename:'v.mp4',maxBytes:100}),/too long to connect/);relay.close();
});
test('relay rejects upstream error pages and excessive declared lengths before sending bytes',async()=>{
 for(const response of [incoming('<html>',{'content-type':'text/html'}),incoming('not video',{},403),incoming('video',{'content-length':'10000'})]){
  const relay=createFastRelay({lookup:publicLookup,request:mockRequest((_url,_options,callback)=>callback(response))});const res=output();await assert.rejects(relay.relay({format,req:input(),res,filename:'v.mp4',maxBytes:100}));assert.equal(res.body().length,0);relay.close();
 }
});
test('known oversized source metadata prevents any upstream request',async()=>{
 const relay=createFastRelay({lookup:()=>{throw Error('must not resolve')},request:()=>{throw Error('must not request')}});await assert.rejects(relay.relay({format:{...format,fast_filesize:101},req:input(),res:output(),filename:'v.mp4',maxBytes:100}),/file-size limit/);relay.close();
});
test('unknown-length output is bounded and truncated declared bodies fail',async()=>{
 for(const headers of [{'content-length':undefined},{'content-length':'10'}]){
  const relay=createFastRelay({lookup:publicLookup,request:mockRequest((_url,_options,callback)=>callback(incoming('12345678901',headers)))});await assert.rejects(relay.relay({format,req:input(),res:output(),filename:'v.mp4',maxBytes:10}));relay.close();
 }
 const relay=createFastRelay({lookup:publicLookup,request:mockRequest((_url,_options,callback)=>callback(incoming('short',{'content-length':'10'})))});await assert.rejects(relay.relay({format,req:input(),res:output(),filename:'v.mp4',maxBytes:100}),/ended early/);relay.close();
});
test('validated range requests preserve exact bytes and source validators',async()=>{
 const relay=createFastRelay({lookup:publicLookup,request:mockRequest((_url,options,callback)=>{assert.equal(options.headers.Range,'bytes=2-5');assert.equal(options.headers['If-Range'],'"source"');callback(incoming('2345',{'content-range':'bytes 2-5/10',etag:'"source"'},206))})});
 const res=output();await relay.relay({format,req:input({range:'bytes=2-5','if-range':'"source"'}),res,filename:'v.mp4',maxBytes:100});assert.equal(res.statusCode,206);assert.equal(res.headers['Content-Range'],'bytes 2-5/10');assert.equal(res.headers.ETag,'"source"');assert.equal(res.body().toString(),'2345');relay.close();
});
test('resume is advertised only with a usable source identity validator',async()=>{
 for(const [headers,expected]of [[{'accept-ranges':'bytes'},undefined],[{'accept-ranges':'bytes',etag:'W/"weak"'},undefined],[{'accept-ranges':'bytes','last-modified':'Wed, 28 Oct 2026 10:00:00 GMT'},'bytes']]){
  const relay=createFastRelay({lookup:publicLookup,request:mockRequest((_url,_options,callback)=>callback(incoming('video',headers)))});const res=output();await relay.relay({format,req:input(),res,filename:'v.mp4',maxBytes:100});assert.equal(res.headers['Accept-Ranges'],expected);relay.close();
 }
});
test('invalid or incorrect ranges and source 416 retain a safe HTTP 416 result',async()=>{
 const relay=createFastRelay({lookup:publicLookup,request:mockRequest((_url,_options,callback)=>callback(incoming('',{'content-range':'bytes */10'},416)))});
 await assert.rejects(relay.relay({format,req:input({range:'bytes=10-'}),res:output(),filename:'v.mp4',maxBytes:100}),value=>value.status===416&&value.headers['Content-Range']==='bytes */10');
 await assert.rejects(relay.relay({format,req:input({range:'bytes=0-1,3-4'}),res:output(),filename:'v.mp4',maxBytes:100}),value=>value.status===416);relay.close();
});
test('concurrency is bounded and close aborts pending public-host lookups',async()=>{
 const relay=createFastRelay({lookup:()=>new Promise(()=>{}),maxConcurrent:1});const a=relay.relay({format,req:input(),res:output(),filename:'v.mp4',maxBytes:100});const caught=a.catch(value=>value);
 await assert.rejects(relay.relay({format,req:input(),res:output(),filename:'v.mp4',maxBytes:100}),value=>value.code==='service_busy');relay.close();assert.match((await caught).message,/closing/);
});
test('client disconnect tears down a streaming body and releases the relay slot',async()=>{
 let body;const relay=createFastRelay({lookup:publicLookup,maxConcurrent:1,request:mockRequest((_url,_options,callback)=>{body=new Readable({read(){}});body.statusCode=200;body.headers={'content-type':'video/mp4'};callback(body);body.push(Buffer.from('first bytes'))})});
 const res=output(),req=input();let first;const ready=new Promise(resolve=>{first=resolve});const previousWrite=res._write;res._write=(chunk,encoding,callback)=>{previousWrite.call(res,chunk,encoding,callback);first()};
 const transfer=relay.relay({format,req,res,filename:'v.mp4',maxBytes:100});const caught=transfer.catch(value=>value);await ready;req.emit('aborted');await caught;assert.equal(body.destroyed,true);relay.close();
});
test('public metadata contains only a source-bound relay URL and no CDN session headers',()=>{
 const source='https://source.example/watch',data=downloadLinks({source_url:source,extraction_id:'opaque-id',title:'Test',video_formats:[{...format,fast_filesize:123}],audio_formats:[{format_id:'mp3_128',ext:'mp3',fast_download_url:'https://cdn.example/not-mp3',fast_download_headers:{Cookie:'private'}}]},'https://api.example',source);
 const video=data.video_formats[0],relay=new URL(video.fast_download_url);assert.equal(relay.origin,'https://api.example');assert.equal(relay.pathname,'/api/v1/fast-stream');assert.equal(relay.searchParams.get('extraction_id'),'opaque-id');assert.equal(relay.searchParams.get('url'),source);assert.equal(relay.searchParams.get('format_id'),'p');assert.deepEqual(video.fast_download_headers,{});assert.equal(video.fast_filesize,undefined);assert.match(video.download_url,/\/api\/v1\/stream\?/);assert.equal(data.audio_formats[0].fast_download_url,undefined);
 const missing=downloadLinks({video_formats:[{...format}],audio_formats:[]},'https://api.example',source);assert.equal(missing.video_formats[0].fast_download_url,undefined);
 const prepared=downloadLinks({extraction_id:'opaque-id',video_formats:[{...format,fast_filesize:123,filesize:456,prepared:true}],audio_formats:[]},'https://api.example',source).video_formats[0];assert.equal(prepared.fast_download_url,undefined);assert.equal(prepared.fast_filesize,undefined);assert.equal(prepared.filesize,456);
});
test('source-bound snapshots and expiry gate fast delivery without repeating extraction',async t=>{
 const base=path.resolve(process.env.VURIX_TEST_TMP||os.tmpdir());const temp=await fs.mkdtemp(path.join(base,'clip-relay-test-'));let clock=1000,calls=0;
 const engine=async args=>{calls++;if(args.includes('--download')){const dir=args[args.indexOf('--output-dir')+1];await fs.writeFile(path.join(dir,'ready.mp4'),'verified fallback');return {success:true,path:'ready.mp4',mime:'video/mp4',size:17}}await fs.writeFile(args[args.indexOf('--info-cache')+1],'{}');return {success:true,webpage_url:args[0],video_formats:[{...format,fast_download_url:'https://1.1.1.1/video.mp4'}],audio_formats:[]}};
 const service=createMediaService({engine,clock:()=>clock,tempBase:temp,cleanupIntervalMs:0,relayOptions:{request:mockRequest((_url,_options,callback)=>callback(incoming()))}});
 t.after(async()=>{await service.close();assert.equal(path.dirname(temp),base);assert.ok(path.basename(temp).startsWith('clip-relay-test-'));await fs.rm(temp,{recursive:true,force:true})});
 const source='https://source.example/watch',metadata=await service.extractMetadata(source);const args={url:source,formatId:'p',extractionId:metadata.extraction_id,filename:'v.mp4',req:input(),res:output()};
 await service.streamFastDownload(args);assert.equal(calls,1);await assert.rejects(service.streamFastDownload({...args,url:'https://other.example/watch',req:input(),res:output()}),value=>value.code==='relay_expired');await assert.rejects(service.streamFastDownload({...args,formatId:'wrong',req:input(),res:output()}),value=>value.code==='relay_expired');clock+=120001;const fallback=output();await service.streamFastDownload({...args,req:input(),res:fallback});assert.equal(fallback.body().toString(),'verified fallback');assert.equal(fallback.headers['X-Clip-Sevan-Delivery'],'verified-fallback');assert.equal(calls,2);
});
async function fallbackFixture(t,{kind='unavailable',cap=1000}={}){
 const base=path.resolve(process.env.VURIX_TEST_TMP||os.tmpdir());const temp=await fs.mkdtemp(path.join(base,'clip-fallback-test-'));let extracts=0,prepares=0,requests=0;let activeRequest;
 const engine=async args=>{if(args.includes('--download')){prepares++;const dir=args[args.indexOf('--output-dir')+1];await fs.writeFile(path.join(dir,'ready.mp4'),'verified fallback');return {success:true,path:'ready.mp4',mime:'video/mp4',size:17}}extracts++;await fs.writeFile(args[args.indexOf('--info-cache')+1],'{}');return {success:true,webpage_url:args[0],video_formats:[{...format,fast_download_url:'https://1.1.1.1/video.mp4',fast_filesize:50}],audio_formats:[]}};
 const request=mockRequest((_url,_options,callback)=>{requests++;if(kind==='private')callback(incoming('',{location:'https://127.0.0.1/secret'},302));else if(kind==='range')callback(incoming('',{'content-range':'bytes */50'},416));else if(kind==='cancel'){activeRequest.aborted=true;activeRequest.emit('aborted')}else callback(incoming('',{},403))});
 const service=createMediaService({engine,tempBase:temp,cleanupIntervalMs:0,maxMediaBytes:cap,relayOptions:{request}});t.after(async()=>{await service.close();assert.equal(path.dirname(temp),base);assert.ok(path.basename(temp).startsWith('clip-fallback-test-'));await fs.rm(temp,{recursive:true,force:true})});
 const source='https://source.example/watch',meta=await service.extractMetadata(source);
 return {service,meta,counts:()=>({extracts,prepares,requests}),run:async(headers={})=>{const req=input(headers),res=output();activeRequest=req;await service.streamFastDownload({url:source,formatId:'p',extractionId:meta.extraction_id,filename:'v.mp4',req,res});return res}};
}
test('unavailable relay falls back within the same response and old cached quick URLs reuse verified bytes',async t=>{
 const f=await fallbackFixture(t);const first=await f.run();assert.equal(first.body().toString(),'verified fallback');assert.equal(first.headers['X-Clip-Sevan-Delivery'],'verified-fallback');assert.equal(first.headers['X-Vurix-Verified'],'video-audio-v4');assert.deepEqual(f.counts(),{extracts:1,prepares:1,requests:1});
 const second=await f.run();assert.equal(second.body().toString(),'verified fallback');assert.equal(second.headers['X-Clip-Sevan-Prepared'],'cache');assert.deepEqual(f.counts(),{extracts:1,prepares:1,requests:1});const fresh=await f.service.extractMetadata('https://source.example/watch');assert.equal(fresh.video_formats[0].fast_download_url,undefined);
});
test('source policy, byte caps, bad ranges and cancellation never invoke verified retry',async t=>{
 for(const [kind,cap,expected]of [['private',1000,'relay_source_invalid'],['range',1000,'range_not_satisfiable'],['cancel',1000,'relay_cancelled'],['unavailable',10,'relay_limit']]){
  const f=await fallbackFixture(t,{kind,cap});await assert.rejects(f.run(kind==='range'?{range:'bytes=100-'}:{}),value=>value.code===expected);assert.equal(f.counts().prepares,0);assert.equal(f.counts().extracts,1);
 }
});
test('expired quick connections have an explicit fallback-compatible HTTP 410',()=>{
 const res={headers:{'Content-Length':'123','Content-Range':'bytes 0-122/123',ETag:'"stale"'},setHeader(k,v){this.headers[k]=v},removeHeader(k){delete this.headers[k]},status(n){this.statusCode=n;return this},json(data){this.body=data}};failure(res,Object.assign(new Error('Expired'),{code:'relay_expired'}));assert.equal(res.statusCode,410);assert.equal(res.body.code,'relay_expired');assert.equal(res.headers['Content-Length'],undefined);assert.equal(res.headers['Content-Range'],undefined);assert.equal(res.headers.ETag,undefined);
});
