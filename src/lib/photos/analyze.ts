/**
 * The on-demand AI reading of a progress photo — **never automatic**
 * (docs/progress-photos-subapp.md §5).
 *
 * Two entry points, both user-initiated: "Read this photo" on the detail screen
 * and "Compare these two" on the compare screen. The mechanics are the
 * meal-estimate / labs contract exactly — one online step, a review before
 * anything persists:
 *
 *   tap ▶ privacy line + Send ──▶ runCoachTurn (ONLINE, one turn, NO tools)
 *      ──▶ REVIEW (offline) ──▶ Save → a progress_photo_analyses row
 *                            ·  Discard → nothing written
 *
 * It REUSES the Coach's model client, never a second HTTP/model stack: same key
 * out of the iOS Keychain (`api-key-store`), same model picker, same streaming
 * fetch. `expo/fetch` is loaded through a guarded require (estimate.ts's
 * pattern) so this module — whose pure builder and parser the headless suite
 * imports — never fails to load under node.
 *
 * ## What this file refuses to do
 *
 * **No numeric body-composition estimates.** Owner call, 2026-08-12, and it is a
 * deliberate asymmetry with meal-estimate's ≈-labelled numbers: visual body-fat
 * estimation is ±5 points on a good day, and a plausible wrong percentage filed
 * next to a trend surface is the exact hazard the labs mapper exists to prevent.
 * The prompt forbids it and {@link parsePhotoReading} has no field to put one in,
 * so a model that volunteers a number has it dropped on the floor rather than
 * rendered.
 *
 * **No invented numbers of any kind.** ARC supplies the numeric truth — the
 * dates, the poses, the nearest weigh-in AND ITS DISTANCE, in the same words the
 * screen printed. The model's job is eyes.
 *
 * **No reading without caveats.** Lighting, pose and angle differences are THE
 * failure mode of photo comparison. The prompt demands them, the parser refuses
 * a reply that omits them, and the column is NOT NULL.
 */
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';

import { formatPhotoDate, poseLabel } from './format';
import type {
  ChangeDirection,
  PhotoChange,
  PhotoObservation,
  PhotoPose,
  PhotoReading,
} from './types';

/**
 * The line shown above the Send control **every time**, verbatim.
 *
 * Specific, not boilerplate (the labs §4 wording discipline): it names what
 * leaves (the downscaled copies, the dates, the weights), where it goes (the
 * provider configured under the user's own key), and what rests in a cloud
 * afterwards (nothing).
 */
export const PHOTO_ANALYSIS_PRIVACY_LINE =
  'These photos leave your phone for this one reading — sent to your model provider under your ' +
  'key. Nothing is stored anywhere but here.';

/** One photo as the model is shown it: the pixels plus ARC's own numeric truth. */
export type ReadingSubject = {
  /** The working copy, downscaled to 1024px — the same pass every vision path
   *  in this app uses (`downscaleToJpegBase64`). */
  base64Jpeg: string;
  takenOn: string;
  pose: PhotoPose;
  /**
   * The weigh-in caption **exactly as the screen printed it**, distance clause
   * and all — or the authored empty. Passing the rendered string rather than a
   * number is the point: the model must never see a weight without knowing how
   * far from the photo it was measured, and the user must never be shown a
   * caption the model did not get.
   */
  weighIn: string;
  notes?: string | null;
};

export type PhotoReadingInput =
  | { kind: 'single'; photo: ReadingSubject }
  | { kind: 'pair'; earlier: ReadingSubject; later: ReadingSubject };

/** Thrown when no model key is configured (the UI points the user to Settings). */
export class PhotoReadingUnavailableError extends Error {
  constructor() {
    super('Reading a photo needs a model key — set one in the Coach settings.');
    this.name = 'PhotoReadingUnavailableError';
  }
}

/**
 * Whether a reading can run — a model key is configured (the same key the Coach
 * uses). The screens read this to keep the affordance honest; re-render via the
 * Coach's `useSessionKeySet()` so it stays current.
 */
export function isPhotoReadingAvailable(): boolean {
  return apiKeyStore.has();
}

function loadStreamingFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo/fetch') as { fetch?: unknown };
    return (mod.fetch ?? null) as FetchLike | null;
  } catch {
    return null;
  }
}

// --- The request -------------------------------------------------------------

type VisionTextBlock = { type: 'text'; text: string };
type VisionImageBlock = {
  type: 'image';
  source: { type: 'base64'; media_type: 'image/jpeg'; data: string };
};
export type VisionContentBlock = VisionTextBlock | VisionImageBlock;

export type PhotoReadingRequest = {
  system: string;
  messages: { role: 'user'; content: VisionContentBlock[] }[];
};

/**
 * The reading system prompt.
 *
 * Its whole job is restraint. The failure mode is not a dull observation, it is
 * a confident number — a body-fat percentage, a kilogram of "muscle gained", a
 * measurement in centimetres — produced from pixels that cannot support any of
 * them, and then filed beside real measurements where it reads as one.
 */
export const PHOTO_READING_SYSTEM_PROMPT = [
  'You read body-progress photographs for the owner of a longevity operating system. You are',
  'their coach: calm, precise, evidence-seeking, and unwilling to say more than the image',
  'supports.',
  '',
  'Rules:',
  '- Qualitative observations ONLY. Never output a body-fat percentage, a weight, a body-',
  '  composition figure, a measurement in centimetres or inches, or any other number of your',
  '  own. Visual body-fat estimation is wrong by several points on a good day, and a number',
  '  filed next to real measurements will be read as one.',
  '- You must not invent numbers. Any figure you refer to must be one that was given to you',
  '  above — the dates, and the weigh-ins with their stated distance from the photo. If a',
  '  weigh-in was not measured on the same day, say so when you use it.',
  '- Describe what is actually visible, by area: shoulders, chest, arms, midsection, waist,',
  '  back, legs. Say "not visible in this framing" rather than guessing at an area.',
  '- For two photos, state the direction of change per area as one of: leaner, fuller,',
  '  unchanged, unclear. "Unclear" is the honest answer whenever lighting, pose or angle',
  '  could account for what you are seeing, and it is expected to appear often.',
  '- CAVEATS ARE MANDATORY. Name the specific things about THESE images that limit the',
  '  reading — lighting, distance from camera, stance, angle, pump, time of day, clothing.',
  '  A reading with no caveats is not acceptable.',
  '- Never give medical advice, never diagnose, and never comment on appearance in any way',
  '  that is not about training and body composition.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"summary": string, "observations": [{"area": string, "note": string}],',
  ' "changes": [{"area": string, "direction": "leaner"|"fuller"|"unchanged"|"unclear",',
  ' "note": string}], "caveats": string, "confidence": "high"|"medium"|"low"}',
  '',
  'For a single photo, "changes" must be an empty array — there is nothing to compare it to.',
].join('\n');

/** The facts that ride beside one image, in the order a reader would want them. */
function subjectLines(subject: ReadingSubject): string {
  const parts = [formatPhotoDate(subject.takenOn), poseLabel(subject.pose), subject.weighIn];
  const notes = subject.notes?.trim();
  return notes ? `${parts.join(' · ')}\nOwner's note: ${notes}` : parts.join(' · ');
}

/**
 * Build the model request — the exact shape `runCoachTurn` takes (system +
 * messages, no tools).
 *
 * A single photo puts the image first and the facts after it, as the vision docs
 * recommend and as `buildMealEstimationRequest` already does. A PAIR labels each
 * image in text immediately BEFORE it, which is the documented way to keep a
 * multi-image prompt unambiguous: without the labels the model has two pictures
 * and no reliable way to say which is which, and a comparison that gets the
 * direction backwards is worse than no comparison at all.
 */
export function buildPhotoReadingRequest(input: PhotoReadingInput): PhotoReadingRequest {
  const image = (data: string): VisionImageBlock => ({
    type: 'image',
    source: { type: 'base64', media_type: 'image/jpeg', data },
  });
  const text = (value: string): VisionTextBlock => ({ type: 'text', text: value });

  const content: VisionContentBlock[] =
    input.kind === 'single'
      ? [
          image(input.photo.base64Jpeg),
          text(
            `This photograph.\n${subjectLines(input.photo)}\n\n` +
              'Read it: what is visible, area by area. There is nothing to compare it against, ' +
              'so "changes" must be empty.'
          ),
        ]
      : [
          text(`Image 1 — the EARLIER photograph.\n${subjectLines(input.earlier)}`),
          image(input.earlier.base64Jpeg),
          text(`Image 2 — the LATER photograph.\n${subjectLines(input.later)}`),
          image(input.later.base64Jpeg),
          text(
            'Compare Image 2 against Image 1, in that direction: what changed between the ' +
              'earlier photograph and the later one.'
          ),
        ];

  return { system: PHOTO_READING_SYSTEM_PROMPT, messages: [{ role: 'user', content }] };
}

// --- The parse ---------------------------------------------------------------

const DIRECTIONS: ChangeDirection[] = ['leaner', 'fuller', 'unchanged', 'unclear'];
const CONFIDENCES = ['high', 'medium', 'low'] as const;

function trimmed(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * Parse and validate the model's JSON reply. Never trusts the model's shape:
 * unknown fields are dropped, junk array entries are skipped, an unknown
 * direction degrades to `unclear` and an unknown confidence to `null` (surface
 * uncertainty, never manufacture it).
 *
 * **Three things make it throw**, and each one is a reading that must not reach
 * the review screen at all:
 *
 *   - no JSON object in the reply;
 *   - no summary — there is nothing to show;
 *   - **no caveats** — the reading is refused outright. This is the rule the
 *     whole feature's honesty rests on, and it is enforced here as well as in
 *     the prompt and in the schema, because a prompt is a request and a CHECK
 *     only fires at the very end.
 *
 * Tolerant of a reply wrapped in ```json fences or surrounded by stray prose —
 * it extracts the outermost JSON object first, exactly like
 * {@link parseMealEstimate}.
 */
export function parsePhotoReading(replyText: string): PhotoReading {
  const start = replyText.indexOf('{');
  const end = replyText.lastIndexOf('}');
  if (start === -1 || end <= start) {
    throw new Error('The reading contained no JSON object.');
  }
  let raw: unknown;
  try {
    raw = JSON.parse(replyText.slice(start, end + 1));
  } catch {
    throw new Error('The reading was not valid JSON.');
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('The reading was not a JSON object.');
  }
  const obj = raw as Record<string, unknown>;

  const summary = trimmed(obj.summary);
  if (!summary) throw new Error('The reading had no summary.');

  const caveats = trimmed(obj.caveats);
  if (!caveats) {
    throw new Error(
      'The reading named no caveats, so it was refused — lighting, pose and angle are what ' +
        'make a photo comparison wrong.'
    );
  }

  const confidence = CONFIDENCES.includes(obj.confidence as (typeof CONFIDENCES)[number])
    ? (obj.confidence as 'high' | 'medium' | 'low')
    : null;

  return {
    summary,
    observations: parseObservations(obj.observations),
    changes: parseChanges(obj.changes),
    caveats,
    confidence,
  };
}

/** Junk entries are dropped rather than rendered — an observation with no area
 *  or no note is not an observation. */
export function parseObservations(value: unknown): PhotoObservation[] {
  const out: PhotoObservation[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const area = trimmed(e.area);
    const note = trimmed(e.note);
    if (!area || !note) continue;
    out.push({ area, note });
  }
  return out;
}

/** An unknown direction degrades to `unclear` — surfacing uncertainty is the
 *  whole point of having that value. */
export function parseChanges(value: unknown): PhotoChange[] {
  const out: PhotoChange[] = [];
  for (const entry of Array.isArray(value) ? value : []) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const area = trimmed(e.area);
    const note = trimmed(e.note);
    if (!area || !note) continue;
    const direction = DIRECTIONS.includes(e.direction as ChangeDirection)
      ? (e.direction as ChangeDirection)
      : 'unclear';
    out.push({ area, direction, note });
  }
  return out;
}

/**
 * Read back a stored JSON column. The schema guarantees `json_valid`, not that
 * the contents still match a shape this build understands — a reading saved by
 * an older version is data, and data is parsed defensively or not at all.
 */
export function parseSavedObservations(json: string | null): PhotoObservation[] {
  return parseObservations(safeJson(json));
}

export function parseSavedChanges(json: string | null): PhotoChange[] {
  return parseChanges(safeJson(json));
}

function safeJson(json: string | null): unknown {
  if (!json) return null;
  try {
    return JSON.parse(json);
  } catch {
    return null;
  }
}

// --- The one online step -----------------------------------------------------

/**
 * Run one reading — one turn through the Coach's model client, no tools.
 *
 * Throws {@link PhotoReadingUnavailableError} when no key is set or the
 * streaming fetch is absent (pre-rebuild); the caller shows an honest "connect a
 * key" message. The result is NOT written: the caller lands it in a review the
 * user must confirm.
 *
 * `maxTokens` is chat-sized rather than panel-sized — this is prose, not a table
 * of sixty biomarkers.
 */
export const PHOTO_READING_MAX_TOKENS = 4000;

export async function readPhotos(
  input: PhotoReadingInput,
  signal?: AbortSignal
): Promise<{ reading: PhotoReading; model: string }> {
  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new PhotoReadingUnavailableError();

  const model = apiKeyStore.getModel();
  const req = buildPhotoReadingRequest(input);
  let text = '';
  const result = await runCoachTurn(
    { apiKey, model, fetchImpl, maxTokens: PHOTO_READING_MAX_TOKENS },
    { system: req.system, messages: req.messages as unknown as WireMessage[], tools: [] },
    {
      onToken: (chunk) => {
        text += chunk;
      },
      signal,
      // No tools in a reading turn; the model answers in text.
      executeTool: async () => ({ content: '' }),
    }
  );
  if (result.stopReason === 'refusal') {
    throw new Error('The model declined to read these photos.');
  }
  // A truncated reply is NOT a connection problem, and saying so sends the user
  // to retry a working connection forever. `max_tokens` covers both the token
  // cap and a context-window overrun (model-client.ts), and both produce JSON
  // that stops mid-object — which the parser would otherwise report as "not
  // valid JSON". Found by adversarial review, 2026-08-12.
  if (result.stopReason === 'max_tokens') {
    throw new Error(
      'The reading was cut off before it finished. Try again, or read one photo at a time.'
    );
  }
  const reading = parsePhotoReading(text.length > 0 ? text : result.text);
  // The single-vs-pair rule enforced in code, not just in the prompt. A single
  // photo has nothing to compare against, so any `changes` a model volunteered
  // are directions ('leaner'/'fuller') against a comparison that never happened
  // — and would be saved on a row with `compare_photo_id = null`, contradicting
  // the types.ts contract that changes are pair-only. Drop them here where the
  // kind is known; parsePhotoReading cannot see it.
  if (input.kind === 'single') reading.changes = [];
  return { reading, model };
}
