const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {EventEmitter}=require('node:events');
const {createMediaService}=require('../src/services/extraction.service');
function deferred(){let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function response(hold=false){const res=new EventEmitter();res.headers={};res.started=deferred();res.writableFinished=false;res.setHeader=(k,v)=>{res.headers[k]=v};res.download=(file,filename,options,callback)=>{res.file=file;res.options=options;res.complete=async()=>{try{res.body=await fs.readFile(file);res.writableFinished=true;callback()}catch(e){callback(e)}};res.started.resolve();if(!hold)void res.complete()};return res}
async function fixture(t,settings={}){
 const base=path.resolve(process.env.VURIX_TEST_TMP||os.tmpdir());const temp=await fs.mkdtemp(path.join(base,'clip-node-test-'));const calls=[];let time=1000;
 const engine=async(args,timeout,onCancel)=>{calls.push(args);if(args.includes('--info-cache')){settings.metadataStarted?.();await fs.writeFile(args[args.indexOf('--info-cache')+1],JSON.stringify({formats:[{url:'https://provider.example/private?signature=secret'}]}));if(settings.metadataGate)await settings.metadataGate.promise;return {success:true,title:'Video',webpage_url:settings.canonicalUrl||args[0],video_formats:[{format_id:'v',ext:'mp4'}],audio_formats:[]}}
  if(settings.prepareGate){settings.prepareStarted.resolve();onCancel?.(()=>{settings.cancelCalls=(settings.cancelCalls||0)+1;settings.prepareGate.reject(new Error('Cancelled'))});await settings.prepareGate.promise}
  const dir=args[args.indexOf('--output-dir')+1];const body=Buffer.from('immutable verified fixture output');await fs.writeFile(path.join(dir,'ready.mp4'),body);return {success:true,path:'ready.mp4',mime:'video/mp4',size:body.length,video_codec:'h264',audio_codec:'aac'};
 };
 const service=createMediaService({engine,tempBase:temp,clock:()=>time,cleanupIntervalMs:0,...settings.options});
 t.after(async()=>{await service.close();assert.equal(path.dirname(temp),base);assert.ok(path.basename(temp).startsWith('clip-node-test-'));await fs.rm(temp,{recursive:true,force:true})});
 return {service,calls,advance:n=>{time+=n},request:async(url='https://example.com/video',extra={},hold=false)=>{const req=new EventEmitter(),res=response(hold);const promise=service.streamDirectDownload({url,formatId:'v',type:'video',filename:'Video.mp4',req,res,...extra});return {req,res,promise}}};
}
test('concurrent format lookups share extraction and return isolated public metadata',async t=>{
 const gate=deferred(),f=await fixture(t,{metadataGate:gate});const a=f.service.extractMetadata('https://example.com/video');const b=f.service.extractMetadata('https://example.com/video');await new Promise(resolve=>setTimeout(resolve,20));gate.resolve();const [first,second]=await Promise.all([a,b]);assert.equal(f.calls.length,1);assert.equal(first.extraction_id,second.extraction_id);assert.ok(!JSON.stringify(first).includes('signature=secret'));first.video_formats[0].ext='bad';assert.equal((await f.service.extractMetadata('https://example.com/video')).video_formats[0].ext,'mp4');
});
test('first download reuses bound snapshot and second reuses verified bytes and ETag',async t=>{
 const f=await fixture(t);const meta=await f.service.extractMetadata('https://example.com/video');const a=await f.request(undefined,{extractionId:meta.extraction_id});await a.promise;const firstPrepare=f.calls.find(args=>args.includes('--download'));assert.ok(firstPrepare.includes('--info-json'));assert.equal(a.res.options.acceptRanges,true);const b=await f.request(undefined,{extractionId:meta.extraction_id});await b.promise;assert.equal(f.calls.filter(args=>args.includes('--download')).length,1);assert.equal(b.res.headers['X-Clip-Sevan-Prepared'],'cache');assert.equal(a.res.headers.ETag,b.res.headers.ETag);assert.deepEqual(a.res.body,b.res.body);const updated=await f.service.extractMetadata('https://example.com/video');assert.equal(updated.video_formats[0].filesize,b.res.body.length);assert.equal(updated.video_formats[0].filesize_approx,undefined);
});
test('snapshot token cannot supply private info for a different URL and expires',async t=>{
 const f=await fixture(t);const meta=await f.service.extractMetadata('https://example.com/video');const other=await f.request('https://other.example/video',{extractionId:meta.extraction_id});await other.promise;assert.ok(!f.calls.at(-1).includes('--info-json'));f.advance(120001);const old=await f.request(undefined,{extractionId:meta.extraction_id});await old.promise;assert.ok(!f.calls.at(-1).includes('--info-json'));const next=await f.service.extractMetadata('https://example.com/video');assert.notEqual(meta.extraction_id,next.extraction_id);
});
test('one disconnected waiter does not kill preparation shared by another request',{timeout:5000},async t=>{
 const gate=deferred(),started=deferred(),settings={prepareGate:gate,prepareStarted:started};const f=await fixture(t,settings);const a=await f.request();const first=a.promise.catch(error=>error);const b=await f.request();await started.promise;await new Promise(resolve=>setImmediate(resolve));a.req.emit('aborted');assert.equal(settings.cancelCalls||0,0);gate.resolve();await b.promise;assert.match((await first).message,/cancelled/i);assert.equal(f.calls.filter(args=>args.includes('--download')).length,1);assert.ok(b.res.body.length);
});
test('expiry and eviction keep a file until its active reader completes',{timeout:5000},async t=>{
 const f=await fixture(t,{options:{preparedEntries:1}});const a=await f.request(undefined,{},true);await a.res.started.promise;const oldFile=a.res.file;f.advance(120001);const b=await f.request();await b.promise;assert.ok((await fs.stat(oldFile)).size);await a.res.complete();await a.promise;await assert.rejects(fs.stat(oldFile));assert.equal(f.calls.filter(args=>args.includes('--download')).length,2);
});
test('close waits for a current reader instead of deleting its file',{timeout:5000},async t=>{
 const f=await fixture(t);const a=await f.request(undefined,{},true);await a.res.started.promise;let closed=false;const closing=f.service.close().then(()=>{closed=true});await new Promise(resolve=>setImmediate(resolve));assert.equal(closed,false);assert.ok((await fs.stat(a.res.file)).size);await a.res.complete();await a.promise;await closing;assert.equal(closed,true);
});
test('cancelled queued preparation does not block the next request',{timeout:5000},async t=>{
 const gate=deferred(),started=deferred(),f=await fixture(t,{prepareGate:gate,prepareStarted:started,options:{concurrency:1}});const a=await f.request('https://example.com/a');await started.promise;const b=await f.request('https://example.com/b');const cancelled=b.promise.catch(error=>error);const c=await f.request('https://example.com/c');await new Promise(resolve=>setImmediate(resolve));b.req.emit('aborted');gate.resolve();await Promise.all([a.promise,c.promise]);assert.match((await cancelled).message,/cancelled/i);assert.equal(f.calls.filter(args=>args.includes('--download')).length,2);
});
test('metadata entry bound evicts stale handles and allows a fresh extraction',async t=>{
 const f=await fixture(t,{options:{snapshotEntries:1}});const first=await f.service.extractMetadata('https://example.com/a');await f.service.extractMetadata('https://example.com/b');const again=await f.service.extractMetadata('https://example.com/a');assert.notEqual(again.extraction_id,first.extraction_id);assert.equal(f.calls.filter(args=>args.includes('--info-cache')).length,3);
});
test('distinct cache misses have bounded provider extraction concurrency',{timeout:10000},async t=>{
 const gate=deferred(),started=deferred();let entered=0;const f=await fixture(t,{metadataGate:gate,metadataStarted:()=>{if(++entered===2)started.resolve()},options:{metadataConcurrency:2}});const requests=['a','b','c'].map(id=>f.service.extractMetadata('https://example.com/'+id));try{await started.promise;assert.equal(f.calls.length,2)}finally{gate.resolve()}await Promise.all(requests);assert.equal(f.calls.length,3);
});
test('meaningful fragments remain distinct even when provider canonical metadata drops them',async t=>{
 const f=await fixture(t,{canonicalUrl:'https://example.com/contest'});const firstUrl='https://example.com/contest#entries&eid=30138',secondUrl='https://example.com/contest#entries&eid=30139';const a=await f.service.extractMetadata(firstUrl),b=await f.service.extractMetadata(secondUrl);assert.notEqual(a.extraction_id,b.extraction_id);assert.equal(a.source_url,firstUrl);assert.equal(b.source_url,secondUrl);const wrong=await f.request(secondUrl,{extractionId:a.extraction_id});await wrong.promise;assert.ok(!f.calls.at(-1).includes('--info-json'));const bare=await f.request('https://example.com/contest',{extractionId:a.extraction_id});await bare.promise;assert.ok(!f.calls.at(-1).includes('--info-json'));
});
test('retained output budget applies to current readers and recovers after they finish',{timeout:5000},async t=>{
 const f=await fixture(t,{options:{maxMediaBytes:40,maxOutputBytes:70}});const a=await f.request('https://example.com/a',{},true);await a.res.started.promise;const b=await f.request('https://example.com/b');await assert.rejects(b.promise,error=>error.code==='service_busy');assert.equal(f.calls.filter(args=>args.includes('--download')).length,1);await a.res.complete();await a.promise;const again=await f.request('https://example.com/b');await again.promise;assert.equal(f.calls.filter(args=>args.includes('--download')).length,2);
});
test('disconnect during cache publication cannot retain a deleted output',{timeout:5000},async t=>{
 const f=await fixture(t,{options:{preparedEntries:1}});const first=await f.request('https://example.com/a');await first.promise;const original=fs.rm,blocked=deferred(),resume=deferred();let outcome;
 fs.rm=async(target,...args)=>{if(target===path.dirname(first.res.file)){blocked.resolve();await resume.promise}return original(target,...args)};
 try{const b=await f.request('https://example.com/b');outcome=b.promise.catch(error=>error);await blocked.promise;b.req.emit('aborted');await new Promise(resolve=>setTimeout(resolve,20));resume.resolve();assert.match((await outcome).message,/cancelled/i)}finally{resume.resolve();fs.rm=original}
 const again=await f.request('https://example.com/b');await again.promise;assert.equal(again.res.headers['X-Clip-Sevan-Prepared'],'cache');assert.ok(again.res.body.length);
});
test('uncached outputs advertise restart rather than impossible Range resume',async t=>{
 const f=await fixture(t,{options:{preparedBytes:1}});const a=await f.request();await a.promise;assert.equal(a.res.options.acceptRanges,false);await assert.rejects(fs.stat(a.res.file));const b=await f.request();await b.promise;assert.equal(f.calls.filter(args=>args.includes('--download')).length,2);
});
