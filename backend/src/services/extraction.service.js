const {spawn}=require('node:child_process');
const path=require('node:path');
const fs=require('node:fs/promises');
const os=require('node:os');
const dns=require('node:dns/promises');
const net=require('node:net');
const script=path.resolve(__dirname,'../../../python_engine/extractor.py');
const cache=new Map();
let active=0;
const queue=[];
const concurrency=Math.max(1,Math.min(4,Number(process.env.MAX_CONCURRENT_DOWNLOADS)||1));
function publicAddress(address){
 if(net.isIP(address)===4){const p=address.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127)}
 const a=address.toLowerCase();if(a.startsWith('::ffff:'))return publicAddress(a.slice(7));return net.isIP(a)===6&&a!=='::'&&a!=='::1'&&!a.startsWith('fc')&&!a.startsWith('fd')&&!a.startsWith('fe8')&&!a.startsWith('fe9')&&!a.startsWith('fea')&&!a.startsWith('feb');
}
async function validateUrl(value,lookup=dns.lookup){
 if(typeof value!=='string'||value.length>8192)throw new Error('Provide a public video URL.');
 const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new Error('Provide a public HTTP/HTTPS video URL.');
 const hostname=u.hostname.replace(/^\[|\]$/g,'');const addresses=net.isIP(hostname)?[{address:hostname}]:await lookup(hostname,{all:true});
 if(!addresses.length||addresses.some(v=>!publicAddress(v.address)))throw new Error('Only public media hosts are accepted.');
 return u.toString();
}
function safeError(value){return String(value||'Could not prepare this media.').replace(/https?:\/\/\S+/g,'[link]').replace(/\u001b\[[;\d]*m/g,'').slice(0,800)}
function runEngine(args,timeoutMs,onCancel=()=>{}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.PYTHON_BIN||'python3',[script,...args],{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let stdout='',stderr='';let settled=false;
  const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL')}catch{}};onCancel(kill);
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result)};
  const timer=setTimeout(()=>{kill();finish(new Error('The provider took too long to prepare this media.'))},timeoutMs);
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>4*1024*1024){kill();finish(new Error('Extraction response was too large.'))}});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-16000)});
  child.on('error',error=>finish(new Error(safeError(error.message))));
  child.on('close',code=>{if(settled)return;try{const data=JSON.parse(stdout.trim());if(code!==0||!data.success){const error=new Error(safeError(data.error||stderr));error.code=data.code;finish(error)}else finish(null,data)}catch{finish(new Error(safeError(stderr||'The extraction process did not return valid metadata.')))}});
 });
}
async function extractMetadata(url){const item=cache.get(url);if(item&&item.until>Date.now())return {...item.data,cached:true};const data=await runEngine([url],90000);if(cache.size>=100)cache.delete(cache.keys().next().value);cache.set(url,{until:Date.now()+300000,data});return {...data,cached:false}}
function acquire(aborted){return new Promise((resolve,reject)=>{const enter=()=>{if(aborted())return reject(new Error('Transfer cancelled.'));if(active<concurrency){active++;let released=false;resolve(()=>{if(released)return;released=true;active--;queue.shift()?.()})}else if(queue.length<8)queue.push(enter);else reject(new Error('The media service is busy. Please try again.'))};enter()})}
async function streamDirectDownload({url,formatId,type,filename,req,res}){
 let aborted=false;let cancel=()=>{};let directory;let release;
 const abort=()=>{if(!res.writableFinished){aborted=true;cancel()}};
 req.once('aborted',abort);res.once('close',abort);
 try{
  release=await acquire(()=>aborted);directory=await fs.mkdtemp(path.join(os.tmpdir(),'vurix-media-'));
  const kind=type==='video'?'video':'mp3';const data=await runEngine([url,'--download','--format',formatId||'best','--kind',kind,'--output-dir',directory],(Number(process.env.PREPARE_TIMEOUT_SECONDS)||900)*1000,fn=>{cancel=fn;if(aborted)fn()});
  if(aborted)return;
  const file=path.resolve(directory,data.path);if(path.dirname(file)!==path.resolve(directory)||!['video/mp4','audio/mpeg'].includes(data.mime))throw new Error('Invalid prepared media result.');
  res.setHeader('Content-Type',data.mime);res.setHeader('Cache-Control','no-store');res.setHeader('X-Vurix-Verified','video-audio-v3');res.setHeader('Access-Control-Expose-Headers','Content-Length,Content-Disposition,X-Vurix-Verified');
  // Headers are sent only after muxing and ffprobe validation. No audio-only MP4 or raw concatenated DASH output.
  await new Promise((resolve,reject)=>res.download(file,filename,{acceptRanges:false,cacheControl:false,lastModified:false},error=>error?reject(error):resolve()));
 }finally{req.removeListener('aborted',abort);res.removeListener('close',abort);if(directory)await fs.rm(directory,{recursive:true,force:true});release?.()}
}
module.exports={extractMetadata,streamDirectDownload,validateUrl,publicAddress,safeError};
