import importlib.util,unittest,tempfile,os,subprocess,shutil,json,re,struct
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location('engine',Path(__file__).resolve().parents[1]/'extractor.py');engine=importlib.util.module_from_spec(spec);spec.loader.exec_module(engine)
class PlanningTests(unittest.TestCase):
 def test_audio_only_never_in_video_list(self):
  data=engine.metadata({'title':'Audio','formats':[{'format_id':'a','vcodec':'none','acodec':'aac','ext':'mp4','url':'https://example.com/a'}]},'https://example.com/watch')
  self.assertEqual([],data['video_formats']);self.assertEqual(['mp3','mp3'],[f['ext'] for f in data['audio_formats']])
 def test_video_plus_audio_uses_real_ids(self):
  info={'formats':[{'format_id':'v','vcodec':'avc1','acodec':'none','height':720,'width':1280,'url':'https://example.com/v'},{'format_id':'a','vcodec':'none','acodec':'mp4a','abr':128,'url':'https://example.com/a'}]}
  self.assertEqual('v+a',engine.selector(info,'v','video'))
  with self.assertRaises(ValueError):engine.selector(info,'a','video')
 def test_never_falls_back_from_audio_url_to_fake_video(self):
  data=engine.metadata({'title':'Audio only','url':'https://example.com/a','ext':'mp4','vcodec':'none','acodec':'aac'},'https://example.com/watch');self.assertFalse(data['video_formats'])
 def test_h264_is_preferred_at_same_resolution(self):
  formats=[{'format_id':'hevc','vcodec':'hevc','acodec':'aac','height':720,'width':1280,'url':'https://example.com/h'},{'format_id':'avc','vcodec':'avc1','acodec':'aac','height':720,'width':1280,'url':'https://example.com/a'}]
  self.assertEqual('avc',engine.metadata({'formats':formats},'https://example.com/watch')['video_formats'][0]['format_id'])
 def test_js_runtime_and_correct_headers_enabled(self):
  options=engine.options();self.assertIn('node',options['js_runtimes']);self.assertIn('User-Agent',options['http_headers']);self.assertNotIn(' http_headers',options);self.assertNotIn('nocheckcertificate',options)
 def test_sizes_are_estimates_and_drm_is_excluded(self):
  data=engine.metadata({'duration':10,'formats':[{'format_id':'locked','vcodec':'avc1','acodec':'aac','has_drm':True,'url':'https://example.com/v'}]},'https://example.com/watch');self.assertFalse(data['video_formats']);self.assertFalse(data['audio_formats'])
 def test_copyable_video_size_is_marked_approximate_and_transcode_size_is_unknown(self):
  formats=[{'format_id':'v','vcodec':'avc1','acodec':'mp4a','width':1280,'height':720,'filesize':987654,'url':'https://example.com/v'}]
  data=engine.metadata({'duration':10,'formats':formats},'https://example.com/watch');self.assertIsNone(data['video_formats'][0]['filesize']);self.assertEqual(987654,data['video_formats'][0]['filesize_approx'])
  formats[0]['vcodec']='hevc';self.assertIsNone(engine.metadata({'duration':10,'formats':formats},'https://example.com/watch')['video_formats'][0]['filesize_approx'])
 def test_selected_quality_replaces_the_real_yt_dlp_compiled_selector(self):
  formats=[{'format_id':f,'vcodec':'avc1','acodec':'aac','ext':'mp4','height':h,'url':'https://example.com/'+f} for f,h in [('18',360),('22',720)]]
  with engine.yt_dlp.YoutubeDL({'quiet':True,'format':'22'}) as ydl:
   engine.configure_format(ydl,{'formats':formats},'18','video')
   chosen=ydl._select_formats(formats,ydl.format_selector)
   self.assertEqual('18',chosen[0]['format_id'])
class ActualContainerTests(unittest.TestCase):
 def conversion(self,snapshot=False,compatible=False,expired=False):
  import imageio_ffmpeg
  binary=imageio_ffmpeg.get_ffmpeg_exe();counts={'extract':0,'download':0,'selectors':[]}
  with tempfile.TemporaryDirectory(prefix='clip-test-',dir=os.environ.get('VURIX_TEST_TMP')) as temp:
   root=Path(temp);assert root.resolve().parent==Path(os.environ.get('VURIX_TEST_TMP',tempfile.gettempdir())).resolve();ext='mp4' if compatible else 'webm';source=root/('fixture.'+ext)
   subprocess.run([binary,'-v','error','-y','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1','-c:v','libx264' if compatible else 'libvpx-vp9','-pix_fmt','yuv420p','-c:a','aac' if compatible else 'libopus',str(source)],check=True,timeout=45)
   info={'formats':[{'format_id':'v','vcodec':'avc1' if compatible else 'vp9','acodec':'aac' if compatible else 'opus','height':90,'width':160,'url':'https://example.com/v'}]}
   previous=json.loads(json.dumps(info));fresh=json.loads(json.dumps(info))
   if expired:fresh['formats'][0]['format_id']='fresh-v'
   snapshot_file=root/'snapshot.json';snapshot_file.write_text(json.dumps(previous))
   class FakeYdl:
    def __init__(self,options):self.params=options
    def build_format_selector(self,value):counts['selectors'].append(value);return value
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def extract_info(self,*args,**kwargs):counts['extract']+=1;return fresh
    def process_ie_result(self,*args,**kwargs):
     counts['download']+=1
     if expired and counts['download']==1:raise engine.yt_dlp.utils.DownloadError('HTTP 403: signed URL expired')
     shutil.copy2(source,Path(self.params['outtmpl'].replace('%(ext)s',ext)))
   def real_probe(path):
    p=subprocess.run([binary,'-hide_banner','-i',str(path)],capture_output=True,text=True,timeout=20);streams=[]
    for kind in ['Video','Audio']:
     match=re.search(kind+r': ([^ ,]+)',p.stderr)
     if match:streams.append({'codec_type':kind.lower(),'codec_name':match.group(1),'pix_fmt':'yuv420p','width':160,'height':90})
    return streams
   with patch.object(engine.yt_dlp,'YoutubeDL',FakeYdl),patch.object(engine,'probe',real_probe),patch.dict(os.environ,{'FFMPEG_BIN':binary}):
    result=engine.prepare('https://example.com/video','v','video',root/'job',snapshot_file if snapshot else None)
   output=root/'job'/result['path'];self.assertEqual('h264',result['video_codec']);self.assertEqual('aac',result['audio_codec']);self.assertFalse(list((root/'job').glob('source.*')))
   decoded=subprocess.run([binary,'-v','error','-i',str(output),'-f','null','-'],capture_output=True,timeout=30);self.assertEqual(0,decoded.returncode,decoded.stderr)
   blob=output.read_bytes();self.assertIn(b'ftyp',blob[:64]);self.assertLess(blob.index(b'moov'),blob.index(b'mdat'))
   return result,counts
 def test_transcode_is_real_h264_aac_and_faststart(self):
  result,counts=self.conversion();self.assertFalse(result['video_copied']);self.assertEqual(1,counts['extract'])
 def test_snapshot_skips_provider_extraction_before_real_conversion(self):
  result,counts=self.conversion(snapshot=True);self.assertTrue(result['reused_extraction']);self.assertEqual(0,counts['extract']);self.assertEqual(1,counts['download'])
 def test_expired_snapshot_refreshes_once_and_preserves_resolution(self):
  result,counts=self.conversion(snapshot=True,expired=True);self.assertFalse(result['reused_extraction']);self.assertEqual(1,counts['extract']);self.assertEqual(2,counts['download']);self.assertEqual('fresh-v',counts['selectors'][-1])
 def test_compatible_h264_and_aac_are_copied_and_fully_decodable(self):
  result,counts=self.conversion(snapshot=True,compatible=True);self.assertTrue(result['video_copied']);self.assertTrue(result['audio_copied']);self.assertEqual(0,counts['extract'])
if __name__=='__main__':unittest.main(verbosity=2)
