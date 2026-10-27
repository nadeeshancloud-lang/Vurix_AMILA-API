const {extractMetadata,streamDirectDownload,validateUrl,safeError}=require('../services/extraction.service');
const sanitizeFilename=(title,ext)=>String(title||'VURIX_media').replace(/[\\/:*?"<>|\u0000-\u001f]/g,'_').slice(0,120)+'.'+ext;
const failure=(res,error)=>{if(res.headersSent||res.destroyed)return;const verification=error.code==='provider_verification_required';res.status(verification?422:502).json({success:false,code:error.code||'extraction_error',error:safeError(error.message)})};
async function handleExtract(req,res){
 let url;try{url=await validateUrl(req.body?.url)}catch{return res.status(400).json({success:false,error:'Provide a valid public HTTP/HTTPS video URL.'})}
 try{const data=await extractMetadata(url);const base=process.env.PUBLIC_BASE_URL||req.protocol+'://'+req.get('host');
  for(const [key,type] of [['video_formats','video'],['audio_formats','mp3']])data[key]=(data[key]||[]).map(f=>{const params=new URLSearchParams({url:data.webpage_url||url,format_id:f.format_id,type,title:data.title});return {...f,download_url:base+'/api/v1/stream?'+params.toString()}});
  res.json(data)
 }catch(error){failure(res,error)}
}
async function handleStream(req,res){
 let url;try{url=await validateUrl(req.query.url)}catch{return res.status(400).json({success:false,error:'Provide a valid public video URL.'})}
 const type=req.query.type==='video'?'video':'mp3';const formatId=typeof req.query.format_id==='string'?req.query.format_id:'best';if(formatId.length>200)return res.status(400).json({success:false,error:'Invalid format ID.'});
 try{await streamDirectDownload({url,formatId,type,filename:sanitizeFilename(req.query.title,type==='video'?'mp4':'mp3'),req,res})}catch(error){failure(res,error)}
}
module.exports={handleExtract,handleStream,sanitizeFilename};
