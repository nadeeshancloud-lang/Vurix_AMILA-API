"""yt-dlp metadata and verified H.264/AAC or MP3 preparation for VURIX."""
import argparse
import json
import os
from pathlib import Path
import subprocess
import sys
import yt_dlp


def options():
    result = {'quiet': True, 'no_warnings': True, 'noplaylist': True,
              'socket_timeout': 20, 'retries': 1, 'extractor_retries': 1,
              'js_runtimes': {'node': {}},
              'http_headers': {'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36', 'Accept-Language': 'en-US,en;q=0.9'}}
    cookie = os.environ.get('YT_DLP_COOKIE_FILE')
    if cookie and Path(cookie).is_file():
        result['cookiefile'] = cookie
    return result


def is_video(f):
    return f.get('vcodec') not in (None, '', 'none', 'images') and not f.get('has_drm') and f.get('ext') != 'mhtml'


def is_audio(f):
    return f.get('acodec') not in (None, '', 'none') and not f.get('has_drm')


def height(f):
    w, h = f.get('width') or 0, f.get('height') or 0
    return min(w, h) if w and h else h


def h264(f):
    return str(f.get('vcodec', '')).startswith(('avc', 'h264'))


def metadata(info, url):
    if info.get('entries') is not None:
        info = next((item for item in info['entries'] if item), None)
        if info is None:
            raise ValueError('This collection contains no available video.')
    formats = info.get('formats') or ([info] if info.get('url') else [])
    by_height = {}
    for f in formats:
        if not is_video(f) or not f.get('url'):
            continue
        quality = min(height(f), 1080)
        score = (h264(f), is_audio(f), f.get('tbr') or 0)
        if quality not in by_height or score > by_height[quality][0]:
            by_height[quality] = score, f
    any_audio = any(is_audio(f) for f in formats)
    videos = []
    for quality, (_, f) in sorted(by_height.items(), reverse=True):
        videos.append({'format_id': f['format_id'], 'resolution': f'{quality}p · Compatible MP4' if quality else 'Original · Compatible MP4',
                       'ext': 'mp4', 'vcodec': 'avc1', 'acodec': 'mp4a' if any_audio else 'none',
                       'source_vcodec': f.get('vcodec'), 'source_acodec': f.get('acodec'),
                       'height': quality, 'has_audio': any_audio, 'needs_merge': not is_audio(f),
                       'filesize': None, 'fps': f.get('fps')})
    duration = info.get('duration') or 0
    audios = [{'format_id': f'mp3_{rate}', 'quality': f'MP3 {rate} kbps', 'ext': 'mp3', 'vcodec': 'none', 'acodec': 'mp3',
               'abr': rate, 'filesize_approx': int(duration * rate * 1000 / 8) if duration else None} for rate in (192, 128)] if any_audio else []
    return {'success': True, 'platform': info.get('extractor_key', 'Unknown'), 'id': info.get('id'),
            'title': info.get('title') or 'VURIX media', 'thumbnail': info.get('thumbnail'), 'duration': duration,
            'uploader': info.get('uploader') or info.get('channel'), 'webpage_url': info.get('webpage_url') or url,
            'video_formats': videos, 'audio_formats': audios, 'delivery': 'verified-file-v3'}


def probe(path):
    result = subprocess.run(['ffprobe', '-v', 'error', '-show_streams', '-of', 'json', str(path)], capture_output=True, text=True, timeout=30, check=True)
    return json.loads(result.stdout).get('streams', [])


def selector(info, format_id, kind):
    formats = info.get('formats') or [info]
    if kind != 'video':
        return 'bestaudio/best'
    videos = [f for f in formats if is_video(f) and f.get('url')]
    if not videos:
        raise ValueError('The source returned audio only; no video format is available.')
    if format_id in ('best', '', None):
        selected = max(videos, key=lambda f: (h264(f), height(f), is_audio(f), f.get('tbr') or 0))
    else:
        selected = next((f for f in videos if f.get('format_id') == format_id), None)
        if selected is None:
            raise ValueError('That video quality expired. Extract the link again.')
    chosen = selected['format_id']
    if not is_audio(selected):
        audios = [f for f in formats if not is_video(f) and is_audio(f)]
        if audios:
            best = max(audios, key=lambda f: (str(f.get('acodec', '')).startswith('mp4a'), f.get('abr') or f.get('tbr') or 0))
            chosen += '+' + best['format_id']
    return chosen


def prepare(url, format_id, kind, folder):
    folder = Path(folder).resolve()
    folder.mkdir(parents=True, exist_ok=True)
    cap = int(os.environ.get('MAX_MEDIA_BYTES', str(256 * 1024 * 1024)))
    def limit(progress):
        if (progress.get('downloaded_bytes') or 0) > cap:
            raise ValueError('This media exceeds this server instance size limit. Use the on-device engine.')
    opts = options() | {'outtmpl': str(folder / 'source.%(ext)s'), 'merge_output_format': 'mkv', 'max_filesize': cap, 'progress_hooks': [limit]}
    with yt_dlp.YoutubeDL(opts) as ydl:
        info = ydl.extract_info(url, download=False)
        if info.get('entries') is not None:
            info = next((entry for entry in info['entries'] if entry), None)
        if not info:
            raise ValueError('No media found.')
        ydl.params['format'] = selector(info, format_id, kind)
        ydl.process_ie_result(info, download=True)
    files = [p for p in folder.glob('source.*') if p.suffix not in ('.part', '.ytdl', '.json') and '.f' not in p.stem]
    if not files:
        # Some single-source format IDs contain f in the filename; require only the fixed output basename.
        files = [p for p in folder.glob('source.*') if p.suffix not in ('.part', '.ytdl', '.json')]
    if not files:
        raise ValueError('The extractor did not produce a complete file.')
    source = max(files, key=lambda p: p.stat().st_size)
    streams = probe(source)
    video = next((s for s in streams if s.get('codec_type') == 'video'), None)
    audio = next((s for s in streams if s.get('codec_type') == 'audio'), None)
    output = folder / ('ready.mp4' if kind == 'video' else 'ready.mp3')
    command = [os.environ.get('FFMPEG_BIN', 'ffmpeg'), '-nostdin', '-y', '-threads', '2', '-i', str(source)]
    if kind == 'video':
        if not video:
            raise ValueError('The downloaded data has no video track. It was not labelled as MP4.')
        compatible = video.get('codec_name') == 'h264' and video.get('pix_fmt') == 'yuv420p' and max(video.get('width', 0), video.get('height', 0)) <= 1920 and min(video.get('width', 0), video.get('height', 0)) <= 1080
        command += ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'copy' if compatible else 'libx264']
        if not compatible:
            command += ['-preset', 'veryfast', '-crf', '23', '-pix_fmt', 'yuv420p', '-profile:v', 'main', '-vf', "scale=w='if(gte(iw,ih),min(iw,1920),min(iw,1080))':h='if(gte(iw,ih),min(ih,1080),min(ih,1920))':force_original_aspect_ratio=decrease:force_divisible_by=2"]
        command += ['-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart']
    else:
        if not audio:
            raise ValueError('No audio track is available.')
        rate = '128k' if format_id == 'mp3_128' else '192k'
        command += ['-vn', '-c:a', 'libmp3lame', '-b:a', rate, '-f', 'mp3']
    result = subprocess.run(command + [str(output)], capture_output=True, timeout=int(os.environ.get('PREPARE_TIMEOUT_SECONDS', '900')))
    if result.returncode or not output.is_file() or output.stat().st_size == 0:
        raise ValueError('Media conversion failed. Try another available video quality.')
    if output.stat().st_size > cap:
        raise ValueError('This output exceeds the server instance file-size limit. Use the on-device engine.')
    ready = probe(output)
    v = next((s for s in ready if s.get('codec_type') == 'video'), None)
    a = next((s for s in ready if s.get('codec_type') == 'audio'), None)
    if kind == 'video' and (not v or v.get('codec_name') != 'h264' or (a and a.get('codec_name') != 'aac')):
        raise ValueError('MP4 validation failed.')
    if kind != 'video' and (not a or a.get('codec_name') != 'mp3'):
        raise ValueError('MP3 validation failed.')
    return {'success': True, 'path': output.name, 'mime': 'video/mp4' if kind == 'video' else 'audio/mpeg',
            'size': output.stat().st_size, 'video_codec': v.get('codec_name') if v else None, 'audio_codec': a.get('codec_name') if a else None}


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('url');parser.add_argument('--download', action='store_true');parser.add_argument('--format', default='best');parser.add_argument('--kind', choices=['video','mp3','audio'], default='video');parser.add_argument('--output-dir')
    args = parser.parse_args()
    try:
        if args.download:
            if not args.output_dir:
                raise ValueError('A managed output folder is required.')
            result = prepare(args.url, args.format, args.kind, args.output_dir)
        else:
            with yt_dlp.YoutubeDL(options() | {'skip_download': True}) as ydl:
                result = metadata(ydl.extract_info(args.url, download=False), args.url)
        print(json.dumps(result))
    except Exception as error:
        message = str(error)
        code = 'provider_verification_required' if 'not a bot' in message.lower() or 'sign in to confirm' in message.lower() else 'extraction_error'
        print(json.dumps({'success': False, 'code': code, 'error': message}), flush=True)
        sys.exit(1)

if __name__ == '__main__':
    main()
