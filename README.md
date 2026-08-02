# tyrz-worker (cookies + hardened download)

FFmpeg worker for TYRZ. Public repo → free Actions minutes.

## Required secret (YouTube downloads)

| Secret | Purpose |
|--------|---------|
| `YTDLP_COOKIES` | Full Netscape `cookies.txt` from a logged-in YouTube session |

Without this, downloads usually fail on GitHub Actions IPs with “Sign in to confirm you’re not a bot”.

### How to refresh cookies
1. Export cookies again from Firefox/Iceraven (Get cookies.txt LOCALLY).
2. Repo → Settings → Secrets → Actions → edit `YTDLP_COOKIES` → paste full file → save.

Cookies typically last days to a few weeks.

## Optional secrets

| Secret | Purpose |
|--------|---------|
| `YTDLP_PROXY` | Residential proxy URL |
| `YTDLP_MAX_ATTEMPTS` | Outer retries (default 3) |
| `YTDLP_RETRY_BASE_MS` | Backoff base ms (default 4000) |
| `SERVER_URL` / `CALLBACK_SECRET` | Digest cron only |

## Server config
`WORKER_REPO=you/tyrz-worker` and `GITHUB_DISPATCH_PAT` (Contents: read/write).

## Job flow
`repository_dispatch` → yt-dlp (`--cookies` if secret set) → FFmpeg → GitHub Release → callback  
`{ status: "edited", videoUrl }` or `{ status: "failed", error }`.

## Download behaviour
1. Write `YTDLP_COOKIES` → temp `yt-cookies.txt`
2. yt-dlp with `--cookies` + client rotation
3. Retries with backoff; attempt 2+ may use `--impersonate chrome`
4. On total failure → `status: failed` with short error (re-export cookies if auth-related)

## Local test
```bash
node process.mjs --local ./sample.mp4 --preset ./sample-preset.json --out ./out.mp4
```
