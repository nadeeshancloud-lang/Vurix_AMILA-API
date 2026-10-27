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
class ActualContainerTests(unittest.TestCase):
 def test_transcode_is_real_h264_aac_and_faststart(self):
  import imageio_ffmpeg
  binary=imageio_ffmpeg.get_ffmpeg_exe()
  with tempfile.TemporaryDirectory(prefix='vurix-test-',dir=os.environ.get('VURIX_TEST_TMP')) as temp:
   root=Path(temp);assert root.resolve().parent==Path(os.environ.get('VURIX_TEST_TMP',tempfile.gettempdir())).resolve();source=root/'fixture.webm'
   subprocess.run([binary,'-v','error','-y','-f','lavfi','-i','testsrc2=size=160x90:rate=10','-f','lavfi','-i','sine=frequency=440:sample_rate=44100','-t','1','-c:v','libvpx-vp9','-c:a','libopus',str(source)],check=True,timeout=45)
   info={'formats':[{'format_id':'v','vcodec':'vp9','acodec':'opus','height':90,'width':160,'url':'https://example.com/v'}]}
   class FakeYdl:
    def __init__(self,options):self.params=options
    def __enter__(self):return self
    def __exit__(self,*args):pass
    def extract_info(self,*args,**kwargs):return info
    def process_ie_result(self,*args,**kwargs):shutil.copy2(source,Path(self.params['outtmpl'].replace('%(ext)s','webm')))
   def real_probe(path):
    p=subprocess.run([binary,'-hide_banner','-i',str(path)],capture_output=True,text=True,timeout=20)
    streams=[]
    for kind in ['Video','Audio']:
     match=re.search(kind+r': ([^ ,]+)',p.stderr)
     if match:streams.append({'codec_type':kind.lower(),'codec_name':match.group(1),'pix_fmt':'yuv420p'})
    return streams
   with patch.object(engine.yt_dlp,'YoutubeDL',FakeYdl),patch.object(engine,'probe',real_probe),patch.dict(os.environ,{'FFMPEG_BIN':binary}):
    result=engine.prepare('https://example.com/video','v','video',root/'job')
   output=root/'job'/result['path'];self.assertEqual('h264',result['video_codec']);self.assertEqual('aac',result['audio_codec'])
   decoded=subprocess.run([binary,'-v','error','-i',str(output),'-f','null','-'],capture_output=True,timeout=30);self.assertEqual(0,decoded.returncode,decoded.stderr)
   blob=output.read_bytes();self.assertIn(b'ftyp',blob[:64]);self.assertLess(blob.index(b'moov'),blob.index(b'mdat'))
if __name__=='__main__':unittest.main(verbosity=2)
