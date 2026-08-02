#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// TYRZ FFmpeg worker — GitHub Actions runner (hardened + cookies, 2026).
// Storage: GitHub Release assets on this public repo (no Cloudflare R2).
//
// Download strategy:
//   1. If YTDLP_COOKIES secret is set → write cookies.txt and use --cookies
//   2. Multi-client yt-dlp rotation (android / ios / android_vr / …)
//   3. Optional --impersonate chrome on later attempts
//   4. Optional HTTP(S) proxy via YTDLP_PROXY
//   5. Bounded retries with backoff + clear failure logging
//
// On permanent failure → callback status=failed with short error.
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, writeFile, stat, unlink } from 'node:fs/promises';
import path from 'node:path';
import { normalizePreset, buildFfmpegCommand } from './compile.mjs';

const exec = promisify(execFile);
const WORK = process.env.WORK_DIR || '.';

const MAX_DOWNLOAD_ATTEMPTS = Number(process.env.YTDLP_MAX_ATTEMPTS || 3);
const RETRY_BASE_MS = Number(process.env.YTDLP_RETRY_BASE_MS || 4000);

function log(...a) {
  console.log('[worker]', ...a);
}

async function run(cmd, args, opts = {}) {
  // Never log full cookie path contents; only show that --cookies is present.
  const safeArgs = args.map((a, i) =>
    args[i - 1] === '--cookies' ? '<cookies.txt>' : a
  );
  log('$', cmd, safeArgs.slice(0, 16).join(' '), safeArgs.length > 16 ? '…' : '');
  try {
    return await exec(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...opts });
  } catch (e) {
    const msg = [e?.stderr, e?.stdout, e?.message].filter(Boolean).join('\n').slice(0, 1200);
    throw new Error(`Command failed: ${cmd} ${safeArgs.join(' ')}\n${msg}`);
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isBotBlock(msg) {
  return /not a bot|Sign in to confirm|confirm you.?re not a bot|HTTP Error 403/i.test(msg);
}

function isAuthError(msg) {
  return /cookies?|login|authentication|Sign in to confirm|not a bot/i.test(msg);
}

/**
 * Write YTDLP_COOKIES secret to a temp Netscape cookies file.
 * Returns path or null if secret is missing/empty.
 */
async function materializeCookies() {
  const raw = (process.env.YTDLP_COOKIES || '').trim();
  if (!raw) return null;

  // Accept either full Netscape file or raw cookie lines.
  let body = raw;
  if (!body.includes('Netscape') && !body.startsWith('#')) {
    body = '# Netscape HTTP Cookie File\n' + body;
  }

  const dest = path.join(WORK, 'yt-cookies.txt');
  await writeFile(dest, body + (body.endsWith('\n') ? '' : '\n'), 'utf8');
  log('cookies file written', dest, `(${body.length} chars)`);
  return dest;
}

function clientStrategies() {
  // With cookies, web + mweb often work best; still try mobile/TV as fallback.
  return [
    'web,mweb',
    'android,ios',
    'android',
    'ios',
    'android_vr',
    'tv_simply',
    'web_embedded',
    'mweb',
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

async function ytdlpOnce(videoUrl, dest, { client, format, useImpersonate, cookiesPath }) {
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

  if (cookiesPath) {
    args.push('--cookies', cookiesPath);
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
 * Hardened download with cookies (preferred) + client rotation + retries.
 */
async function downloadVideo(videoUrl, dest) {
  const cookiesPath = await materializeCookies();
  if (cookiesPath) {
    log('using YTDLP_COOKIES secret');
  } else {
    log('WARNING: no YTDLP_COOKIES secret — relying on client rotation only (often blocked on Actions IPs)');
  }

  const clients = clientStrategies();
  const formats = formatStrategies();
  let lastErr;
  const attemptLog = [];

  for (let attempt = 1; attempt <= MAX_DOWNLOAD_ATTEMPTS; attempt++) {
    const useImpersonate = attempt >= 2;
    log(`download attempt ${attempt}/${MAX_DOWNLOAD_ATTEMPTS}`, {
      cookies: !!cookiesPath,
      impersonate: useImpersonate,
      proxy: !!(process.env.YTDLP_PROXY || process.env.HTTPS_PROXY),
    });

    for (const client of clients) {
      let botBlocked = false;
      for (const fmt of formats) {
        try {
          try { await unlink(dest); } catch { /* ignore */ }

          await ytdlpOnce(videoUrl, dest, {
            client,
            format: fmt,
            useImpersonate,
            cookiesPath,
          });

          const st = await stat(dest);
          if (st.size < 10_000) {
            throw new Error(`downloaded file too small (${st.size} bytes)`);
          }

          log('download ok', { client, attempt, bytes: st.size, cookies: !!cookiesPath });
          return dest;
        } catch (e) {
          lastErr = e;
          const msg = String(e?.message || e);
          const short = msg.replace(/\s+/g, ' ').slice(0, 180);
          attemptLog.push(`a${attempt}/${client}: ${short}`);
          log('yt-dlp failed', { attempt, client, fmt: fmt.slice(0, 36) }, short);

          if (isBotBlock(msg) || isAuthError(msg)) {
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
  const hint = cookiesPath
    ? 'Cookies may be expired — re-export from browser and update YTDLP_COOKIES secret.'
    : 'No cookies secret set. Add YTDLP_COOKIES or a residential YTDLP_PROXY.';
  throw new Error(
    `yt-dlp exhausted ${MAX_DOWNLOAD_ATTEMPTS} attempts. ${hint} Last errors: ${summary.slice(0, 400)}`
  );
}

async function fetchToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
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
