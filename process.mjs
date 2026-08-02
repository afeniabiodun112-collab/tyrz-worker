#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// TYRZ FFmpeg worker — GitHub Actions runner (hardened download, 2026).
// Storage: GitHub Release assets on this public repo (no Cloudflare R2).
//
// Download strategy (no cookies / no login):
//   1. Multi-client yt-dlp rotation (android / ios / android_vr / tv_simply / …)
//   2. Optional PO-Token provider (bgutil) if POT_PROVIDER_URL is set
//   3. Optional --impersonate chrome on retry attempts
//   4. Optional HTTP(S) proxy via YTDLP_PROXY or HTTPS_PROXY
//   5. Bounded retries with backoff + clear failure logging
//
// On permanent failure the job callbacks status=failed with a short error so
// the server can surface it / retry later. No Telegram path in this build.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { normalizePreset, buildFfmpegCommand } from './compile.mjs';

const exec = promisify(execFile);
const WORK = process.env.WORK_DIR || '.';

/** Max full download attempts (each attempt may try several clients). */
const MAX_DOWNLOAD_ATTEMPTS = Number(process.env.YTDLP_MAX_ATTEMPTS || 3);
/** Base delay (ms) between full attempts. */
const RETRY_BASE_MS = Number(process.env.YTDLP_RETRY_BASE_MS || 4000);

function log(...a) {
  console.log('[worker]', ...a);
}

async function run(cmd, args, opts = {}) {
  log('$', cmd, args.slice(0, 14).join(' '), args.length > 14 ? '…' : '');
  try {
    return await exec(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...opts });
  } catch (e) {
    const msg = [e?.stderr, e?.stdout, e?.message].filter(Boolean).join('\n').slice(0, 1200);
    throw new Error(`Command failed: ${cmd} ${args.join(' ')}\n${msg}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isBotBlock(msg) {
  return /not a bot|Sign in to confirm|confirm you.?re not a bot|HTTP Error 403/i.test(msg);
}

/**
 * Ordered player_client strategies (2026).
 * Prefer clients that still work more often without cookies / PO tokens.
 */
function clientStrategies() {
  return [
    'android,ios',
    'android_vr',
    'ios',
    'android',
    'tv_simply',
    'web_embedded',
    'mweb',
    'tv_embedded',
    'web',
  ];
}

function formatStrategies() {
  return [
    'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080][ext=mp4]/b',
    'bv*[height<=1080]+ba/b[height<=1080]/b',
    'b',
  ];
}

/**
 * One yt-dlp invocation with a specific client + format.
 */
async function ytdlpOnce(videoUrl, dest, { client, format, useImpersonate, potProvider }) {
  const args = [
    '-f', format,
    '--merge-output-format', 'mp4',
    '--js-runtimes', 'deno',
    '--extractor-args', `youtube:player_client=${client}`,
    '--no-playlist',
    '--no-warnings',
    '--retries', '2',
    '--fragment-retries', '2',
    '-o', dest,
  ];

  // Optional PO-Token provider (bgutil). Plugin auto-hooks when installed;
  // POT_PROVIDER_URL documents the endpoint for operators.
  if (potProvider) {
    process.env.BGUTIL_PROVIDER_URL = potProvider;
  }

  if (useImpersonate) {
    args.push('--impersonate', 'chrome');
  }

  const proxy = process.env.YTDLP_PROXY || process.env.HTTPS_PROXY || process.env.HTTP_PROXY;
  if (proxy) {
    args.push('--proxy', proxy);
  }

  args.push(videoUrl);
  await run('yt-dlp', args);
}

/**
 * Hardened download with client rotation + bounded outer retries.
 *
 * Failure / retry policy:
 * - Bot-check on a client → skip remaining formats for that client, try next client.
 * - After all clients fail → wait (backoff) and retry the whole rotation
 *   (up to MAX_DOWNLOAD_ATTEMPTS, default 3).
 * - Permanent failure → throw with a concise message for the job callback
 *   (status=failed). Server can re-dispatch later.
 */
async function downloadVideo(videoUrl, dest) {
  const clients = clientStrategies();
  const formats = formatStrategies();
  const potProvider = (process.env.POT_PROVIDER_URL || '').trim() || null;
  let lastErr;
  const attemptLog = [];

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    const useImpersonate = attempt >= 2;
    log(`download attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}`, {
      pot: !!potProvider,
      impersonate: useImpersonate,
      proxy: !!(process.env.YTDLP_PROXY || process.env.HTTPS_PROXY),
    });

    for (const client of clients) {
      let botBlocked = false;
      for (const fmt of formats) {
        try {
          try { await unlink(dest); } catch { /* ignore missing */ }

          await ytdlpOnce(videoUrl, dest, {
            client,
            format: fmt,
            useImpersonate,
            potProvider,
          });

          const st = await stat(dest);
          if (st.size < 10_000) {
            throw new Error(`downloaded file too small (${st.size} bytes)`);
          }

          log('download ok', { client, attempt, bytes: st.size });
          return dest;
        } catch (e) {
          lastErr = e;
          const msg = String(e?.message || e);
          const short = msg.replace(/\s+/g, ' ').slice(0, 180);
          attemptLog.push(`a${attempt}/${client}: ${short}`);
          log('yt-dlp failed', { attempt, client, fmt: fmt.slice(0, 36) }, short);

          if (isBotBlock(msg)) {
            botBlocked = true;
            break;
          }
        }
      }
      if (botBlocked) continue;
    }

    if (attempt < MAX_DOWNLOAD_ATTEMPTS) {
      const delay = RETRY_BASE_MS * attempt + Math.floor(Math.random() * 1500);
      log(`all clients failed on attempt ${attempt}; sleeping ${delay}ms before retry`);
      await sleep(delay);
    }
  }

  const summary = attemptLog.slice(-8).join(' | ') || String(lastErr?.message || lastErr);
  throw new Error(
    `yt-dlp exhausted ${MAX_DOWNLOAD_ATTEMPTS} attempts (no cookies). ` +
      `Last errors: ${summary.slice(0, 500)}`
  );
}

async function fetchToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const { writeFile } = await import('node:fs/promises');
  await writeFile(dest, Buffer.from(await res.arrayBuffer()));
  return dest;
}

async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json',
    file,
  ]);
  const j = JSON.parse(stdout);
  const s = j.streams?.[0] || {};
  return {
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    duration: Number(j.format?.duration) || 0,
  };
}

function ghHeaders(extra = {}) {
  const token = process.env.GITHUB_TOKEN;
  if (!token) throw new Error('GITHUB_TOKEN not set — cannot create release');
  return {
    Authorization: `Bearer ${token}`,
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    'User-Agent': 'tyrz-worker',
    ...extra,
  };
}

async function createRelease(tagName, name) {
  const repo = process.env.GITHUB_REPOSITORY;
  if (!repo) throw new Error('GITHUB_REPOSITORY not set');
  const res = await fetch(`https://api.github.com/repos/${repo}/releases`, {
    method: 'POST',
    headers: ghHeaders({ 'Content-Type': 'application/json' }),
    body: JSON.stringify({
      tag_name: tagName,
      name,
      body: 'Auto-generated by the TYRZ worker. Safe to delete once the platform has ingested the video.',
      draft: false,
      prerelease: false,
    }),
  });
  if (!res.ok) {
    throw new Error(`create release failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function uploadReleaseAsset(uploadUrlTemplate, assetName, file) {
  const uploadUrl =
    uploadUrlTemplate.replace(/\{.*\}$/, '') +
    `?name=${encodeURIComponent(assetName)}`;
  const buffer = await readFile(file);
  const res = await fetch(uploadUrl, {
    method: 'POST',
    headers: ghHeaders({
      'Content-Type': 'video/mp4',
      'Content-Length': String(buffer.length),
    }),
    body: buffer,
  });
  if (!res.ok) {
    throw new Error(`upload asset failed: ${res.status} ${await res.text()}`);
  }
  return res.json();
}

async function uploadToGithubRelease(file, jobId, assetName) {
  const { size } = await stat(file);
  const tagName = `job-${jobId}-${Date.now()}`;
  const release = await createRelease(tagName, `TYRZ video ${jobId}`);
  const asset = await uploadReleaseAsset(release.upload_url, assetName, file);
  log('uploaded to GitHub Release:', tagName, `(${(size / 1e6).toFixed(1)} MB)`);
  return {
    url: asset.browser_download_url,
    releaseId: release.id,
    assetId: asset.id,
  };
}

async function callback(url, payload, secret) {
  if (!url) return;
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-tyrz-callback': secret || '',
    },
    body: JSON.stringify(payload),
  });
  log('callback', url, '->', res.status);
}

async function notify(url, secret, jobId, status) {
  if (!url) return;
  await callback(url, { jobId, status }, secret).catch(() => {});
}

function argFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

async function main() {
  const argv = process.argv.slice(2);

  if (argv[0] === '--local') {
    const input = argv[1];
    const presetPath = argFlag(argv, '--preset');
    const out = argFlag(argv, '--out') || path.join(WORK, 'out.mp4');
    const cfg = normalizePreset(
      presetPath ? JSON.parse(await readFile(presetPath, 'utf8')) : {}
    );
    const meta = await probe(input);
    log('probe:', meta);
    const { args, filter } = buildFfmpegCommand(cfg, {
      input,
      output: out,
      ...meta,
      pipInput: cfg.pip.enabled ? argFlag(argv, '--pip') : undefined,
      fontFile: process.env.FONT_FILE,
    });
    log('filter:', filter);
    await run('ffmpeg', args);
    log('✅ wrote', out);
    return;
  }

  const payload = JSON.parse(process.env.JOB_PAYLOAD || '{}');
  const {
    jobId,
    videoUrl,
    preset,
    skipEditing,
    source,
    callbackUrl,
    callbackSecret,
    pipUrl,
    output,
  } = payload;

  if (!jobId) throw new Error('No jobId in JOB_PAYLOAD');
  const assetName = output?.assetName || `${jobId}.mp4`;
  const src = path.join(WORK, `src-${jobId}.mp4`);
  const outFile = path.join(WORK, `out-${jobId}.mp4`);

  try {
    await notify(callbackUrl, callbackSecret, jobId, 'downloading');
    if (source === 'telegram') {
      await fetchToFile(videoUrl, src);
    } else {
      await downloadVideo(videoUrl, src);
    }

    let finalFile = src;

    if (!skipEditing) {
      await notify(callbackUrl, callbackSecret, jobId, 'editing');
      const cfg = normalizePreset(preset || {});
      const meta = await probe(src);
      if (!meta.width) throw new Error('ffprobe found no video stream');

      let pipInput;
      if (cfg.pip?.enabled && pipUrl) {
        pipInput = path.join(WORK, `pip-${jobId}${path.extname(pipUrl) || '.png'}`);
        await fetchToFile(pipUrl, pipInput);
      }

      const { args } = buildFfmpegCommand(cfg, {
        input: src,
        output: outFile,
        ...meta,
        pipInput,
        fontFile: process.env.FONT_FILE,
      });
      await run('ffmpeg', args);
      finalFile = outFile;
    }

    await notify(callbackUrl, callbackSecret, jobId, 'uploading');
    const { url, releaseId, assetId } = await uploadToGithubRelease(
      finalFile,
      jobId,
      assetName
    );

    await callback(
      callbackUrl,
      { jobId, status: 'edited', videoUrl: url, releaseId, assetId },
      callbackSecret
    );
    log('✅ job complete:', jobId);
  } catch (err) {
    log('❌ job failed:', err?.message);
    await callback(
      callbackUrl,
      {
        jobId,
        status: 'failed',
        error: String(err?.message || err).slice(0, 500),
      },
      callbackSecret
    ).catch(() => {});
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
