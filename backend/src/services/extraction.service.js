const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
const {randomUUID,createHash}=require('node:crypto');
const {createFastRelay}=require('./fast-relay');
const {runEngine,validateUrl,publicAddress,safeError,validateFastFormats}=require('./provider-engine');
// Some supported extractors identify the media inside the fragment; preserve it.
function canonical(value){return new URL(value).toString()}
function mediaKey(url,formatId,kind){return createHash('sha256').update(canonical(url)+'\n'+kind+'\n'+(formatId||'best')).digest('hex')}

/** Private snapshots and verified immutable outputs avoid repeating provider work. */
function createMediaService({engine=runEngine,clock=Date.now,tempBase=os.tmpdir(),snapshotTtlMs=120000,snapshotEntries=32,snapshotBytes=24*1024*1024,preparedTtlMs=120000,preparedEntries=4,preparedBytes=96*1024*1024,maxMediaBytes=Number(process.env.MAX_MEDIA_BYTES)||256*1024*1024,maxOutputBytes=Math.max(maxMediaBytes,512*1024*1024),concurrency=Math.max(1,Math.min(4,Number(process.env.MAX_CONCURRENT_DOWNLOADS)||1)),metadataConcurrency=2,cleanupIntervalMs=30000,relayOptions={}}={}){
 const fastRelay=createFastRelay(relayOptions);
 const snapshots=new Map(),aliases=new Map(),metadataPending=new Map(),prepared=new Map(),preparing=new Map(),outputs=new Set();let rootPromise,active=0,extracting=0,streams=0,reservedBytes=0,closed=false,cacheMutation=Promise.resolve();const queue=[],metadataQueue=[],idle=[];
 const mutate=fn=>{const operation=cacheMutation.then(fn);cacheMutation=operation.catch(()=>{});return operation};
 const root=()=>rootPromise||(rootPromise=fs.mkdtemp(path.join(tempBase,'clip-sevan-cache-')));
 const directory=async(prefix)=>{const parent=await root();const dir=path.join(parent,prefix+randomUUID());await fs.mkdir(dir,{mode:0o700});return dir};
 async function remove(dir){if(!dir)return;const parent=await root();if(path.dirname(path.resolve(dir))!==path.resolve(parent))throw new Error('Invalid cache directory.');await fs.rm(dir,{recursive:true,force:true})}
 const busy=e=>(e.readers||0)>0||(e.job?.waiters.size||0)>0||!!(e.job&&!e.job.finished);
 async function cleanupPrepared(e){if(!e.cached&&!busy(e)){await remove(e.dir);outputs.delete(e)}}
 async function prune(){return mutate(async()=>{
  for(const [id,e]of snapshots)if(e.until<=clock()){snapshots.delete(id);for(const alias of e.aliases)if(aliases.get(alias)===id)aliases.delete(alias);e.expired=true;if(!e.users)await remove(e.dir)}
  for(const [key,e]of prepared)if(e.until<=clock()){prepared.delete(key);e.cached=false;await cleanupPrepared(e)}
 })}
 function snapshotFor(url,id){const alias=canonical(url);const e=snapshots.get(id||aliases.get(alias));return e&&e.until>clock()&&e.aliases.has(alias)?e:null}
 function currentSizes(data,url){const result=structuredClone(data);for(const [name,kind]of [['video_formats','video'],['audio_formats','mp3']])result[name]=(result[name]||[]).map(f=>{const file=prepared.get(mediaKey(result.source_url||result.webpage_url||url,f.format_id,kind));return file&&file.until>clock()?{...f,filesize:file.bytes,filesize_approx:undefined,prepared:true}:f});return result}
 function acquireExtraction(){return new Promise((resolve,reject)=>{const enter=()=>{if(extracting<metadataConcurrency){extracting++;let released=false;resolve(()=>{if(released)return;released=true;extracting--;metadataQueue.shift()?.()})}else if(metadataQueue.length<16)metadataQueue.push(enter);else reject(new Error('The format service is busy. Please try again.'))};enter()})}
 async function retainSnapshot(e){return mutate(async()=>{
  const incoming=e.bytes;
  let bytes=[...snapshots.values()].reduce((n,e)=>n+e.bytes,0);
  for(const [id,e]of snapshots){if(snapshots.size<snapshotEntries&&bytes+incoming<=snapshotBytes)break;if(e.users)continue;snapshots.delete(id);for(const alias of e.aliases)if(aliases.get(alias)===id)aliases.delete(alias);bytes-=e.bytes;await remove(e.dir)}
  if(snapshots.size>=snapshotEntries||bytes+incoming>snapshotBytes)return false;
  snapshots.set(e.id,e);for(const alias of e.aliases)aliases.set(alias,e.id);return true;
 })}
 async function extractMetadata(url){
  if(closed)throw new Error('Media service is closing.');await prune();const key=canonical(url);const hit=snapshotFor(url);if(hit)return {...currentSizes(hit.data,url),cached:true,extraction_id:hit.id,extraction_expires_at:hit.until};
  if(metadataPending.has(key))return metadataPending.get(key).then(data=>({...currentSizes(data,url),cached:true}));
  const operation=(async()=>{const began=clock();const release=await acquireExtraction();let dir,retained=false;
   try{dir=await directory('info-');const infoFile=path.join(dir,'source.info.json');const data={...await validateFastFormats(await engine([url,'--info-cache',infoFile],90000)),source_url:url};const stat=await fs.stat(infoFile);if(!stat.isFile())throw new Error('Provider metadata snapshot was not written.');if(stat.size>snapshotBytes)return {...structuredClone(data),cached:false,timings:{metadata_ms:clock()-began}};
    const e={id:randomUUID(),dir,infoFile,bytes:stat.size,until:clock()+snapshotTtlMs,users:0,aliases:new Set([key]),data:structuredClone(data)};if(data.webpage_url){const original=new URL(url),provider=new URL(data.webpage_url);if(!original.hash||original.hash===provider.hash)e.aliases.add(canonical(data.webpage_url))}
    retained=await retainSnapshot(e);
    return {...currentSizes(data,url),cached:false,...(retained?{extraction_id:e.id,extraction_expires_at:e.until}:{}),timings:{metadata_ms:clock()-began}};
   }finally{try{if(dir&&!retained)await remove(dir)}finally{release()}}
  })();metadataPending.set(key,operation);try{return await operation}finally{if(metadataPending.get(key)===operation)metadataPending.delete(key)}
 }
 function acquire(aborted){return new Promise((resolve,reject)=>{const enter=()=>{if(aborted()){reject(new Error('Transfer cancelled.'));queue.shift()?.();return}if(active<concurrency){active++;let released=false;resolve(()=>{if(released)return;released=true;active--;queue.shift()?.()})}else if(queue.length<8)queue.push(enter);else reject(new Error('The media service is busy. Please try again.'))};enter()})}
 async function retainPrepared(key,e){return mutate(async()=>{
  let bytes=[...prepared.values()].reduce((n,item)=>n+item.bytes,0);
  for(const [oldKey,item]of prepared){if(prepared.size<preparedEntries&&bytes+e.bytes<=preparedBytes)break;if(busy(item))continue;prepared.delete(oldKey);item.cached=false;bytes-=item.bytes;await cleanupPrepared(item)}
  if(e.bytes<=preparedBytes&&prepared.size<preparedEntries&&bytes+e.bytes<=preparedBytes){e.cached=true;prepared.set(key,e)}
 })}
 async function reserveOutput(){return mutate(async()=>{
  const used=()=>[...outputs].reduce((n,e)=>n+e.bytes,0)+reservedBytes;
  for(const [key,e]of prepared){if(used()+maxMediaBytes<=maxOutputBytes)break;if(busy(e))continue;prepared.delete(key);e.cached=false;await cleanupPrepared(e)}
  if(used()+maxMediaBytes>maxOutputBytes){const error=new Error('Large media transfers are still active. Try again after one finishes, or use the on-device engine.');error.code='service_busy';throw error}
  reservedBytes+=maxMediaBytes;return maxMediaBytes;
 })}
 async function leasePrepared({url,formatId,type,extractionId},aborted,setDetach){
  if(closed)throw new Error('Media service is closing.');await prune();const info=snapshotFor(url,extractionId);const source=info?.data.source_url||url;const kind=type==='video'?'video':'mp3';const key=mediaKey(source,formatId,kind);
  const hit=prepared.get(key);if(hit&&hit.until>clock()){hit.readers++;return {entry:hit,hit:true,release:async()=>{hit.readers--;await cleanupPrepared(hit)}}}
  let job=preparing.get(key);
  if(!job||job.cancelled){job={waiters:new Set(),cancel:()=>{},cancelled:false,finished:false};
   job.promise=Promise.resolve().then(async()=>{let release,dir,snapshot,reservation=0;
    try{release=await acquire(()=>job.cancelled);reservation=await reserveOutput();dir=await directory('media-');snapshot=snapshotFor(url,extractionId);if(snapshot)snapshot.users++;
     const args=[url,'--download','--format',formatId||'best','--kind',kind,'--output-dir',dir];if(snapshot)args.push('--info-json',snapshot.infoFile);
     const started=clock();const data=await engine(args,(Number(process.env.PREPARE_TIMEOUT_SECONDS)||900)*1000,fn=>{job.cancel=fn;if(job.cancelled)fn()});if(job.cancelled)throw new Error('Transfer cancelled.');
     const file=path.resolve(dir,data.path);if(path.dirname(file)!==path.resolve(dir)||!['video/mp4','audio/mpeg'].includes(data.mime))throw new Error('Invalid prepared media result.');const stat=await fs.stat(file);if(!stat.isFile()||!stat.size||stat.size!==data.size||stat.size>maxMediaBytes)throw new Error('Prepared media length failed validation.');
     const e={id:randomUUID(),dir,file,data,bytes:stat.size,until:clock()+preparedTtlMs,readers:0,cached:false,job,prepareMs:clock()-started};job.entry=e;await mutate(()=>{reservedBytes-=reservation;reservation=0;outputs.add(e)});dir=null;await retainPrepared(key,e);return e;
    }finally{job.finished=true;try{if(snapshot){snapshot.users--;if(snapshot.expired&&!snapshot.users)await remove(snapshot.dir)}if(dir)await remove(dir);if(job.entry)await cleanupPrepared(job.entry)}finally{if(reservation)await mutate(()=>{reservedBytes-=reservation});release?.();if(preparing.get(key)===job)preparing.delete(key)}}
   });preparing.set(key,job);
  }
  const waiter={};job.waiters.add(waiter);let detached=false;
  const detach=()=>{if(detached)return;detached=true;job.waiters.delete(waiter);if(!job.finished&&!job.waiters.size){job.cancelled=true;job.cancel()}if(job.entry)void cleanupPrepared(job.entry).catch(()=>{})};
  setDetach(detach);if(aborted())detach();
  try{const entry=await job.promise;if(aborted())throw new Error('Transfer cancelled.');entry.readers++;return {entry,hit:false,release:async()=>{entry.readers--;await cleanupPrepared(entry)}}}finally{detach()}
 }
 async function streamDirectDownload({url,formatId,type,filename,extractionId,req,res}){
  if(closed)throw new Error('Media service is closing.');streams++;
  let aborted=false,detach=()=>{},lease;const abort=()=>{if(!res.writableFinished){aborted=true;detach()}};req.once('aborted',abort);res.once('close',abort);
  try{lease=await leasePrepared({url,formatId,type,extractionId},()=>aborted,fn=>{detach=fn});if(aborted)return;const e=lease.entry;
   res.setHeader('Content-Type',e.data.mime);res.setHeader('Cache-Control','no-store');res.setHeader('ETag','"clip-'+e.id+'"');res.setHeader('X-Vurix-Verified','video-audio-v4');res.setHeader('X-Clip-Sevan-Prepared',lease.hit?'cache':'fresh');res.setHeader('Server-Timing','prepare;dur='+(lease.hit?0:e.prepareMs));res.setHeader('Access-Control-Expose-Headers','Content-Length,Content-Disposition,ETag,Last-Modified,X-Vurix-Verified,X-Clip-Sevan-Prepared,Server-Timing');
   // First-time preparation remains fully validated before success. Immutable cached files safely support Range.
   await new Promise((resolve,reject)=>res.download(e.file,filename,{acceptRanges:e.cached,cacheControl:false,lastModified:true},error=>error?reject(error):resolve()));
  }finally{try{req.removeListener('aborted',abort);res.removeListener('close',abort);detach();await lease?.release()}finally{streams--;if(!streams)for(const notify of idle.splice(0))notify()}}
 }
 async function streamFastDownload({url,formatId,extractionId,filename,req,res}){
  if(closed)throw new Error('Media service is closing.');
  // The original source and opaque handle both have to match. No client-supplied target is used.
  const snapshot=extractionId?snapshotFor(url,extractionId):null;
  const format=snapshot?.data.video_formats?.find(item=>item.format_id===formatId&&item.fast_download_url);
  if(!snapshot||!format){const error=new Error('This quick connection expired. Use the verified download route.');error.code='relay_expired';throw error}
  snapshot.users++;streams++;
  try{await fastRelay.relay({format,filename,req,res,maxBytes:maxMediaBytes})}
  finally{try{snapshot.users--;if(snapshot.expired&&!snapshot.users)await remove(snapshot.dir)}finally{streams--;if(!streams)for(const notify of idle.splice(0))notify()}}
 }
 const timer=cleanupIntervalMs>0?setInterval(()=>{void prune().catch(()=>{})},cleanupIntervalMs):null;timer?.unref();
 async function close(){closed=true;fastRelay.close();if(timer)clearInterval(timer);for(const job of preparing.values()){job.cancelled=true;job.cancel()}await Promise.allSettled([...preparing.values()].map(job=>job.promise));await Promise.allSettled([...metadataPending.values()]);if(streams)await new Promise(resolve=>idle.push(resolve));await cacheMutation;for(const e of snapshots.values()){e.expired=true;if(!e.users)await remove(e.dir)}snapshots.clear();aliases.clear();for(const e of prepared.values()){e.cached=false;await cleanupPrepared(e)}prepared.clear();if(rootPromise){const parent=await rootPromise;if(path.dirname(parent)!==path.resolve(tempBase)||!path.basename(parent).startsWith('clip-sevan-cache-'))throw new Error('Invalid cache root.');await fs.rm(parent,{recursive:true,force:true})}outputs.clear();reservedBytes=0}
 return {extractMetadata,streamDirectDownload,streamFastDownload,close};
}
const service=createMediaService();
module.exports={...service,createMediaService,validateUrl,publicAddress,safeError};
