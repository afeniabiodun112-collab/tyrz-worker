# tyrz-worker

FFmpeg worker for TYRZ. Push this folder to a **public** GitHub repo so Actions minutes are free.

## Setup

1. Create a **public** repo (e.g. `you/tyrz-worker`) and push these files so
   `.github/workflows/process.yml` is on the default branch.
2. Optional secrets (digest cron only):
   - `SERVER_URL` — your Render URL  
   - `CALLBACK_SECRET` — same as server `CALLBACK_SECRET`
3. On the server: `WORKER_REPO=you/tyrz-worker` and `GITHUB_DISPATCH_PAT`
   (fine-grained PAT with **Contents: read/write** on this repo).

**No R2 / Cloudflare secrets.** Finished videos are uploaded as **GitHub Release** assets.
Repo must stay **public** so Instagram can download the file without a token.

## Job flow

`repository_dispatch` → yt-dlp (+ Deno) → FFmpeg → GitHub Release → callback
`SERVER_URL/api/webhooks/job` with `{ status: "edited", videoUrl }`.

## Local test

```bash
# needs ffmpeg + yt-dlp (+ deno for YouTube) on PATH
node process.mjs --local ./sample.mp4 --preset ./sample-preset.json --out ./out.mp4
```
