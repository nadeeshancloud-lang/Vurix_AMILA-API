const {spawn}=require('node:child_process');
const path=require('node:path');
const dns=require('node:dns/promises');
const net=require('node:net');
const script=path.resolve(__dirname,'../../../python_engine/extractor.py');
function publicAddress(address){
 if(net.isIP(address)===4){const p=address.split('.').map(Number);return !(p[0]===0||p[0]===10||p[0]===127||p[0]>=224||p[0]===169&&p[1]===254||p[0]===172&&p[1]>=16&&p[1]<=31||p[0]===192&&p[1]===168||p[0]===100&&p[1]>=64&&p[1]<=127)}
 const a=address.toLowerCase();if(a.startsWith('::ffff:'))return publicAddress(a.slice(7));return net.isIP(a)===6&&a!=='::'&&a!=='::1'&&!a.startsWith('fc')&&!a.startsWith('fd')&&!a.startsWith('fe8')&&!a.startsWith('fe9')&&!a.startsWith('fea')&&!a.startsWith('feb')&&!a.startsWith('ff');
}
async function validateUrl(value,lookup=dns.lookup){
 if(typeof value!=='string'||value.length>8192)throw new Error('Provide a public video URL.');
 const u=new URL(value);if(!['https:','http:'].includes(u.protocol)||u.username||u.password)throw new Error('Provide a public HTTP/HTTPS video URL.');
 const hostname=u.hostname.replace(/^\[|\]$/g,'');const addresses=net.isIP(hostname)?[{address:hostname}]:await lookup(hostname,{all:true});
 if(!addresses.length||addresses.some(v=>!publicAddress(v.address)))throw new Error('Only public media hosts are accepted.');
 return u.toString();
}
function safeError(value){return String(value||'Could not prepare this media.').replace(/https?:\/\/\S+/g,'[link]').replace(/\u001b\[[;\d]*m/g,'').slice(0,800)}
/** Optional direct delivery is only published after a public HTTPS-host check. */
async function validateFastFormats(data,check=validateUrl){
 const result=structuredClone(data),hosts=new Map();
 const allowed=new Map([['user-agent','User-Agent'],['referer','Referer'],['origin','Origin'],['accept','Accept'],['accept-language','Accept-Language']]);
 await Promise.all((result.video_formats||[]).map(async format=>{
  const candidate=format.fast_download_url,headers=format.fast_download_headers,size=format.fast_filesize;
  delete format.fast_download_url;delete format.fast_download_headers;delete format.fast_filesize;
  try{
   if(typeof candidate!=='string'||candidate.length>8192||/[\r\n]/.test(candidate))return;
   const url=new URL(candidate);if(url.protocol!=='https:'||url.username||url.password)return;
   if(!hosts.has(url.origin)){
    if(hosts.size>=8)return;
    let timer;const checked=Promise.race([Promise.resolve().then(()=>check(url.origin)),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Direct host lookup timed out.')),1500)})]).finally(()=>clearTimeout(timer));
    hosts.set(url.origin,checked);
   }
   await hosts.get(url.origin);
   format.fast_download_url=url.toString();format.fast_download_headers={};
   if(headers&&typeof headers==='object'&&!Array.isArray(headers))for(const [name,value]of Object.entries(headers)){
    const key=allowed.get(name.toLowerCase());if(key&&typeof value==='string'&&value.length<=4096&&!/[\r\n]/.test(value))format.fast_download_headers[key]=value;
   }
   if(Number.isSafeInteger(size)&&size>0)format.fast_filesize=size;
  }catch{} // Keep the verified proxy route when a direct candidate cannot be used.
 }));
 // MP3 always needs the real conversion route; never expose an AAC URL as MP3.
 for(const format of result.audio_formats||[]){delete format.fast_download_url;delete format.fast_download_headers;delete format.fast_filesize}
 return result;
}
function runEngine(args,timeoutMs,onCancel=()=>{}){
 return new Promise((resolve,reject)=>{
  const child=spawn(process.env.PYTHON_BIN||'python3',[script,...args],{detached:process.platform!=='win32',stdio:['ignore','pipe','pipe']});let stdout='',stderr='';let settled=false;
  const kill=()=>{try{if(process.platform!=='win32'&&child.pid)process.kill(-child.pid,'SIGKILL');else child.kill('SIGKILL')}catch{}};onCancel(kill);
  const finish=(error,result)=>{if(settled)return;settled=true;clearTimeout(timer);if(error)reject(error);else resolve(result)};
  const timer=setTimeout(()=>{kill();finish(new Error('The provider took too long to prepare this media.'))},timeoutMs);
  child.stdout.on('data',chunk=>{stdout+=chunk.toString();if(stdout.length>4*1024*1024){kill();finish(new Error('Extraction response was too large.'))}});
  child.stderr.on('data',chunk=>{stderr=(stderr+chunk.toString()).slice(-16000)});
  child.on('error',error=>finish(new Error(safeError(error.message))));
  child.on('close',(code,signal)=>{if(settled)return;if(signal)return finish(new Error('The extraction worker was terminated ('+signal+'). Check the Cloud Run memory limit or use the on-device engine.'));try{const data=JSON.parse(stdout.trim());if(code!==0||!data.success){const error=new Error(safeError(data.error||stderr));error.code=data.code;finish(error)}else finish(null,data)}catch{finish(new Error(safeError(stderr||('The extraction process returned invalid metadata (exit '+code+', '+stdout.length+' output bytes).'))))}});
 });
}
module.exports={runEngine,validateUrl,publicAddress,safeError,validateFastFormats};
