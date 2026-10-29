# Clip Sevan API 2.3.2

Public media extraction and verified H.264/AAC MP4 or real MP3 preparation. Existing `/api/v1/extract`, `/api/v1/stream`, and `/api/v1/health` routes and the existing service URL remain compatible.

## Faster format lookup and download startup

- Identical simultaneous format requests share one extraction. Distinct misses use two bounded metadata workers and a bounded queue. Successful metadata is cached for two minutes, bounded to 32 snapshots and 24 MiB per instance.
- `/extract` returns an opaque `extraction_id`, also embedded in each existing `download_url`. The actual sanitized yt-dlp metadata stays in a private server file. `/stream` reuses it to avoid querying the provider a second time. Tokens are bound to the input/canonical public URL. Meaningful source fragments are preserved, and a provider canonical URL that drops one cannot borrow that snapshot. Old links and expired tokens still work through fresh extraction.
- Expired signed provider URLs are refreshed once. The chosen video resolution is preserved; an unavailable quality produces an explicit error rather than silently choosing a larger file.
- H.264 video and compatible AAC audio are copied into MP4 with faststart; encoding is used only when needed. The file's real streams are still verified before HTTP success.
- Already prepared files are reusable for two minutes, bounded to four files / 96 MiB. Immutable file identities support safe ETags and Range resume. Active readers keep their file until they finish. Total cached and in-flight ready outputs also use a 512 MiB budget with per-preparation size reservation; resource pressure returns an explicit busy response instead of accumulating unbounded memory-backed files. Simultaneous requests for the same output share preparation; one disconnected client does not cancel another's download.
- Metadata sizes are explicitly approximate when based on source lengths/bitrates. CRF video conversion size remains unknown before encoding. A currently cached verified output reports its exact byte length.
- Compatible progressive MP4 choices may additionally include `fast_download_url` and empty client `fast_download_headers`. The URL points to `/api/v1/fast-stream`, a source-bound relay using the original URL, extraction handle and format ID. It streams the already-muxed H.264/AAC source from the server connection without staging the entire file; the app validates the saved media before completion. Eligible sources require public HTTPS, known dimensions within 1920×1080 (either orientation), no DRM/manifests/fragments and no separate-track merge. The relay pins public DNS on each redirect, limits concurrency to four, applies connection/idle/overall deadlines and enforces the file-size cap without buffering whole files. CDN addresses and headers stay private. Range resume is advertised only with a strong ETag or valid Last-Modified value.
- If a quick connection is unavailable before response bytes are sent, or its cache entry expired, the same response uses the existing verified download route. A source-bound failed shortcut is omitted for the rest of that snapshot's lifetime; old cached quick URLs use verified delivery without retrying it. Wrong-source handles, unknown formats, range errors, byte-limit violations, private hosts and cancellation do not trigger a verified retry. Already prepared outputs use their cached verified `download_url` directly. No source `fast_filesize` is published for relay choices: a fallback remux can change the bytes, so the picker keeps an estimate and HTTP Content-Length supplies the actual transfer size. The original verified route remains compatible with older clients. MP3 still uses real conversion; AAC is never renamed to MP3.

The first request still requires provider extraction, and the first uncached MP4/MP3 still requires transfer and any necessary conversion. These changes remove duplicate work; they do not promise instant responses, a fixed network speed or availability of every URL. Metadata and prepared caches are per instance and temporary, so a cold instance or expired cache needs fresh work.

`Server-Timing: prepare;dur=...` and `X-Clip-Sevan-Prepared: fresh|cache` distinguish preparation from reusable responses. The legacy `X-Vurix-Verified` header is retained for compatibility. Do not expose the private snapshot directory through a static-file route.

## Deploy to the existing Cloud Run service

A repository push only deploys when the owner's continuous-deployment trigger is configured. Verify health version 2.3.2 and an actual completed media download after deployment; a source-control update alone does not prove the running revision changed.

From this directory, authenticated to the service owner's project:

```sh
gcloud run deploy vurix-amila-api --source . --region europe-west1 --project YOUR_GOOGLE_CLOUD_PROJECT_ID --memory 2Gi --cpu 2 --concurrency 1 --timeout 900
```

Preserve the existing service name, public URL, IAM policy and any existing secrets. The service defaults to a 256 MiB file-size cap, 900-second preparation timeout and one active preparation per instance. `MAX_MEDIA_BYTES`, `PREPARE_TIMEOUT_SECONDS`, and `MAX_CONCURRENT_DOWNLOADS` control those limits. One preparation worker is the memory-conservative default; completed-file transfers and metadata cache hits do not hold that worker. Temporary files count toward the instance's memory allocation. Large or challenged transfers can use the Android device engine.

## Provider restrictions

This service uses the sites supported by the installed yt-dlp version without a social-site allowlist. YouTube/TikTok can still challenge a shared Cloud Run IP, require an authorized session or restrict a particular item. The supported alternative YouTube clients remain configured. Login, private content, age/region controls and DRM are not bypassed; every URL cannot be guaranteed. Clip Sevan also includes a device engine using the phone connection. Firebase sign-in does not authenticate the API to YouTube.

An optional operator-provided `YT_DLP_COOKIE_FILE` can refer to an authorized server-side session. Keep it in protected secret storage, never commit it or bundle it in the app. No cookies/accounts are included in this source.

## Tests

```sh
python -m pip install -r python_engine/requirements.txt imageio-ffmpeg==0.6.0
python -m unittest discover -s python_engine/tests -v
cd backend
npm test
```

Tests cover real MP4 conversion/full decoding and H.264/AAC copying, snapshot reuse without another extraction, one-time expired-link refresh, metadata isolation/token binding/expiry, immutable prepared-file reuse, cancellation shared by multiple clients, safe reader lifetime and cache bounds. Relay tests cover pinned DNS, redirects, source-bound handles, byte limits, deadlines, disconnects, range validation and safe response headers. Cache/relay transport tests use controlled files; full codec validation is separately exercised by actual FFmpeg tests. Deployment and live-provider checks remain separate.
