/**
 * Render the body figure to a PNG so a human (or a model with eyes) can LOOK at
 * it — the only tool in this repo that catches the thing the fourth attempt at
 * this drawing exists because of.
 *
 * Three versions of the figure were rejected on hardware. Every one of them was
 * defensible in the numbers and wrong on the screen, because "does this read as
 * a person" is not a property any assertion in db/exercise-ai.test.mjs can hold.
 * This script closes that loop offline: it re-implements the component's paint
 * order over a software rasteriser, at 4× supersampling, and writes a PNG with
 * `node:zlib` (no image dependency, and none is going in).
 *
 * It is a DEV TOOL, not a test — nothing in `npm run db:test` runs it, and it
 * asserts nothing. It is kept in the tree because the next person to touch the
 * geometry will need it, and rebuilding it from scratch is an afternoon.
 *
 *   node --import ./db/register-ts-hooks.mjs db/figure-preview.mjs
 *   node --import ./db/register-ts-hooks.mjs db/figure-preview.mjs --width 240
 *
 * Writes .omc/figure-preview/*.png (gitignored scratch).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { palette } from '../src/constants/theme.ts';
import {
  BAR_POINTS,
  BODY_BAR_POINTS,
  BODY_OUTLINE,
  FIGURE_BODY,
  FIGURE_GRID,
  MUSCLE_OUTLINE,
  barsFor,
  freshnessFill,
  musclesFor,
  polyBars,
} from '../src/lib/exercise/figure.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(HERE, '..', '.omc', 'figure-preview');

// --- tiny PNG encoder --------------------------------------------------------

function crc32(buf) {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) c = (c >>> 1) ^ (0xedb88320 & -(c & 1));
  }
  return ~c >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body));
  return Buffer.concat([len, body, crc]);
}

/** rgb Uint8Array (w*h*3) → PNG buffer. */
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy
      ? rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3)
      : Buffer.from(rgb.subarray(y * w * 3, (y + 1) * w * 3)).copy(raw, y * (w * 3 + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

// --- geometry helpers (mirrors of the component's, in device px) -------------

const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

/** Rounded-rect hit test in the SAME units the style props use. */
function inBlobPx(b, x, y, scale, inflate) {
  const left = (b.x - inflate) * scale;
  const top = (b.y - inflate) * scale;
  const w = (b.w + inflate * 2) * scale;
  const h = (b.h + inflate * 2) * scale;
  if (x < left || x > left + w || y < top || y > top + h) return false;
  const cap = Math.min(w, h) / 2;
  const r = b.r.map((v) => Math.min((v + inflate) * scale, cap));
  const near = (cx, cy, rr) => (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr;
  if (x < left + r[0] && y < top + r[0]) return near(left + r[0], top + r[0], r[0]);
  if (x > left + w - r[1] && y < top + r[1]) return near(left + w - r[1], top + r[1], r[1]);
  if (x > left + w - r[2] && y > top + h - r[2]) return near(left + w - r[2], top + h - r[2], r[2]);
  if (x < left + r[3] && y > top + h - r[3]) return near(left + r[3], top + h - r[3], r[3]);
  return true;
}

/** One rasterised bar as the component positions it, with its end caps. */
function inBarPx(bar, i, n, x, y, scale, inflate) {
  const left = (bar.x - inflate) * scale;
  const top = (bar.y - inflate) * scale;
  const w = (bar.w + inflate * 2) * scale;
  const h = (bar.h + inflate * 2) * scale;
  if (x < left || x > left + w || y < top || y > top + h) return false;
  const cap = Math.min(w, h) / 2;
  const near = (cx, cy, rr) => (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr;
  if (i === 0 && y < top + cap) {
    if (x < left + cap) return near(left + cap, top + cap, cap);
    if (x > left + w - cap) return near(left + w - cap, top + cap, cap);
  }
  if (i === n - 1 && y > top + h - cap) {
    if (x < left + cap) return near(left + cap, top + h - cap, cap);
    if (x > left + w - cap) return near(left + w - cap, top + h - cap, cap);
  }
  return true;
}

function inShapePx(shape, x, y, scale, inflate, target = BAR_POINTS) {
  if (shape.kind === 'blob') return inBlobPx(shape, x, y, scale, inflate);
  const n = barsFor(shape, scale, target);
  const bars = polyBars(shape.pts, n);
  for (let i = 0; i < bars.length; i++) {
    if (inBarPx(bars[i], i, bars.length, x, y, scale, inflate)) return true;
  }
  return false;
}

// --- the paint ---------------------------------------------------------------

const SS = 4; // supersampling factor

/**
 * A shape flattened to the primitives the component actually mounts: a list of
 * rounded rectangles in device pixels. A blob is one; a poly is one per bar,
 * with the end caps the component applies. Done ONCE per shape so the paint
 * loop touches only each primitive's own bounding box — the pixel-major version
 * was O(pixels × shapes × bars) and did not finish.
 */
function primitives(shape, scale, inflate, target) {
  if (shape.kind === 'blob') {
    const cap = Math.min((shape.w + inflate * 2) * scale, (shape.h + inflate * 2) * scale) / 2;
    return [
      {
        left: (shape.x - inflate) * scale,
        top: (shape.y - inflate) * scale,
        w: (shape.w + inflate * 2) * scale,
        h: (shape.h + inflate * 2) * scale,
        r: shape.r.map((v) => Math.min((v + inflate) * scale, cap)),
      },
    ];
  }
  const bars = polyBars(shape.pts, barsFor(shape, scale, target));
  return bars.map((bar, i) => {
    const w = (bar.w + inflate * 2) * scale;
    const h = (bar.h + inflate * 2) * scale;
    const cap = Math.min(w, h) / 2;
    const top = i === 0 ? cap : 0;
    const bot = i === bars.length - 1 ? cap : 0;
    return { left: (bar.x - inflate) * scale, top: (bar.y - inflate) * scale, w, h, r: [top, top, bot, bot] };
  });
}

function inPrim(p, x, y) {
  if (x < p.left || x > p.left + p.w || y < p.top || y > p.top + p.h) return false;
  const near = (cx, cy, rr) => (x - cx) ** 2 + (y - cy) ** 2 <= rr * rr;
  const [tl, tr, br, bl] = p.r;
  if (tl > 0 && x < p.left + tl && y < p.top + tl) return near(p.left + tl, p.top + tl, tl);
  if (tr > 0 && x > p.left + p.w - tr && y < p.top + tr)
    return near(p.left + p.w - tr, p.top + tr, tr);
  if (br > 0 && x > p.left + p.w - br && y > p.top + p.h - br)
    return near(p.left + p.w - br, p.top + p.h - br, br);
  if (bl > 0 && x < p.left + bl && y > p.top + p.h - bl)
    return near(p.left + bl, p.top + p.h - bl, bl);
  return true;
}

/**
 * Paint one figure exactly as `Figure` in muscle-figure.tsx does: the inflated
 * contour pass, the body pass, then the muscles in declaration order, each as
 * an ink contour followed by its fill.
 */
function paintFigure(side, freshnessOf, width, plate) {
  const scale = width / FIGURE_GRID.w;
  const W = Math.round(width * SS);
  const H = Math.round(FIGURE_GRID.h * scale * SS);
  const buf = Buffer.alloc(W * H * 3);
  const bg = hex(plate);
  for (let i = 0; i < W * H; i++) buf.set(bg, i * 3);

  const ink = hex(palette.ink);
  const ground = hex(palette.paperDeep);
  const neutral = hex(palette.paperHi);

  /** Blit one primitive list in a flat colour. */
  const draw = (prims, rgb, alpha) => {
    for (const p of prims) {
      const x0 = Math.max(0, Math.floor(p.left * SS));
      const x1 = Math.min(W - 1, Math.ceil((p.left + p.w) * SS));
      const y0 = Math.max(0, Math.floor(p.top * SS));
      const y1 = Math.min(H - 1, Math.ceil((p.top + p.h) * SS));
      for (let py = y0; py <= y1; py++) {
        for (let px = x0; px <= x1; px++) {
          if (!inPrim(p, (px + 0.5) / SS, (py + 0.5) / SS)) continue;
          const o = (py * W + px) * 3;
          for (let c = 0; c < 3; c++) {
            buf[o + c] = Math.round(buf[o + c] * (1 - alpha) + rgb[c] * alpha);
          }
        }
      }
    }
  };

  for (const b of FIGURE_BODY) draw(primitives(b.shape, scale, BODY_OUTLINE, BODY_BAR_POINTS), ink, 1);
  for (const b of FIGURE_BODY) {
    draw(primitives(b.shape, scale, 0, BODY_BAR_POINTS), b.neutral ? neutral : ground, 1);
  }
  for (const m of musclesFor(side)) {
    draw(primitives(m.shape, scale, MUSCLE_OUTLINE, BAR_POINTS), ink, 1);
    const f = freshnessOf(m.muscle);
    if (f == null) continue;
    const fill = freshnessFill(f);
    draw(primitives(m.shape, scale, 0, BAR_POINTS), hex(fill.color), fill.alpha);
  }
  return { buf, W, H };
}

/** Box-downsample the supersampled buffer. */
function downsample({ buf, W, H }) {
  const w = Math.floor(W / SS);
  const h = Math.floor(H / SS);
  const out = Buffer.alloc(w * h * 3);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const acc = [0, 0, 0];
      for (let dy = 0; dy < SS; dy++) {
        for (let dx = 0; dx < SS; dx++) {
          const o = ((y * SS + dy) * W + (x * SS + dx)) * 3;
          acc[0] += buf[o];
          acc[1] += buf[o + 1];
          acc[2] += buf[o + 2];
        }
      }
      const o = (y * w + x) * 3;
      for (let c = 0; c < 3; c++) out[o + c] = Math.round(acc[c] / (SS * SS));
    }
  }
  return { buf: out, W: w, H: h };
}

/** Lay several figures side by side on one plate, with a margin. */
function compose(tiles, plate, gap = 14, margin = 14) {
  const h = Math.max(...tiles.map((t) => t.H));
  const w = tiles.reduce((a, t) => a + t.W, 0) + gap * (tiles.length - 1);
  const W = w + margin * 2;
  const H = h + margin * 2;
  const out = Buffer.alloc(W * H * 3);
  const bg = hex(plate);
  for (let i = 0; i < W * H; i++) out.set(bg, i * 3);
  let x0 = margin;
  for (const t of tiles) {
    for (let y = 0; y < t.H; y++) {
      for (let x = 0; x < t.W; x++) {
        const s = (y * t.W + x) * 3;
        const d = ((y + margin) * W + (x + x0)) * 3;
        out[d] = t.buf[s];
        out[d + 1] = t.buf[s + 1];
        out[d + 2] = t.buf[s + 2];
      }
    }
    x0 += t.W + gap;
  }
  return { buf: out, W, H };
}

// --- scenes ------------------------------------------------------------------

const widthArg = process.argv.indexOf('--width');
const WIDTH = widthArg > -1 ? Number(process.argv[widthArg + 1]) : 128;

/** The four readings that have to be told apart at a glance. */
const SCENES = {
  'all-fresh': () => 100,
  'back-day': (m) =>
    ({ lats: 27, upper_back: 22, biceps: 42, rear_delts: 44, traps: 60, forearms: 70 })[m] ?? 100,
  'mixed': (m) =>
    ({
      chest: 12,
      front_delts: 35,
      triceps: 48,
      quads: 66,
      glutes: 80,
      abs: 92,
      lats: 5,
      calves: 55,
    })[m] ?? 100,
  'all-spent': () => 0,
};

mkdirSync(OUT, { recursive: true });
for (const [name, reading] of Object.entries(SCENES)) {
  const front = downsample(paintFigure('front', reading, WIDTH, palette.paperHi));
  const back = downsample(paintFigure('back', reading, WIDTH, palette.paperHi));
  const sheet = compose([front, back], palette.paperHi);
  const file = resolve(OUT, `${name}-${WIDTH}.png`);
  writeFileSync(file, encodePng(sheet.buf, sheet.W, sheet.H));
  console.log(`wrote ${file}  (${sheet.W}x${sheet.H})`);
}
