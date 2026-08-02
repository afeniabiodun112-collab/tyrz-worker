# tyrz-worker (hardened download)

FFmpeg worker for TYRZ. Push this folder to a **public** GitHub repo so Actions minutes are free.

## Setup

1. Create a **public** repo (e.g. `you/tyrz-worker`) and push these files so
   `.github/workflows/process.yml` is on the default branch.
2. Optional secrets (download hardening):
   - `YTDLP_PROXY` — residential/HTTP proxy URL (`http://user:pass@host:port`)
   - `POT_PROVIDER_URL` — base URL of a [bgutil](https://github.com/Brainicism/bgutil-ytdlp-pot-provider) PO-token provider
   - `YTDLP_MAX_ATTEMPTS` — outer retry count (default `3`)
   - `YTDLP_RETRY_BASE_MS` — base backoff between attempts in ms (default `4000`)
3. Optional secrets (digest cron only):
   - `SERVER_URL` — your Render URL
   - `CALLBACK_SECRET` — same as server `CALLBACK_SECRET`
4. On the server: `WORKER_REPO=you/tyrz-worker` and `GITHUB_DISPATCH_PAT`
   (fine-grained PAT with **Contents: read/write** on this repo).

**No R2 / Cloudflare secrets.** Finished videos are uploaded as **GitHub Release** assets.
Repo must stay **public** so Instagram can download the file without a token.

## Job flow

`repository_dispatch` → yt-dlp (+ Deno) → FFmpeg → GitHub Release → callback
`SERVER_URL/api/webhooks/job` with `{ status: "edited", videoUrl }` **or**
`{ status: "failed", error }`.

## Hardened download (no cookies / no login)

`process.mjs` uses a multi-strategy downloader:

1. **Client rotation** (2026 order):  
   `android,ios` → `android_vr` → `ios` → `android` → `tv_simply` → `web_embedded` → `mweb` → `tv_embedded` → `web`
2. **Format fallbacks**: progressive/merged mp4 ≤1080p, then best.
3. **Outer retries** (default 3) with exponential-ish backoff + jitter.
4. **Bot-check handling**: if a client returns “Sign in to confirm you’re not a bot”, skip remaining formats for that client and move on.
5. **Optional** `--impersonate chrome` on attempt 2+ (when `curl-cffi` is present).
6. **Optional** `YTDLP_PROXY` / `POT_PROVIDER_URL` for residential IP or PO tokens.

### Failure & retry behaviour

| Situation | Behaviour |
|-----------|-----------|
| Transient / single-client bot block | Try next client immediately |
| All clients fail in one attempt | Sleep `RETRY_BASE_MS * attempt + jitter`, then full rotation again |
| All attempts exhausted | Job ends with `status: "failed"` and a short `error` string in the callback |
| Server wants another try | Re-dispatch the same job (or a new job) via `repository_dispatch` |

The callback payload on failure looks like:

```json
{
  "jobId": "...",
  "status": "failed",
  "error": "yt-dlp exhausted 3 attempts (no cookies). Last errors: a3/web: ..."
}
```

There is **no** automatic Telegram path in this build. The server should treat `failed` as terminal for this run and optionally queue a later retry or surface the error in the dashboard.

### Expected success rate

On pure GitHub Actions IPs, success is **not** 100%. Client rotation + retries typically recover a large fraction of transient blocks. For near-production reliability add a residential `YTDLP_PROXY` or run downloads on a better IP (self-hosted runner / Cobalt).

## Local test

```bash
# needs ffmpeg + yt-dlp (+ deno for YouTube) on PATH
node process.mjs --local ./sample.mp4 --preset ./sample-preset.json --out ./out.mp4
```

## License

Private/unpublished.
