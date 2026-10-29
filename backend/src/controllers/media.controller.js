const {extractMetadata,streamDirectDownload,streamFastDownload,validateUrl,safeError}=require('../services/extraction.service');
const sanitizeFilename=(title,ext)=>String(title||'Clip_Sevan_media').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,120)+'.'+ext;
const failure=(res,error)=>{if(res.headersSent||res.destroyed)return;const verification=error.code==='provider_verification_required';const range=(error.status||error.statusCode)===416;const contentRange=error.headers?.['Content-Range']||error.headers?.['content-range'];res.setHeader('Content-Type','application/json; charset=utf-8');for(const name of ['ETag','Content-Disposition','Content-Length','Content-Range','Accept-Ranges','Last-Modified','X-Clip-Sevan-Delivery'])res.removeHeader(name);if(range&&/^bytes \*\/\d+$/.test(contentRange||''))res.setHeader('Content-Range',contentRange);res.status(range?416:error.code==='relay_expired'?410:verification?422:error.code==='service_busy'?503:502).json({success:false,code:range?'range_not_satisfiable':error.code||'extraction_error',error:safeError(error.message)})};
function downloadLinks(data,base,url){
  for(const [key,type] of [['video_formats','video'],['audio_formats','mp3']])data[key]=(data[key]||[]).map(f=>{const params=new URLSearchParams({url:data.source_url||data.webpage_url||url,format_id:f.format_id,type,title:data.title});if(data.extraction_id)params.set('extraction_id',data.extraction_id);const result={...f,download_url:base+'/api/v1/stream?'+params.toString()};if(type==='video'&&f.fast_download_url&&data.extraction_id){result.fast_download_url=base+'/api/v1/fast-stream?'+params.toString();result.fast_download_headers={}}else{delete result.fast_download_url;delete result.fast_download_headers;delete result.fast_filesize}return result});
 return data;
}
async function handleExtract(req,res){
 let url;try{url=await validateUrl(req.body?.url)}catch{return res.status(400).json({success:false,error:'Provide a valid public HTTP/HTTPS video URL.'})}
 try{const data=await extractMetadata(url);const base=process.env.PUBLIC_BASE_URL||req.protocol+'://'+req.get('host');
  res.json(downloadLinks(data,base,url))
 }catch(error){failure(res,error)}
}
async function handleStream(req,res){
 let url;try{url=await validateUrl(req.query.url)}catch{return res.status(400).json({success:false,error:'Provide a valid public video URL.'})}
 const type=req.query.type==='video'?'video':'mp3';const formatId=typeof req.query.format_id==='string'?req.query.format_id:'best';if(formatId.length>200)return res.status(400).json({success:false,error:'Invalid format ID.'});
 const extractionId=typeof req.query.extraction_id==='string'&&req.query.extraction_id.length<=64?req.query.extraction_id:undefined;
 try{await streamDirectDownload({url,formatId,type,extractionId,filename:sanitizeFilename(req.query.title,type==='video'?'mp4':'mp3'),req,res})}catch(error){failure(res,error)}
}
async function handleFastStream(req,res){
 let url;try{url=await validateUrl(req.query.url)}catch{return res.status(400).json({success:false,error:'Provide a valid public video URL.'})}
 const formatId=typeof req.query.format_id==='string'?req.query.format_id:'';const extractionId=typeof req.query.extraction_id==='string'&&req.query.extraction_id.length<=64?req.query.extraction_id:'';
 if(!formatId||formatId.length>200||req.query.type!=='video')return res.status(400).json({success:false,error:'Select an available quick MP4 format.'});
 try{await streamFastDownload({url,formatId,extractionId,filename:sanitizeFilename(req.query.title,'mp4'),req,res})}catch(error){failure(res,error)}
}
module.exports={handleExtract,handleStream,handleFastStream,sanitizeFilename,failure,downloadLinks};
