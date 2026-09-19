/**
 * Stills out of a video the user already has — the recipe importer's rung 8
 * (docs/spikes/video-recipe-import-build.md; the feasibility answer is
 * docs/spikes/video-recipe-import.md).
 *
 * **What this recovers, and what it cannot.** N frames sampled across the clip
 * go to the vision model as one turn, so ARC reads what is WRITTEN on the
 * screen: overlay cards, sticker text, the `2 tbsp` stamped on a pour, a screen
 * recording's burned-in captions. It does not hear the audio — the Messages API
 * takes no audio block and there is no on-device speech recognition in reach
 * (spike §3c) — so a quantity the cook only SAID is unrecoverable, and stays
 * null rather than being guessed. Every surface above this says so in words.
 *
 * **Guarded require, the photo-library.ts seam.** `expo-video-thumbnails` is a
 * native module and is NEW: it entered package.json with this rung, so it is in
 * no binary the owner has installed until the next EAS build. Nothing native is
 * resolved at import time — this module is reached from `app/recipe-import.tsx`,
 * whose import graph `db/screens-render.test.mjs` walks for real under Node, and
 * a static import there is a resolve failure, not a render failure. The absence
 * is {@link VideoFramesOutcome} `unavailable`: a sentence naming the two rungs
 * that still work, never a crash and never a silently dead control.
 *
 * **Nothing is downloaded and nothing is kept.** The file is one the user saved
 * themselves; the only network this rung touches is the model call. Each
 * thumbnail is a file in the cache directory, and every one of them is deleted
 * before this function returns — on the success path and on the throw alike.
 * The base64 strings are read out first, so nothing downstream ever holds a
 * cache path.
 */
import { downscaleJpeg, pickVideoAsset } from './photo-library';

// --- The dials ----------------------------------------------------------------

/**
 * The long edge each still is bounded to, in pixels — question 1(a), the
 * owner's answer: *up to 10 stills at 768 px*.
 *
 * It is this caller's dial rather than the seam's constant, exactly as the
 * workout importer's 1280 is its own (photo-library.ts): Claude bills an image
 * in 28×28 patches, so a 9:16 frame at 432×768 is 448 visual tokens and ten of
 * them are ~4.5k — about two screenshot imports for a whole video. 640 would be
 * cheaper and miss more small overlay type; 1024 is a third more for type this
 * size does not need.
 */
export const FRAME_EDGE = 768;
/** Never fewer than this many stills, however short the clip. */
export const FRAME_COUNT_MIN = 4;
/** Never more than this many, however long — the cost ceiling, and well inside
 *  the documented 20-image limit above which stricter per-image rules apply. */
export const FRAME_COUNT_CAP = 10;
/**
 * Below this many SURVIVING stills the import is `no-frames` rather than a
 * thin one. One frame is a screenshot the user could have taken themselves,
 * and the rung that does that is cheaper and sharper.
 */
export const FRAME_SURVIVOR_MIN = 2;
/** The target gap the adaptive count is derived from (spike §4's arithmetic:
 *  ten frames across a 45-second reel is one every 4.5 s). */
export const SECONDS_PER_FRAME = 4.5;
/** Under two seconds there is nothing to sample across — that is a screenshot. */
export const MIN_DURATION_S = 2;
/**
 * Five minutes. Past it, ten frames sit more than 33 s apart: a ten-second
 * overlay is likelier missed than caught, and a video that long has a
 * description the URL rung reads properly.
 */
export const MAX_DURATION_S = 300;
/**
 * ~150 KB of JPEG. A frame whose base64 exceeds it is re-encoded once at
 * {@link FRAME_RETRY_QUALITY}, and if it is STILL over it is dropped and the
 * still count falls — a cap that can never bind guards nothing.
 */
export const FRAME_BASE64_CAP = 200_000;
/** The one re-encode a fat frame gets before it is dropped. */
export const FRAME_RETRY_QUALITY = 0.45;
/**
 * What the decoder is asked for. High, deliberately: this JPEG is an
 * intermediate that {@link downscaleJpeg} immediately re-encodes at the seam's
 * own compression, and compressing twice at 0.6 would cost legibility on the
 * small overlay type this whole rung exists to read.
 */
const THUMBNAIL_QUALITY = 0.9;

// --- The arithmetic, pure -----------------------------------------------------

/**
 * How many stills a clip of this length gets: one per {@link SECONDS_PER_FRAME},
 * clamped into [{@link FRAME_COUNT_MIN}, {@link FRAME_COUNT_CAP}].
 *
 * 15 s → 4 · 45 s → 10 · three minutes → 10 (one every 20 s).
 */
export function frameCountFor(durationS: number): number {
  if (!Number.isFinite(durationS) || durationS <= 0) return FRAME_COUNT_MIN;
  const wanted = Math.ceil(durationS / SECONDS_PER_FRAME);
  return Math.min(FRAME_COUNT_CAP, Math.max(FRAME_COUNT_MIN, wanted));
}

/**
 * `n` sample times, evenly spaced from 0.5 s to `durationS − 0.5` s.
 *
 * The half-second trim at each end is not fussiness: the first frames of a reel
 * are a title card or a hard cut, and the last are the logo/outro — neither
 * carries a recipe, and both cost the same as a frame that does. Empty below
 * {@link MIN_DURATION_S}, which the caller reports as `failed`.
 */
export function frameTimesSeconds(durationS: number, n: number): number[] {
  if (!Number.isFinite(durationS) || durationS < MIN_DURATION_S) return [];
  if (!Number.isFinite(n) || n < 1) return [];
  const first = 0.5;
  const last = durationS - 0.5;
  if (last <= first) return [];
  if (n === 1) return [(first + last) / 2];
  const step = (last - first) / (n - 1);
  const times: number[] = [];
  for (let i = 0; i < n; i++) times.push(first + step * i);
  return times;
}

/**
 * The gap the import ACTUALLY sampled at — computed from the times that
 * survived, not from the ones that were asked for.
 *
 * This is the whole reason the number is computed rather than remembered. A
 * thumbnail call can throw and skip its frame; a frame over the cap is dropped.
 * Ten of ten across a 45-second reel is 4.9 s; eight survivors of that same
 * reel is 6.3 s, and printing "4.9" there would be the app stating a density it
 * did not achieve — on the one screen whose job is to say what was read.
 */
export function intervalSeconds(times: number[]): number {
  if (times.length < 2) return 0;
  return (times[times.length - 1]! - times[0]!) / (times.length - 1);
}

/** The interval as a bare number: one decimal under ten seconds, whole seconds
 *  above — below ten the tenth is the difference between 4.9 and 6.3, above it
 *  it is noise. */
export function formatIntervalNumber(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds <= 0) return '0';
  return seconds < 10 ? seconds.toFixed(1) : String(Math.round(seconds));
}

/** {@link formatIntervalNumber} with the unit — "4.9 s", "20 s". */
export function formatInterval(seconds: number): string {
  return `${formatIntervalNumber(seconds)} s`;
}

/**
 * Is this encoded frame too big to send?
 *
 * Pulled out as its own predicate so the cap is a rule with a test rather than
 * a `>` buried in a native loop no headless suite can enter. A cap that can
 * never bind guards nothing — and this one binds twice, once to trigger the
 * single re-encode and once to drop the frame that survived it.
 */
export function frameOverCap(base64: string): boolean {
  return base64.length > FRAME_BASE64_CAP;
}

/**
 * Assemble the seam's answer from the frames that actually came back.
 *
 * Pure, and separated from the decode loop for the same reason as
 * {@link frameOverCap}: the two rules that matter here — too few survivors is
 * `no-frames`, and the reported interval is measured over the SURVIVING times —
 * are the ones a dropped or unreadable frame exercises, and neither is
 * reachable from a runtime with no decoder in it.
 */
export function framesOutcome(
  framesBase64: string[],
  survivingTimes: number[],
  durationS: number
): Extract<VideoFramesOutcome, { kind: 'frames' } | { kind: 'no-frames' }> {
  if (framesBase64.length < FRAME_SURVIVOR_MIN) return { kind: 'no-frames' };
  return {
    kind: 'frames',
    framesBase64,
    stillCount: framesBase64.length,
    durationS,
    everySeconds: intervalSeconds(survivingTimes),
  };
}

/**
 * A duration as `m:ss` — "12:30", "5:30".
 *
 * Never rounded to whole minutes: the message it appears in says a video was
 * refused for its length, and "that video is 13 minutes" against a ceiling of
 * five is an approximation where the user wants the fact.
 */
export function formatClock(seconds: number): string {
  const total = Math.max(0, Math.round(Number.isFinite(seconds) ? seconds : 0));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${s < 10 ? '0' : ''}${s}`;
}

// --- The native seams ---------------------------------------------------------

type VideoThumbnailsModule = {
  getThumbnailAsync: (
    uri: string,
    options?: { time?: number; quality?: number }
  ) => Promise<{ uri: string; width: number; height: number }>;
};

/**
 * The decoder, or null on a binary without it — which is EVERY binary the owner
 * has today, until the EAS build that carries this package.
 *
 * `time` is in MILLISECONDS on this module (VideoThumbnailsTypes.types.d.ts),
 * while everything reasoning about a video in ARC is in seconds; the one
 * conversion lives at the single call site below.
 */
function loadVideoThumbnails(): VideoThumbnailsModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-video-thumbnails') as Partial<VideoThumbnailsModule>;
    if (typeof mod.getThumbnailAsync !== 'function') return null;
    return mod as VideoThumbnailsModule;
  } catch {
    return null;
  }
}

type FileHandle = { exists: boolean; delete(): void };
type FileSystemModule = { File: new (...parts: unknown[]) => FileHandle };

/** `expo-file-system`'s File API, for the cache cleanup only — the same seam
 *  src/lib/backup/backup-file-store.ts uses, declared locally as ARC reads it. */
function loadFileSystem(): FileSystemModule | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-file-system') as Partial<FileSystemModule>;
    if (typeof mod.File !== 'function') return null;
    return mod as FileSystemModule;
  } catch {
    return null;
  }
}

/** Whether this binary can decode a movie at all. False under Node and on every
 *  build predating the package — the screen renders that as a sentence. */
export function isVideoImportAvailable(): boolean {
  return loadVideoThumbnails() !== null;
}

/**
 * Delete every thumbnail this run wrote. Best-effort and silent by design: a
 * cache file that will not delete is the OS's problem, not a reason to fail an
 * import that otherwise worked.
 */
function deleteCacheFiles(uris: string[]): void {
  if (uris.length === 0) return;
  const fs = loadFileSystem();
  if (!fs) return;
  for (const uri of uris) {
    try {
      const file = new fs.File(uri);
      if (file.exists) file.delete();
    } catch {
      // Nothing to do and nothing to say.
    }
  }
}

// --- The outcome --------------------------------------------------------------

export type VideoFramesOutcome =
  | {
      kind: 'frames';
      /** Downscaled JPEGs, base64, in time order. */
      framesBase64: string[];
      /** How many SURVIVED — never the count that was asked for. */
      stillCount: number;
      durationS: number;
      /** The gap actually sampled at, from {@link intervalSeconds}. */
      everySeconds: number;
    }
  /** The user backed out of the picker, or the import was superseded. Not an
   *  error, and not a message. */
  | { kind: 'canceled' }
  /** No decoder in this binary. */
  | { kind: 'unavailable' }
  /** The pick failed, the length is unknown, or the clip is too short. */
  | { kind: 'failed' }
  /** The decoder opened it but too few frames came back to be worth a turn. */
  | { kind: 'no-frames' }
  | { kind: 'too-long'; durationS: number };

/**
 * Pick a video and read stills out of it. **Never throws** — every failure is a
 * variant the caller renders in words (docs/spikes/video-recipe-import-build.md
 * §3.5).
 *
 * `onPhase` is how the screen learns the picker resolved: it fires once with
 * *"Reading the video…"* the moment there is an asset — never before, so a
 * cancel leaves the screen exactly as it was — and again with the still count
 * once the length is known. `signal` is checked between native calls, so a
 * screenshot pick during the decode supersedes this cleanly (one decode already
 * in flight finishes unused, and its file is cleaned up like the rest).
 */
export async function pickVideoFrames(
  opts: { signal?: AbortSignal; onPhase?: (label: string) => void } = {}
): Promise<VideoFramesOutcome> {
  const thumbnails = loadVideoThumbnails();
  if (!thumbnails) return { kind: 'unavailable' };

  const picked = await pickVideoAsset();
  if (picked.kind !== 'video') return { kind: picked.kind };
  if (opts.signal?.aborted) return { kind: 'canceled' };
  opts.onPhase?.('Reading the video…');

  // No length, nothing to sample across. Guessing one would sample past the end
  // of the file and report a density ARC invented.
  if (picked.durationMs === null) return { kind: 'failed' };
  const durationS = picked.durationMs / 1000;
  if (durationS > MAX_DURATION_S) return { kind: 'too-long', durationS };

  const wanted = frameCountFor(durationS);
  const times = frameTimesSeconds(durationS, wanted);
  if (times.length === 0) return { kind: 'failed' };
  opts.onPhase?.(`Reading ${times.length} stills…`);

  const cacheUris: string[] = [];
  const framesBase64: string[] = [];
  const survivingTimes: number[] = [];
  try {
    for (const time of times) {
      if (opts.signal?.aborted) return { kind: 'canceled' };
      let thumb: { uri: string; width: number; height: number };
      try {
        thumb = await thumbnails.getThumbnailAsync(picked.uri, {
          time: Math.round(time * 1000),
          quality: THUMBNAIL_QUALITY,
        });
      } catch {
        // One unreadable seek is a frame lost, not an import lost — the
        // interval below is computed from what survived.
        continue;
      }
      if (typeof thumb?.uri !== 'string' || thumb.uri === '') continue;
      cacheUris.push(thumb.uri);
      if (opts.signal?.aborted) return { kind: 'canceled' };

      // The decoder reports the frame's real dimensions, so the long edge is
      // KNOWN here and the downscale never guesses-then-corrects.
      const source = { width: thumb.width, height: thumb.height };
      let shrunk = await downscaleJpeg(thumb.uri, { maxEdge: FRAME_EDGE, source });
      if (!shrunk) continue;
      if (frameOverCap(shrunk.base64Jpeg)) {
        // One re-encode, from the ORIGINAL thumbnail rather than the shrunk
        // copy — re-compressing a compressed JPEG compounds the loss on exactly
        // the small overlay type this rung is reading.
        const retried = await downscaleJpeg(thumb.uri, {
          maxEdge: FRAME_EDGE,
          source,
          quality: FRAME_RETRY_QUALITY,
        });
        shrunk = retried && !frameOverCap(retried.base64Jpeg) ? retried : null;
      }
      if (!shrunk) continue;
      framesBase64.push(shrunk.base64Jpeg);
      survivingTimes.push(time);
    }
  } finally {
    // Every file this run wrote, on the success path and the throw alike. The
    // base64 is already out, so nothing downstream holds a cache path.
    deleteCacheFiles(cacheUris);
  }

  if (opts.signal?.aborted) return { kind: 'canceled' };
  return framesOutcome(framesBase64, survivingTimes, durationS);
}
