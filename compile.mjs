// ─────────────────────────────────────────────────────────────────────────────
// Preset compiler — the core of TYRZ's editing.
//
// Turns a resolution-agnostic preset (all box coords are PERCENTAGES of the frame)
// into concrete FFmpeg arguments. Shared by:
//   • the server (validation + live command preview in the editor)
//   • the GitHub Actions worker (actual execution)
//
// Design choices:
//   • Percent coords → works on any input resolution; we resolve against ffprobe'd
//     width/height (`meta.width` / `meta.height`) at execution time.
//   • A single -filter_complex chain: [trim] → drawbox(cover) → drawtext(name) → overlay(pip).
//   • Trim is done with filters (not -ss/-to) so it composes cleanly with the overlay graph
//     and stays frame-accurate.
// ─────────────────────────────────────────────────────────────────────────────

/** Clamp a percentage into [0,100]. */
function pct(v, fallback = 0) {
  const n = Number(v);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(100, Math.max(0, n));
}

/** Escape text for FFmpeg drawtext. */
function escapeDrawtext(s) {
  return String(s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "’") // curly apostrophe dodges quoting hell
    .replace(/%/g, '\\%');
}

/**
 * Validate + normalise a raw preset config. Throws on structural problems.
 * Returns a clean config object safe to persist and compile.
 */
export function normalizePreset(raw = {}) {
  const trim = raw.trim || {};
  const cover = raw.cover || {};
  const pip = raw.pip || {};

  const out = {
    trim: {
      cutStart: Math.max(0, Number(trim.cutStart) || 0),
      cutEnd: Math.max(0, Number(trim.cutEnd) || 0),
    },
    cover: { enabled: !!cover.enabled },
    pip: { enabled: !!pip.enabled },
  };

  if (out.cover.enabled) {
    out.cover = {
      enabled: true,
      x: pct(cover.x), y: pct(cover.y),
      w: pct(cover.w, 10), h: pct(cover.h, 10),
      color: /^#[0-9a-fA-F]{6}$/.test(cover.color || '') ? cover.color : '#ffffff',
      text: (cover.text || '').slice(0, 60),
      textColor: /^#[0-9a-fA-F]{6}$/.test(cover.textColor || '') ? cover.textColor : '#000000',
    };
  }

  if (out.pip.enabled) {
    if (!pip.assetKey) throw new Error('PiP enabled but no assetKey provided');
    out.pip = {
      enabled: true,
      x: pct(pip.x), y: pct(pip.y),
      w: pct(pip.w, 25), h: pct(pip.h, 25),
      assetKey: String(pip.assetKey),
      assetType: pip.assetType === 'video' ? 'video' : 'image',
    };
  }

  return out;
}

/** '#rrggbb' → 'rrggbb@1.0' for FFmpeg color syntax. */
function ffColor(hex) {
  return `0x${hex.replace('#', '')}`;
}

/**
 * Build the FFmpeg command for a job.
 *
 * @param {object} cfg   normalized preset (from normalizePreset)
 * @param {object} opts
 *   @param {string} opts.input      path to downloaded source video
 *   @param {string} opts.output     path to write the result
 *   @param {number} opts.width      source width  (from ffprobe)
 *   @param {number} opts.height     source height (from ffprobe)
 *   @param {number} opts.duration   source duration seconds (from ffprobe)
 *   @param {string} [opts.pipInput] local path to the PiP asset (already downloaded from R2)
 *   @param {string} [opts.fontFile] path to a .ttf for drawtext (worker provides one)
 * @returns {{ args: string[], filter: string }}
 */
export function buildFfmpegCommand(cfg, opts) {
  const { input, output, width, height, duration } = opts;
  if (!width || !height) throw new Error('buildFfmpegCommand needs source width/height');

  const start = Math.min(cfg.trim.cutStart, Math.max(0, duration - 0.1));
  const end = Math.max(start, duration - cfg.trim.cutEnd);

  const inputs = ['-i', input];
  const filters = [];
  let vlabel = '[0:v]';

  // 1) Trim (filter-based, then reset PTS).
  if (start > 0 || end < duration) {
    filters.push(`${vlabel}trim=start=${start.toFixed(3)}:end=${end.toFixed(3)},setpts=PTS-STARTPTS[vt]`);
    vlabel = '[vt]';
  }

  // 2) Cover box + name text (resolve % against source dims).
  if (cfg.cover.enabled) {
    const bx = Math.round((cfg.cover.x / 100) * width);
    const by = Math.round((cfg.cover.y / 100) * height);
    const bw = Math.round((cfg.cover.w / 100) * width);
    const bh = Math.round((cfg.cover.h / 100) * height);

    filters.push(
      `${vlabel}drawbox=x=${bx}:y=${by}:w=${bw}:h=${bh}:color=${ffColor(cfg.cover.color)}:t=fill[vc]`
    );
    vlabel = '[vc]';

    if (cfg.cover.text) {
      // Fit font to ~60% of the box height; center the text within the box.
      const fontSize = Math.max(10, Math.round(bh * 0.6));
      const fontOpt = opts.fontFile ? `fontfile='${opts.fontFile}':` : '';
      filters.push(
        `${vlabel}drawtext=${fontOpt}text='${escapeDrawtext(cfg.cover.text)}':` +
          `fontcolor=${ffColor(cfg.cover.textColor)}:fontsize=${fontSize}:` +
          `x=${bx}+(${bw}-text_w)/2:y=${by}+(${bh}-text_h)/2[vd]`
      );
      vlabel = '[vd]';
    }
  }

  // 3) PiP overlay (scale the asset to the requested box, place at x/y).
  if (cfg.pip.enabled && opts.pipInput) {
    const pw = Math.round((cfg.pip.w / 100) * width);
    const ph = Math.round((cfg.pip.h / 100) * height);
    const px = Math.round((cfg.pip.x / 100) * width);
    const py = Math.round((cfg.pip.y / 100) * height);

    // Loop a still image for the whole duration; videos come in as their own stream.
    if (cfg.pip.assetType === 'image') {
      inputs.push('-i', opts.pipInput);
    } else {
      inputs.push('-stream_loop', '-1', '-i', opts.pipInput);
    }
    filters.push(`[1:v]scale=${pw}:${ph}[pip]`);
    filters.push(`${vlabel}[pip]overlay=x=${px}:y=${py}:shortest=1[vout]`);
    vlabel = '[vout]';
  }

  // Ensure a final named label for mapping.
  if (vlabel !== '[vout]') {
    filters.push(`${vlabel}null[vout]`);
    vlabel = '[vout]';
  }

  const filter = filters.join(';');

  // Audio: trim to match if we trimmed; else copy-through the graph.
  const audioFilter =
    start > 0 || end < duration
      ? `[0:a]atrim=start=${start.toFixed(3)}:end=${end.toFixed(3)},asetpts=PTS-STARTPTS[aout]`
      : null;

  const fullFilter = audioFilter ? `${filter};${audioFilter}` : filter;

  const args = [
    '-y',
    ...inputs,
    '-filter_complex', fullFilter,
    '-map', '[vout]',
    '-map', audioFilter ? '[aout]' : '0:a?',
    '-c:v', 'libx264',
    '-preset', 'veryfast',
    '-crf', '20',
    '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-movflags', '+faststart',
    output,
  ];

  return { args, filter: fullFilter };
}
