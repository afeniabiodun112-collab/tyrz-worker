#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────────
// TYRZ FFmpeg worker — runs on a GitHub Actions runner (free, FFmpeg preinstalled).
//
// Triggered via repository_dispatch with a client payload:
//   { jobId, videoUrl, youtubeVideoId, preset, skipEditing, callbackUrl, callbackSecret,
//     pipUrl?, output: { r2Key } }
//
// Steps:
//   1. Download the source video with yt-dlp (or fetch directly for Telegram uploads).
//   2. ffprobe for width/height/duration.
//   3. Compile the preset → FFmpeg args and run (unless skipEditing).
//   4. Upload the result to R2 (S3-compatible).
//   5. POST the callback so the server can publish to Instagram.
//
// Local test (no GitHub, no R2 upload):
//   node process.mjs --local ./sample.mp4 --preset ./sample-preset.json --out ./out.mp4
// ─────────────────────────────────────────────────────────────────────────────

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readFile, stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import path from 'node:path';
import { S3Client, PutObjectCommand } from '@aws-sdk/client-s3';
import { normalizePreset, buildFfmpegCommand } from './compile.mjs';

const exec = promisify(execFile);
const WORK = process.env.WORK_DIR || '.';

function log(...a) { console.log('[worker]', ...a); }

async function run(cmd, args, opts = {}) {
  log('$', cmd, args.slice(0, 12).join(' '), args.length > 12 ? '…' : '');
  return exec(cmd, args, { maxBuffer: 1024 * 1024 * 64, ...opts });
}

// ── yt-dlp download ──────────────────────────────────────────────────────────
async function downloadVideo(videoUrl, dest) {
  // Prefer a single progressive mp4 up to 1080p; fall back to best.
  await run('yt-dlp', [
    '-f', 'bv*[height<=1080][ext=mp4]+ba[ext=m4a]/b[height<=1080]/b',
    '--merge-output-format', 'mp4',
    '--no-playlist',
    '-o', dest,
    videoUrl,
  ]);
  return dest;
}

async function fetchToFile(url, dest) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`fetch ${url} -> ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const { writeFile } = await import('node:fs/promises');
  await writeFile(dest, buf);
  return dest;
}

// ── ffprobe ──────────────────────────────────────────────────────────────────
async function probe(file) {
  const { stdout } = await run('ffprobe', [
    '-v', 'error',
    '-select_streams', 'v:0',
    '-show_entries', 'stream=width,height:format=duration',
    '-of', 'json', file,
  ]);
  const j = JSON.parse(stdout);
  const s = j.streams?.[0] || {};
  return {
    width: Number(s.width) || 0,
    height: Number(s.height) || 0,
    duration: Number(j.format?.duration) || 0,
  };
}

// ── R2 upload ────────────────────────────────────────────────────────────────
function r2Client() {
  return new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
      accessKeyId: process.env.R2_ACCESS_KEY_ID,
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY,
    },
  });
}

async function uploadR2(file, key) {
  const client = r2Client();
  const body = createReadStream(file);
  const { size } = await stat(file);
  await client.send(new PutObjectCommand({
    Bucket: process.env.R2_BUCKET,
    Key: key,
    Body: body,
    ContentType: 'video/mp4',
    ContentLength: size,
  }));
  log('uploaded to R2:', key, `(${(size / 1e6).toFixed(1)} MB)`);
  return key;
}

// ── callback ─────────────────────────────────────────────────────────────────
async function callback(url, payload, secret) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-tyrz-callback': secret },
    body: JSON.stringify(payload),
  });
  log('callback', url, '->', res.status);
}

// ── main ─────────────────────────────────────────────────────────────────────
async function main() {
  const argv = process.argv.slice(2);

  // Local test mode.
  if (argv[0] === '--local') {
    const input = argv[1];
    const presetPath = argFlag(argv, '--preset');
    const out = argFlag(argv, '--out') || path.join(WORK, 'out.mp4');
    const cfg = normalizePreset(presetPath ? JSON.parse(await readFile(presetPath, 'utf8')) : {});
    const meta = await probe(input);
    log('probe:', meta);
    const { args, filter } = buildFfmpegCommand(cfg, {
      input, output: out, ...meta,
      pipInput: cfg.pip.enabled ? argFlag(argv, '--pip') : undefined,
      fontFile: process.env.FONT_FILE,
    });
    log('filter:', filter);
    await run('ffmpeg', args);
    log('✅ wrote', out);
    return;
  }

  // Production: payload provided via env (from the Actions workflow).
  const payload = JSON.parse(process.env.JOB_PAYLOAD || '{}');
  const {
    jobId, videoUrl, preset, skipEditing, source,
    callbackUrl, callbackSecret, pipUrl, output,
  } = payload;

  if (!jobId) throw new Error('No jobId in JOB_PAYLOAD');
  const key = output?.r2Key || `videos/${jobId}.mp4`;
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
      if (cfg.pip.enabled && pipUrl) {
        pipInput = path.join(WORK, `pip-${jobId}${path.extname(pipUrl) || '.png'}`);
        await fetchToFile(pipUrl, pipInput);
      }

      const { args } = buildFfmpegCommand(cfg, {
        input: src, output: outFile, ...meta, pipInput,
        fontFile: process.env.FONT_FILE,
      });
      await run('ffmpeg', args);
      finalFile = outFile;
    }

    await notify(callbackUrl, callbackSecret, jobId, 'uploading');
    await uploadR2(finalFile, key);

    await callback(callbackUrl, {
      jobId, status: 'edited', r2Key: key,
    }, callbackSecret);
    log('✅ job complete:', jobId);
  } catch (err) {
    log('❌ job failed:', err?.message);
    await callback(callbackUrl, {
      jobId, status: 'failed', error: String(err?.message || err).slice(0, 500),
    }, callbackSecret).catch(() => {});
    process.exitCode = 1;
  }
}

async function notify(url, secret, jobId, status) {
  if (!url) return;
  await callback(url, { jobId, status }, secret).catch(() => {});
}

function argFlag(argv, name) {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
}

main().catch((err) => {
  console.error('[worker] fatal:', err);
  process.exit(1);
});
