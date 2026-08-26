/**
 * The lab-PDF extraction seam: a Function Health report → structured biomarker
 * results. This is the labs sub-app's ONE model touchpoint, and — like the
 * nutrition estimator — it REUSES the Coach's on-device model client
 * (`src/lib/ai/model-client.ts`'s `runCoachTurn`), never a second HTTP stack:
 *
 *   1. {@link buildLabParseRequest} builds the `AgenticRequest` the client
 *      consumes: a base64 `document` content block (the Messages API's native
 *      PDF input — no client-side PDF library, no OCR) followed by the
 *      instruction text.
 *   2. {@link extractLabReport} runs that request through `runCoachTurn` with no
 *      tools, using the same Keychain key (`api-key-store`) and streaming fetch
 *      (`expo/fetch`) as Coach chat, then {@link parseLabExtraction} validates
 *      the strict-JSON reply.
 *   3. The caller maps the result against the catalog (`map.ts`) and lands it in
 *      an EDITABLE REVIEW the user confirms. A parsed value is a *proposal*
 *      until then — nothing is ever auto-committed (docs/labs-subapp.md §4).
 *
 * ONLINE-EXCEPT-AI: this parse is the only step that leaves the device. Picking
 * the file, mapping, reviewing, and storing are all offline.
 *
 * `expo/fetch` is loaded through a guarded require (like api-key-store's) so
 * this module — whose pure builder/parser the headless tests import — never
 * fails to load in node, where the native/Expo fetch is absent.
 */
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { type FetchLike, runCoachTurn, type WireMessage } from '@/lib/ai/model-client';
import type { BiomarkerCategory } from '@/lib/db/types';

import type { ExtractedResult, LabExtraction, QualitativeResult, ResultQualifier } from './types';

/**
 * Output cap for one extraction turn. Far above the Coach's chat-sized 8192
 * default: a Function panel is 100+ markers (~40 output tokens each once the
 * JSON envelope is counted), and on the default model thinking shares this same
 * budget — so a chat-sized cap would truncate the reply mid-panel. The client
 * always streams, which is what makes a cap this large safe from HTTP timeouts.
 */
const LAB_PARSE_MAX_TOKENS = 32000;

/**
 * Refuse a PDF whose base64 would approach the API's 32 MB request ceiling.
 * Base64 inflates by 4/3, and the request also carries the prompt, so 18 MB of
 * PDF (~24 MB encoded) leaves comfortable headroom. A real lab report is well
 * under 5 MB; anything past this is a scanned-at-600dpi accident, and failing
 * here with a clear message beats a 413 from the API.
 */
export const MAX_LAB_PDF_BYTES = 18 * 1024 * 1024;

/** Thrown when no model key is configured (the UI points the user to Settings). */
export class LabParseUnavailableError extends Error {
  constructor() {
    super('Parsing a lab PDF needs a model key — set one in the Coach settings.');
    this.name = 'LabParseUnavailableError';
  }
}

/** Thrown for a PDF the pipeline won't send (too large, or empty). */
export class LabPdfRejectedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'LabPdfRejectedError';
  }
}

/**
 * Whether the parse path can run — a model key is configured (the same key the
 * Coach uses). The UI reads this to keep the "Import a PDF" affordance honest;
 * re-render via the Coach's `useSessionKeySet()` so it stays current.
 */
export function isLabParsingAvailable(): boolean {
  return apiKeyStore.has();
}

/**
 * `expo/fetch` streams response bodies in React Native (the global fetch there
 * does not). Loaded through a guarded require so the node test loader — which
 * imports this module's pure functions — never fails on the missing module.
 */
function loadStreamingFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo/fetch') as { fetch?: unknown };
    return (mod.fetch ?? null) as FetchLike | null;
  } catch {
    return null;
  }
}

// --- The request the Coach client consumes -----------------------------------
//
// The model client's WireContentBlock carries a document as an opaque block, so
// buildLabParseRequest's output is cast to WireMessage[] at the call site in
// extractLabReport — the shapes match the Anthropic document wire format 1:1.

export type DocTextBlock = { type: 'text'; text: string };
export type DocPdfBlock = {
  type: 'document';
  source: { type: 'base64'; media_type: 'application/pdf'; data: string };
};
export type DocContentBlock = DocTextBlock | DocPdfBlock;

export type LabParseRequest = {
  system: string;
  messages: { role: 'user'; content: DocContentBlock[] }[];
};

/**
 * The extraction system prompt. Four things it has to get right, each learned
 * from how these reports are actually laid out (docs/labs-subapp.md §1):
 *   * ONE row per biomarker, from the CURRENT draw only — these reports print
 *     prior results beside the new one, and silently importing a two-year-old
 *     column as today's value is the worst failure this pipeline has;
 *   * names and units VERBATIM, because the mapping layer owns normalization
 *     and a "helpfully" converted value would be converted twice;
 *   * a censored result ("<5") reported as its numeric bound plus a qualifier,
 *     rather than dropped or invented;
 *   * omission over guessing — a missing marker is visible in review, a
 *     hallucinated one is not.
 */
export const LAB_EXTRACTION_SYSTEM_PROMPT = [
  'You extract biomarker results from a laboratory report PDF for a personal health',
  'record. You are a careful transcriber, not an interpreter: report exactly what the',
  'document says.',
  '',
  'Rules:',
  '- Extract EVERY biomarker result in the report, one entry per marker.',
  '- Use the CURRENT draw only. These reports often print previous results, historical',
  '  columns, or trend charts beside the new value — ignore all of them. If you cannot',
  '  tell which column is current, omit that marker and say so in notes.',
  '- Copy the marker "name" VERBATIM as printed, including any qualifier that is part of',
  '  it ("Testosterone, Free" is not "Testosterone"). Do not expand, abbreviate, or',
  '  rename. Downstream code maps these names to its own catalog.',
  '- Copy "unit" VERBATIM as printed (e.g. "mg/dL", "nmol/L", "%"). Never convert a value',
  '  into a different unit — downstream code does that. Use null when no unit is printed.',
  '- "value" is a plain number. Strip any abnormal-flag letter printed against it — a',
  '  cell reading "92 H" or "4.1L" is the value 92 or 4.1, never 92 or 4.1 with an H or L.',
  '- For a censored result like "<5" or ">150", put the bound in "value" (5, 150) and set',
  '  "qualifier" to "<" or ">". Otherwise qualifier is null.',
  '- For a result reported in WORDS rather than a number — "Negative", "Yellow", "Clear",',
  '  "Not Detected", a urinalysis descriptor — set "value" to null and put the printed',
  '  words in "value_text". Report these; do not skip them and do not invent a number.',
  '- "ref_low"/"ref_high" are the reference range printed for that marker, as numbers.',
  '  A one-sided range ("<100") sets only the bound it states; use null for the other.',
  '  Use null for both when no range is printed.',
  '- "category" is your best fit from EXACTLY this list: cardiovascular, metabolic,',
  '  hormone, inflammation, nutrient, organ, immune, hematology, cancer, toxin,',
  '  microbiome, biological_age, other. Liver, kidney and urinalysis markers are "organ";',
  '  thyroid and sex hormones are "hormone"; heavy metals are "toxin".',
  '- "collected_on" is the date the SAMPLE WAS DRAWN. A US lab report prints up to three',
  '  dates — collected, received, reported — and they can differ by weeks. Use the',
  '  COLLECTED date; never substitute another. Source dates are US MM/DD/YYYY; return',
  '  YYYY-MM-DD. Use null if you cannot find a collection date.',
  '- Extract ONLY from result rows and tables. These reports carry written commentary that',
  '  quotes markers and numbers inline ("Your ApoB of 92 is above optimal") — that prose is',
  '  never a result. Ignore narrative, summaries, and interpretation sections entirely.',
  '- Skip rows with no result at all: pending, cancelled, "not reported", TNP, QNS.',
  '  Never invent a value, a unit, or a marker that is not there.',
  '- Put anything the reader should know in "notes": pages you could not read, markers you',
  '  deliberately skipped, an ambiguous draw date, or a report that looks truncated.',
  '',
  'Respond with ONLY a JSON object, no prose, matching:',
  '{"collected_on": string|null, "lab_name": string|null, "results": [{"name": string,',
  ' "value": number|null, "value_text": string|null, "unit": string|null,',
  ' "qualifier": "<"|">"|null, "ref_low": number|null, "ref_high": number|null,',
  ' "category": string}], "notes": string|null}',
].join('\n');

/**
 * Build the model request for one report — the exact shape `runCoachTurn`
 * takes (system + messages, no tools). The document block goes before the text,
 * as the document-understanding docs recommend.
 */
export function buildLabParseRequest(base64Pdf: string): LabParseRequest {
  return {
    system: LAB_EXTRACTION_SYSTEM_PROMPT,
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: base64Pdf },
          },
          {
            type: 'text',
            text: 'Extract every biomarker result from this lab report as JSON.',
          },
        ],
      },
    ],
  };
}

// --- Reply validation (pure, headless-tested) --------------------------------

const CATEGORIES: BiomarkerCategory[] = [
  'cardiovascular',
  'metabolic',
  'hormone',
  'inflammation',
  'nutrient',
  'organ',
  'immune',
  'hematology',
  'cancer',
  'toxin',
  'microbiome',
  'biological_age',
  'other',
];

/** A finite number, or null. Lab values may legitimately be 0 or negative
 * (base excess), so no sign constraint — only finiteness.
 *
 * Also recovers a finite number emitted as a JSON STRING ("5.4", "92"): despite
 * the prompt's "value is a plain number", frontier models intermittently
 * stringify numeric fields, and dropping "5.4" would be real data loss — the
 * recovery is exact, not a guess. A non-numeric string ("Negative") stays null
 * so it still routes to value_text. */
function num(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

/**
 * A plausible `YYYY-MM-DD` draw date, or null. Shape must match the GLOB the
 * schema enforces on `collected_at`, and the date must be real — a model that
 * reads "02/30/2026" off a smudged scan must not put an impossible date into a
 * NOT NULL column. The range check (1900 → today) catches a misread year, which
 * would otherwise silently park the whole panel decades from now on the trend.
 */
export function validCollectedOn(value: unknown, today: string): string | null {
  const raw = text(value);
  if (raw === null || !/^\d{4}-\d{2}-\d{2}$/.test(raw)) return null;
  const [y, m, d] = raw.split('-').map(Number);
  const parsed = new Date(y!, m! - 1, d!);
  const real = parsed.getFullYear() === y && parsed.getMonth() === m! - 1 && parsed.getDate() === d;
  if (!real) return null;
  return raw >= '1900-01-01' && raw <= today ? raw : null;
}

/**
 * The outermost JSON object in a model reply, as text — tolerating ```json
 * fences and stray prose around it.
 *
 * Exported because it is what gets PERSISTED. `lab_reports.raw_extracted_json`
 * carries `CHECK (json_valid(...))`, so storing the reply verbatim would abort
 * the whole import the moment the model wrapped its answer in a fence or a
 * sentence — which is most of the time. The isolated slice is proven parseable
 * here, so the column always gets something valid and replayable.
 *
 * Throws when there is no parseable object, which is the caller's signal that
 * the extraction failed rather than returned nothing.
 */
export function isolateJsonObject(replyText: string): string {
  const start = replyText.indexOf('{');
  if (start === -1) {
    throw new Error('Lab extraction reply contained no JSON object.');
  }

  // Balanced-brace scan from the first '{': stop at the matching close, so a
  // trailing note that itself contains a brace ("could not read {marker X}")
  // doesn't drag the slice past the object. String-aware, because a brace inside
  // a JSON string value must not shift the depth. This is the whole tolerance
  // the docstring promises; the first-'{'-to-last-'}' fallback below only runs
  // when the scan finds nothing parseable.
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < replyText.length; i++) {
    const ch = replyText[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}') {
      depth--;
      if (depth === 0) {
        const scanned = replyText.slice(start, i + 1);
        try {
          JSON.parse(scanned);
          return scanned;
        } catch {
          break;
        }
      }
    }
  }

  // Fallback: the widest slice, for a reply the scan couldn't balance.
  const end = replyText.lastIndexOf('}');
  if (end <= start) {
    throw new Error('Lab extraction reply contained no JSON object.');
  }
  const slice = replyText.slice(start, end + 1);
  try {
    JSON.parse(slice);
  } catch {
    throw new Error('Lab extraction reply was not valid JSON.');
  }
  return slice;
}

/**
 * Parse and validate the model's JSON reply into a {@link LabExtraction}. Never
 * trusts the model's shape: a row without a usable name or a finite value is
 * dropped (rather than becoming a 0 on a trend line), an unknown category falls
 * back to 'other', an impossible date becomes null so the review screen asks
 * for one, and a reply with no usable rows throws so the caller can say the
 * import failed instead of committing an empty report.
 *
 * Tolerant of a reply wrapped in ```json fences or surrounded by stray prose —
 * it extracts the outermost JSON object first.
 */
export function parseLabExtraction(replyText: string, today: string): LabExtraction {
  const raw = JSON.parse(isolateJsonObject(replyText)) as unknown;
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error('Lab extraction reply was not a JSON object.');
  }

  const obj = raw as Record<string, unknown>;
  const rawResults = Array.isArray(obj.results) ? obj.results : [];
  const results: ExtractedResult[] = [];
  const qualitative: QualitativeResult[] = [];

  for (const entry of rawResults) {
    if (typeof entry !== 'object' || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const name = text(e.name);
    // A row with no name can't be mapped to anything.
    if (name === null) continue;

    const value = num(e.value);
    if (value === null) {
      // Word-valued (urinalysis descriptors, "Negative"). Not importable —
      // `lab_results.value` is NOT NULL real — but kept visible rather than
      // silently discarded. A row with neither a number nor words is noise.
      const valueText = text(e.value_text);
      if (valueText !== null) qualitative.push({ name, text: valueText });
      continue;
    }

    const category = CATEGORIES.includes(e.category as BiomarkerCategory)
      ? (e.category as BiomarkerCategory)
      : null;
    const refLow = num(e.ref_low);
    const refHigh = num(e.ref_high);
    const qualifier: ResultQualifier | null =
      e.qualifier === '<' || e.qualifier === '>' ? e.qualifier : null;

    results.push({
      name,
      value,
      qualifier,
      unit: text(e.unit),
      // The schema's CHECK requires low <= high; a transposed pair is the
      // model's error, not the user's, so drop the range rather than the row.
      refLow: refLow !== null && refHigh !== null && refLow > refHigh ? null : refLow,
      refHigh: refLow !== null && refHigh !== null && refLow > refHigh ? null : refHigh,
      category,
    });
  }

  if (results.length === 0) {
    throw new Error('No biomarker results were found in that PDF.');
  }

  return {
    collectedOn: validCollectedOn(obj.collected_on, today),
    labName: text(obj.lab_name),
    results,
    qualitative,
    notes: text(obj.notes),
  };
}

// --- The one online call -----------------------------------------------------

/**
 * Extract one lab report — a single turn through the Coach's model client (no
 * tools). Throws {@link LabParseUnavailableError} when no key is set or the
 * streaming fetch is absent, and {@link LabPdfRejectedError} for a file the
 * pipeline won't send; the caller shows an honest message for each. The result
 * is NOT stored — the caller maps it and lands it in a review the user confirms.
 *
 * Returns the model's JSON alongside the parsed extraction so the caller can
 * persist it to `lab_reports.raw_extracted_json` — a better parser can then be
 * replayed over it without asking the user to re-import the PDF. It is the
 * ISOLATED object, not the reply text, because that column is json_valid-checked.
 */
export async function extractLabReport(
  base64Pdf: string,
  today: string,
  signal?: AbortSignal
): Promise<{ extraction: LabExtraction; rawJson: string }> {
  if (base64Pdf.length === 0) {
    throw new LabPdfRejectedError('That file appears to be empty.');
  }
  // base64 is 4 chars per 3 bytes — check the decoded size against the cap.
  if ((base64Pdf.length * 3) / 4 > MAX_LAB_PDF_BYTES) {
    throw new LabPdfRejectedError(
      'That PDF is too large to send (over 18 MB). Export it again at a smaller size.'
    );
  }

  const apiKey = apiKeyStore.get();
  const fetchImpl = loadStreamingFetch();
  if (!apiKey || !fetchImpl) throw new LabParseUnavailableError();

  const req = buildLabParseRequest(base64Pdf);
  let streamed = '';
  const result = await runCoachTurn(
    { apiKey, model: apiKeyStore.getModel(), fetchImpl, maxTokens: LAB_PARSE_MAX_TOKENS },
    {
      system: req.system,
      messages: req.messages as unknown as WireMessage[],
      tools: [],
    },
    {
      onToken: (chunk) => {
        streamed += chunk;
      },
      signal,
      // No tools in an extraction turn; the model answers in text.
      executeTool: async () => ({ content: '' }),
    }
  );

  if (result.stopReason === 'refusal') {
    throw new Error('The model declined to read this document.');
  }
  if (result.stopReason === 'max_tokens') {
    // A truncated reply would parse into a PARTIAL panel that looks complete —
    // the user would never know which markers went missing. Fail instead.
    throw new Error(
      'That report was too long to read in one pass — the extraction was cut off. Try a shorter PDF.'
    );
  }

  const replyText = streamed.length > 0 ? streamed : result.text;
  return {
    extraction: parseLabExtraction(replyText, today),
    rawJson: isolateJsonObject(replyText),
  };
}
