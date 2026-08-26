/**
 * Render the body figure to a PNG so a human (or a model with eyes) can LOOK at
 * it — the only tool in this repo that catches the thing five rejected attempts
 * at this drawing exist because of.
 *
 * Every rejected version was defensible in the numbers and wrong on the screen,
 * because "does this read as a person" is not a property any assertion in
 * db/exercise-ai.test.mjs can hold. This script closes that loop offline: it
 * re-implements the component's paint order over a software rasteriser, at 3×
 * supersampling, and writes a PNG with `node:zlib` (no image dependency, and
 * none is going in).
 *
 * ## Rewritten for SVG (2026-08-25)
 *
 * The figure is `<Path>` elements with gradient fills now, not stacks of filled
 * `View`s, so the old scanline-of-rounded-rects rasteriser modelled nothing that
 * exists any more. This version does the three things the real renderer does:
 *
 *   1. **Flattens each bezier contour** through `flatten()` — the SAME function
 *      the test suite's geometry predicates use, so the preview and the
 *      assertions cannot disagree about where a shape is.
 *   2. **Fills by even-odd scanline with a per-pixel gradient**, evaluating the
 *      shape's {@link Shade} in object-bounding-box units exactly as SVG defines
 *      it. Without this the preview would show flat fills and would be blind to
 *      the entire point of the round.
 *   3. **Strokes by distance-to-edge**, at the same rendered point weight the
 *      component asks for, so the preview shows what a 0.62pt muscle line
 *      actually looks like at 72pt.
 *
 * It is a DEV TOOL, not a test — nothing in `npm run db:test` runs it, and it
 * asserts nothing. It is kept in the tree because the next person to touch the
 * geometry will need it.
 *
 *   node --import ./db/register-ts-hooks.mjs db/figure-preview.mjs
 *   node --import ./db/register-ts-hooks.mjs db/figure-preview.mjs --width 240
 *   node --import ./db/register-ts-hooks.mjs db/figure-preview.mjs --crop 20,34,26,34
 *
 * Writes .omc/figure-preview/*.png (gitignored scratch).
 */
import { deflateSync } from 'node:zlib';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { palette } from '../src/constants/theme.ts';
import {
  BODY_STROKE_PT,
  FIGURE_BODY,
  FIGURE_GRID,
  MUSCLE_STROKE_PT,
  NEUTRAL_STROKE_PT,
  flatten,
  freshnessFill,
  musclesFor,
  shadeColor,
  shapeBounds,
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

/** rgb Buffer (w*h*3) → PNG buffer. */
function encodePng(rgb, w, h) {
  const raw = Buffer.alloc(h * (w * 3 + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w * 3 + 1)] = 0; // filter: none
    rgb.copy(raw, y * (w * 3 + 1) + 1, y * w * 3, (y + 1) * w * 3);
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

// --- colour ------------------------------------------------------------------

const hex = (s) => [
  parseInt(s.slice(1, 3), 16),
  parseInt(s.slice(3, 5), 16),
  parseInt(s.slice(5, 7), 16),
];

/**
 * The gradient's depth at a point, in the shape's own bounding box — SVG's
 * `objectBoundingBox` semantics, which is what makes one radial `dome` stretch
 * to fit both a glute and a calf.
 */
function depthAt(shade, box, x, y) {
  const u = box.w > 0 ? (x - box.x) / box.w : 0.5;
  const v = box.h > 0 ? (y - box.y) / box.h : 0.5;
  let t;
  if (shade.kind === 'linear') {
    const dx = shade.b[0] - shade.a[0];
    const dy = shade.b[1] - shade.a[1];
    const len = dx * dx + dy * dy;
    t = len === 0 ? 0 : ((u - shade.a[0]) * dx + (v - shade.a[1]) * dy) / len;
  } else {
    const dx = u - shade.c[0];
    const dy = v - shade.c[1];
    t = Math.sqrt(dx * dx + dy * dy) / shade.r;
  }
  t = Math.max(0, Math.min(1, t));
  const stops = shade.stops;
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [a0, d0] = stops[i - 1];
      const [a1, d1] = stops[i];
      const k = a1 === a0 ? 0 : (t - a0) / (a1 - a0);
      return d0 + (d1 - d0) * k;
    }
  }
  return stops[stops.length - 1][1];
}

// --- the rasteriser ----------------------------------------------------------

const SS = 3; // supersampling factor

/** A shape's flattened outline in device pixels. */
function outlinePx(shape, scale) {
  return flatten(shape).map(([x, y]) => [x * scale * SS, y * scale * SS]);
}

/**
 * Even-odd scanline fill of a closed polygon. `colorOf(x, y)` is called per
 * covered pixel and returns an `[r, g, b]`, which is what carries the gradient.
 */
function fillPoly(buf, W, H, poly, colorOf) {
  let y0 = Infinity;
  let y1 = -Infinity;
  for (const [, y] of poly) {
    if (y < y0) y0 = y;
    if (y > y1) y1 = y;
  }
  const r0 = Math.max(0, Math.floor(y0));
  const r1 = Math.min(H - 1, Math.ceil(y1));
  const xs = [];
  for (let py = r0; py <= r1; py++) {
    const yc = py + 0.5;
    xs.length = 0;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const [xi, yi] = poly[i];
      const [xj, yj] = poly[j];
      if (yi === yj) continue;
      if (yc < Math.min(yi, yj) || yc >= Math.max(yi, yj)) continue;
      xs.push(xi + ((yc - yi) / (yj - yi)) * (xj - xi));
    }
    xs.sort((a, b) => a - b);
    for (let s = 0; s + 1 < xs.length; s += 2) {
      const a = Math.max(0, Math.ceil(xs[s] - 0.5));
      const b = Math.min(W - 1, Math.floor(xs[s + 1] - 0.5));
      for (let px = a; px <= b; px++) {
        const rgb = colorOf(px + 0.5, yc);
        const o = (py * W + px) * 3;
        buf[o] = rgb[0];
        buf[o + 1] = rgb[1];
        buf[o + 2] = rgb[2];
      }
    }
  }
}

/** Stroke a closed polygon at `width` device pixels, centred on the outline. */
function strokePoly(buf, W, H, poly, width, rgb) {
  const h = width / 2;
  const hh = h * h;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const [ax, ay] = poly[j];
    const [bx, by] = poly[i];
    const x0 = Math.max(0, Math.floor(Math.min(ax, bx) - h));
    const x1 = Math.min(W - 1, Math.ceil(Math.max(ax, bx) + h));
    const y0 = Math.max(0, Math.floor(Math.min(ay, by) - h));
    const y1 = Math.min(H - 1, Math.ceil(Math.max(ay, by) + h));
    const dx = bx - ax;
    const dy = by - ay;
    const len = dx * dx + dy * dy;
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const cx = px + 0.5;
        const cy = py + 0.5;
        let t = len === 0 ? 0 : ((cx - ax) * dx + (cy - ay) * dy) / len;
        t = Math.max(0, Math.min(1, t));
        const ex = cx - (ax + t * dx);
        const ey = cy - (ay + t * dy);
        if (ex * ex + ey * ey > hh) continue;
        const o = (py * W + px) * 3;
        buf[o] = rgb[0];
        buf[o + 1] = rgb[1];
        buf[o + 2] = rgb[2];
      }
    }
  }
}

/** A flat-colour `colorOf`. */
const flat = (rgb) => () => rgb;

/** A gradient `colorOf` over one shape's bounding box, in device pixels. */
function shaded(shade, shape, base, scale) {
  const b = shapeBounds(shape);
  const box = {
    x: b.x * scale * SS,
    y: b.y * scale * SS,
    w: b.w * scale * SS,
    h: b.h * scale * SS,
  };
  const cache = new Map();
  return (x, y) => {
    const d = depthAt(shade, box, x, y);
    const key = Math.round(d * 255);
    let rgb = cache.get(key);
    if (!rgb) {
      rgb = hex(shadeColor(base, key / 255));
      cache.set(key, rgb);
    }
    return rgb;
  };
}

/**
 * Paint one figure exactly as `Figure` in muscle-figure.tsx does: the contour
 * pass over the whole body, the fill pass over the whole body, then the muscles
 * in declaration order, each a gradient fill inside an ink hairline.
 */
function paintFigure(side, freshnessOf, width, plate) {
  const scale = width / FIGURE_GRID.w;
  const W = Math.round(width * SS);
  const H = Math.round(FIGURE_GRID.h * scale * SS);
  const buf = Buffer.alloc(W * H * 3);
  const bg = hex(plate);
  for (let i = 0; i < W * H; i++) buf.set(bg, i * 3);

  const ink = hex(palette.ink);
  const ground = palette.paperDeep;
  const neutral = hex(palette.paperHi);
  const px = (pt) => pt * SS; // one rendered point, in supersampled device px

  // Pass 1 — the silhouette's contour. Stroked at DOUBLE weight so that after
  // the fills over-paint the inner half, one BODY_STROKE_PT line survives on the
  // outside and every internal seam is gone.
  for (const b of FIGURE_BODY) {
    strokePoly(buf, W, H, outlinePx(b.shape, scale), px(BODY_STROKE_PT * 2), ink);
  }
  // Pass 2 — the body. Muscle ground shaded as a soft cylinder; head, hands and
  // feet FLAT in the plate colour, because they are not data — and outlined in
  // this pass too, which is what puts a wrist, an ankle and a jaw line in.
  for (const b of FIGURE_BODY) {
    const poly = outlinePx(b.shape, scale);
    fillPoly(buf, W, H, poly, b.neutral ? flat(neutral) : shaded(b.shade, b.shape, ground, scale));
    if (b.neutral) strokePoly(buf, W, H, poly, px(NEUTRAL_STROKE_PT), ink);
  }

  // Pass 3 — the muscles, every one of them, in declaration order.
  for (const m of musclesFor(side)) {
    const poly = outlinePx(m.shape, scale);
    const f = freshnessOf(m.muscle);
    if (f != null) {
      fillPoly(buf, W, H, poly, shaded(m.shade, m.shape, freshnessFill(f).color, scale));
    }
    strokePoly(buf, W, H, poly, px(MUSCLE_STROKE_PT), ink);
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

/**
 * `--crop x,y,w,h` in GRID units — cut one region out of the composed sheet and
 * blow it up, because a shoulder is forty pixels tall in a full-figure PNG and
 * "look at the drawing" only works if the drawing is legible. The rect is read
 * on the FRONT figure's grid; the back figure sits one figure-width plus the gap
 * to its right, so the same rect lands on the same anatomy on both.
 */
const cropArg = process.argv.indexOf('--crop');
const CROP = cropArg > -1 ? process.argv[cropArg + 1].split(',').map(Number) : null;

/** Nearest-neighbour blow-up of a region. */
function cropZoom({ buf, W, H }, rect, scale, zoom) {
  const x0 = Math.max(0, Math.round(rect[0] * scale) + 14);
  const y0 = Math.max(0, Math.round(rect[1] * scale) + 14);
  const w = Math.min(W - x0, Math.round(rect[2] * scale));
  const h = Math.min(H - y0, Math.round(rect[3] * scale));
  const oW = w * zoom;
  const oH = h * zoom;
  const out = Buffer.alloc(oW * oH * 3);
  for (let y = 0; y < oH; y++) {
    for (let x = 0; x < oW; x++) {
      const s = ((y0 + Math.floor(y / zoom)) * W + (x0 + Math.floor(x / zoom))) * 3;
      const d = (y * oW + x) * 3;
      out[d] = buf[s];
      out[d + 1] = buf[s + 1];
      out[d + 2] = buf[s + 2];
    }
  }
  return { buf: out, W: oW, H: oH };
}

/** The four readings that have to be told apart at a glance. */
const SCENES = {
  'all-fresh': () => 100,
  'back-day': (m) =>
    ({ lats: 27, upper_back: 22, biceps: 42, rear_delts: 44, traps: 60, forearms: 70 })[m] ?? 100,
  mixed: (m) =>
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
  let sheet = compose([front, back], palette.paperHi);
  let tag = `${WIDTH}`;
  if (CROP) {
    const scale = WIDTH / FIGURE_GRID.w;
    const wide = [CROP[0], CROP[1], CROP[2] + FIGURE_GRID.w + 14 / scale, CROP[3]];
    sheet = cropZoom(sheet, wide, scale, 4);
    tag = `${WIDTH}-crop`;
  }
  const file = resolve(OUT, `${name}-${tag}.png`);
  writeFileSync(file, encodePng(sheet.buf, sheet.W, sheet.H));
  console.log(`wrote ${file}  (${sheet.W}x${sheet.H})`);
}
