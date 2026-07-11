# tyrz-worker

The FFmpeg worker for TYRZ. **Push this folder to a _public_ GitHub repo** so Actions
minutes are free and unlimited. The TYRZ server fires jobs at it via `repository_dispatch`.

## Setup

1. Create a **public** repo (e.g. `you/tyrz-worker`) and push these files so
   `.github/workflows/process.yml` is on the default branch.
2. Add repo **secrets** (Settings → Secrets → Actions):
   - `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY`, `R2_BUCKET`
   - `SERVER_URL` (your Render URL) and `CALLBACK_SECRET` (for the digest cron)
3. On the server, set `WORKER_REPO=you/tyrz-worker` and `GITHUB_DISPATCH_PAT`
   (a fine-grained PAT with **Contents: read/write** on this repo, which allows
   `POST /dispatches`).

## How a job runs

`process.yml` (`on: repository_dispatch: [process-video]`) →
installs FFmpeg + yt-dlp → runs `process.mjs`, which:

1. downloads the source (`yt-dlp`, or a direct fetch for Telegram uploads),
2. `ffprobe`s the dimensions,
3. compiles the preset with `compile.mjs` and runs FFmpeg (unless `skipEditing`),
4. uploads the result to R2,
5. calls back `SERVER_URL/api/webhooks/job` so the server publishes to Instagram.

## Test locally (no GitHub, no R2)

```bash
npm install
# needs ffmpeg + yt-dlp on PATH
node process.mjs --local ./sample.mp4 --preset ./sample-preset.json --out ./out.mp4
```

`compile.mjs` is a copy of the server's `src/preset/compile.js` — keep them in sync
(same percentage-based coordinate model). The server's unit tests cover this logic.

## Why GitHub Actions

FFmpeg can't run in a Cloudflare Worker (no native binaries) and a free Render web
service sleeps mid-encode. Actions gives a real Linux runner with FFmpeg preinstalled,
free and unlimited on public repos, triggered on demand — the right "burst job" tool.
