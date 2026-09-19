/**
 * Prose for a video-stills outcome that produced no frames — the video rung's
 * counterpart to share-payload.ts, and the same DB-free, pure, "a payload ARC
 * cannot use must still ARRIVE" role.
 *
 * It lives under `src/lib/recipes/` rather than in the screen because the
 * screen's `Phase` is route-local and unexported, nothing under `src/` may
 * import from `app/`, and the mapping is worth pinning without rendering
 * anything. The screen maps the result to a `Phase` at the call site.
 *
 * Every message names the two rungs that DO work. A dead end that only says no
 * is the failure this whole ladder is built to avoid.
 */
import { formatClock, MAX_DURATION_S, type VideoFramesOutcome } from '@/lib/media/video-frames';

/** What the screen shows, or null when there is nothing to say. */
export type VideoOutcomeMessage = { message: string; suggestPaste: boolean };

const FALLBACKS = 'Share a screenshot of the ingredient list, or paste the caption.';

/**
 * Map a non-`frames` outcome to the sentence the screen prints.
 *
 * Null means *say nothing and change nothing*: a cancel is not an error, and
 * `frames` is the success the caller handles itself.
 *
 * The `unavailable` wording promises a build rather than a feature. It is the
 * screenshot rung's own shape (app/recipe-import.tsx) and it is literally true
 * here — `expo-video-thumbnails` entered package.json with this rung, so no
 * binary the owner has installed can decode a movie until the next EAS build.
 */
export function videoOutcomeMessage(outcome: VideoFramesOutcome): VideoOutcomeMessage | null {
  switch (outcome.kind) {
    case 'frames':
    case 'canceled':
      return null;
    case 'unavailable':
      return { message: `Video import needs the next app build. ${FALLBACKS}`, suggestPaste: true };
    case 'too-long':
      return {
        message: `That video is ${formatClock(outcome.durationS)} long — ARC reads up to ${MAX_DURATION_S / 60} minutes. ${FALLBACKS}`,
        suggestPaste: true,
      };
    // `failed` and `no-frames` differ in where they broke and in nothing the
    // user can act on: the picker refused, the length was unknown, the decoder
    // could not open the file, or too few frames survived. One sentence.
    case 'failed':
    case 'no-frames':
      return { message: `Couldn’t read that video — ${FALLBACKS}`, suggestPaste: true };
  }
}
