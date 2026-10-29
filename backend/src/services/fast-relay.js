const https=require('node:https');
const dns=require('node:dns/promises');
const net=require('node:net');
const {Transform}=require('node:stream');
const {pipeline}=require('node:stream/promises');
const {publicAddress}=require('./provider-engine');

const error=(message,status=502,code='relay_unavailable')=>Object.assign(new Error(message),{status,code});
const safeHeader=value=>typeof value==='string'&&value.length<=512&&/^[\x20-\x7e]*$/.test(value)?value:undefined;
const length=value=>typeof value==='string'&&/^\d+$/.test(value)&&Number.isSafeInteger(Number(value))?Number(value):null;
function abortable(operation,signal){
 if(signal.aborted)return Promise.reject(signal.reason);
 return new Promise((resolve,reject)=>{const stop=()=>reject(signal.reason);signal.addEventListener('abort',stop,{once:true});Promise.resolve(operation).then(resolve,reject).finally(()=>signal.removeEventListener('abort',stop))});
}

/** Streams only a server-selected progressive MP4; callers cannot supply a relay target. */
function createFastRelay({lookup=dns.lookup,request=https.request,maxConcurrent=4,headerTimeoutMs=12000,idleTimeoutMs=30000,totalTimeoutMs=900000}={}){
 const running=new Set();let closed=false;
 async function open(target,headers,signal){
  const url=new URL(target);const hostname=url.hostname.replace(/^\[|\]$/g,'');
  if(url.protocol!=='https:'||url.username||url.password||target.length>8192)throw error('A secure public media source is required.',502,'relay_source_invalid');
  let addresses;try{addresses=net.isIP(hostname)?[{address:hostname,family:net.isIP(hostname)}]:await abortable(lookup(hostname,{all:true}),signal)}catch(failure){if(signal.aborted)throw signal.reason;throw error('The quick media host could not be reached.')}
  if(!addresses.length||addresses.some(item=>!publicAddress(item.address)))throw error('The media host is not public.',502,'relay_source_invalid');
  const selected=addresses[0];
  return new Promise((resolve,reject)=>{
   if(signal.aborted){reject(signal.reason);return}
   const pinnedLookup=(_host,options,callback)=>options?.all?callback(null,[selected]):callback(null,selected.address,selected.family);
   const upstream=request(url,{headers,lookup:pinnedLookup,signal},resolve);
   upstream.once('error',failure=>reject(signal.aborted?signal.reason:failure.code?.startsWith('relay_')?failure:error('The quick media connection could not be opened.')));upstream.setTimeout(idleTimeoutMs,()=>upstream.destroy(error('The media source stopped responding.')));upstream.end();
  });
 }
 async function relay({format,req,res,filename,maxBytes}){
  if(closed)throw error('The media relay is closing.',503,'service_busy');
  if(running.size>=maxConcurrent)throw error('The media relay is busy. Try again shortly.',503,'service_busy');
  if(!format?.fast_download_url||format.ext!=='mp4'||format.needs_merge||!String(format.vcodec).startsWith('avc')||!String(format.acodec).startsWith('mp4a'))throw error('Use the verified download route for this format.',410,'relay_expired');
  if(Number.isSafeInteger(format.fast_filesize)&&format.fast_filesize>maxBytes)throw error('This media exceeds the relay file-size limit.',502,'relay_limit');
  const controller=new AbortController();running.add(controller);const signal=controller.signal;
  const abort=()=>{if(!res.writableFinished)controller.abort(error('Transfer cancelled.',502,'relay_cancelled'))};req.once('aborted',abort);res.once('close',abort);
  if(req.aborted||res.destroyed)abort();
  const overall=setTimeout(()=>controller.abort(error('The media transfer took too long.')),totalTimeoutMs);let headerTimer,upstream;
  try{
   const headers={'Accept-Encoding':'identity'};const allowed=new Set(['user-agent','referer','origin','accept','accept-language']);
   for(const [name,value]of Object.entries(format.fast_download_headers||{}))if(allowed.has(name.toLowerCase())&&typeof value==='string'&&value.length<=4096&&!/[\r\n\x00]/.test(value))headers[name]=value;
   const range=req.headers?.range;
   if(range!==undefined){const match=typeof range==='string'&&range.length<=100?/^bytes=(\d+)-(\d*)$/.exec(range):null;if(!match||!Number.isSafeInteger(Number(match[1]))||match[2]&&(!Number.isSafeInteger(Number(match[2]))||Number(match[2])<Number(match[1])))throw error('Use one valid byte range.',416,'range_not_satisfiable');headers.Range=range;const condition=safeHeader(req.headers?.['if-range']);if(condition)headers['If-Range']=condition}
   let target=format.fast_download_url;
   headerTimer=setTimeout(()=>controller.abort(error('The media source took too long to connect.')),headerTimeoutMs);
   for(let redirects=0;;redirects++){
    upstream=await open(target,headers,signal);
    if(![301,302,303,307,308].includes(upstream.statusCode))break;
    const location=upstream.headers.location;upstream.destroy();upstream=null;
    if(redirects>=5||!location)throw error('The source redirected too many times.');target=new URL(location,target).toString();
   }
   clearTimeout(headerTimer);
   const status=upstream.statusCode;
   if(status===416){const failure=error('The requested range is outside this file.',416,'range_not_satisfiable');const contentRange=safeHeader(upstream.headers['content-range']);if(/^bytes \*\/\d+$/.test(contentRange||''))failure.headers={'Content-Range':contentRange};throw failure}
   if(status!==200&&status!==206)throw error('The source refused the quick connection. Use the verified download route.');
   const mime=String(upstream.headers['content-type']||'').split(';')[0].trim().toLowerCase();
   if(!['video/mp4','application/octet-stream'].includes(mime)||upstream.headers['content-encoding']&&!/^identity$/i.test(upstream.headers['content-encoding']))throw error('The source did not return a progressive MP4 file.');
   const declared=length(upstream.headers['content-length']);if(upstream.headers['content-length']!==undefined&&declared===null)throw error('The source returned an invalid file length.',502,'relay_source_invalid');
   if(declared!==null&&declared>maxBytes)throw error('This media exceeds the relay file-size limit.',502,'relay_limit');
   let contentRange;
   if(status===206){contentRange=safeHeader(upstream.headers['content-range']);const match=/^bytes (\d+)-(\d+)\/(\d+)$/.exec(contentRange||'');if(!range||!match)throw error('The source returned an invalid byte range.',502,'relay_source_invalid');const [start,end,total]=match.slice(1).map(Number);if(![start,end,total].every(Number.isSafeInteger)||end<start||end>=total||declared!==null&&declared!==end-start+1)throw error('The source byte range failed validation.',502,'relay_source_invalid');if(total>maxBytes)throw error('This media exceeds the relay file-size limit.',502,'relay_limit');const requested=/^bytes=(\d+)-(\d*)$/.exec(range);if(start!==Number(requested[1])||requested[2]&&end>Number(requested[2]))throw error('The source returned the wrong byte range.',502,'relay_source_invalid')}
   let sent=0;const cap=new Transform({transform(chunk,_encoding,callback){sent+=chunk.length;if(sent>maxBytes)callback(error('The media exceeded the relay file-size limit.',502,'relay_limit'));else callback(null,chunk)},flush(callback){callback(declared!==null&&sent!==declared?error('The media transfer ended early.',502,'relay_source_invalid'):undefined)}});
   res.statusCode=status;res.setHeader('Content-Type','video/mp4');res.setHeader('Cache-Control','no-store');res.setHeader('X-Clip-Sevan-Delivery','progressive-relay');res.setHeader('Content-Disposition',"attachment; filename=\"Clip-Sevan-video.mp4\"; filename*=UTF-8''"+encodeURIComponent(filename));
   if(declared!==null)res.setHeader('Content-Length',String(declared));if(contentRange)res.setHeader('Content-Range',contentRange);
   const etag=safeHeader(upstream.headers.etag),modified=safeHeader(upstream.headers['last-modified']);
   const strongTag=etag&&/^"[\x21\x23-\x7e]*"$/.test(etag);const usableModified=modified&&/^[A-Za-z]{3}, \d{2} [A-Za-z]{3} \d{4} \d{2}:\d{2}:\d{2} GMT$/.test(modified)&&Number.isFinite(Date.parse(modified));
   if(etag)res.setHeader('ETag',etag);if(usableModified)res.setHeader('Last-Modified',modified);
   // The app may resume only when it can verify that the upstream identity stayed the same.
   if((strongTag||usableModified)&&(upstream.headers['accept-ranges']==='bytes'||status===206))res.setHeader('Accept-Ranges','bytes');
   res.setHeader('Access-Control-Expose-Headers','Content-Length,Content-Range,Accept-Ranges,Content-Disposition,ETag,Last-Modified,X-Clip-Sevan-Delivery');
   await pipeline(upstream,cap,res,{signal});
  }finally{clearTimeout(headerTimer);clearTimeout(overall);upstream?.destroy();req.removeListener('aborted',abort);res.removeListener('close',abort);running.delete(controller)}
 }
 function close(){closed=true;for(const controller of running)controller.abort(error('The media relay is closing.',503,'relay_closing'))}
 return {relay,close};
}
module.exports={createFastRelay};
