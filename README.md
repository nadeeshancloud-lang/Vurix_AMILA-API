# VURIX API 2.1.1

Fixes adaptive audio/video merging, rejects audio-only sources offered as MP4, verifies real streams, and produces H.264/AAC MP4 (faststart) or real MP3 before sending HTTP success. Existing `/api/v1/extract`, `/api/v1/stream`, and `/api/v1/health` routes remain.

## Deploy to the existing Cloud Run service

A repository push only deploys if the owner's Cloud Run continuous-deployment trigger is configured. Verify the live health version and an actual download after deployment; source control updates alone do not prove the running revision changed.

From this directory with Google Cloud CLI authenticated to the service owner's project:

```sh
gcloud run deploy vurix-amila-api --source . --region europe-west1 --project YOUR_GOOGLE_CLOUD_PROJECT_ID --memory 2Gi --cpu 2 --concurrency 1 --timeout 900
```

Confirm the actual service name in Cloud Run before using that command. Preserve the existing service URL, IAM access policy and any existing secrets. Use the project's existing billing account; CPU and memory requirements increase because FFmpeg now prepares and validates media. The service limits media to 256 MiB by default, download preparation to 900 seconds, and one active preparation per instance. Change `MAX_MEDIA_BYTES`, `PREPARE_TIMEOUT_SECONDS`, and `MAX_CONCURRENT_DOWNLOADS` deliberately if needed. Container storage is temporary and consumes the instance's memory allocation. Large transfers are better handled by the Android device engine.

Verify `/api/v1/health` reports the new version, then test extraction and an actual completed MP4 download. Inspect that file with `ffprobe -show_streams FILE.mp4` and play it. A healthy endpoint does not establish that every provider is accessible.

## Provider restrictions

Updated yt-dlp plus a supported JavaScript runtime fixes missing extraction capabilities. YouTube or TikTok can still reject a shared Cloud Run IP, require verification or restrict a particular item. This code does not bypass login, private content, age/region controls or DRM and cannot guarantee every URL. VURIX 1.2.1 additionally performs supported extraction on the phone's connection. App Firebase sign-in does not authenticate the API to YouTube.

An optional operator-provided `YT_DLP_COOKIE_FILE` can reference an authorized server-side session file. Keep session cookies in protected secret storage, never commit them or put them in the APK. No cookies or accounts are included in this source.

## Tests

```sh
python -m pip install -r python_engine/requirements.txt imageio-ffmpeg==0.6.0
python -m unittest discover -s python_engine/tests -v
cd backend
npm test
```

Tests include actual FFmpeg conversion and complete decoding of a generated VP9/Opus fixture into H.264/AAC MP4, metadata regressions, URL validation and response filename safety. Live provider availability and Cloud Run deployment are separate checks.
