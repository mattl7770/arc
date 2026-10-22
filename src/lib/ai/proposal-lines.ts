/**
 * The pass's PROPOSE and BRIEF lines — the grammar, and nothing else.
 *
 * Coach proposals (owner, 2026-10-21): the unattended pass may end its reply
 * with up to three drafted changes for him to approve, and the first pass of
 * the day writes the brief that opens Home. Both arrive as lines in the
 * model's reply, the way NUDGE lines do (src/lib/notifications/nudge-plan.ts),
 * and both are instructions to CODE: what is drafted, validated and drawn is
 * proposals.ts's job, and the brief's provenance check is too. This module only
 * takes the reply apart.
 *
 *   PROPOSE [until HH:MM] [finding <id>] tool_name {"json": "input"} reason
 *   BRIEF one line of the morning brief
 *
 * The same two lessons as the nudge parser, applied again:
 *
 *   EVERY RECOGNISED LINE LEAVES THE TEXT, parsed or not. A half-formed
 *   `PROPOSE adjust today…` that reached the thread would be the Coach's
 *   machinery shipped as its own words — the isPassSkip lesson. Dropped and
 *   counted, never guessed at.
 *
 *   THE SCAFFOLDING GOES WITH THEM. A fence, a rule or a short label
 *   ("Proposals:") left behind under a SKIP is what the note would end on, and
 *   the pass would read as spoken. {@link stripScaffolding} is the nudge
 *   parser's rule, kept as its own copy so neither file has to change for the
 *   other.
 *
 * The keyword is case-sensitive and must be the line's first word, after any
 * bullet, list number, quote mark or emphasis: "Propose a lighter week to him"
 * is prose that reaches the owner.
 *
 * Pure; headless-tested in db/coach-proposals.test.mjs.
 */

/** One well-formed PROPOSE line. Nothing here is validated against a tool. */
export type ProposeLine = {
  /** The tool name as written — proposals.ts decides whether it is a write. */
  tool: string;
  /** The parsed JSON object. */
  input: Record<string, unknown>;
  /** The model's one-line reason, shown under the card. */
  reason: string;
  /** "HH:MM": the draft expires then rather than at the end of the day. */
  until: string | null;
  /**
   * The record finding this draft answers (src/lib/ai/findings.ts, the hygiene
   * work), or null. A draft that cites one is refused at the tap if the
   * finding has been resolved since (proposals.ts).
   */
  finding: string | null;
  /** The line as written, for the refusal record. */
  line: string;
};

/** A line that began PROPOSE and did not parse, and why. */
export type MalformedProposeLine = {
  line: string;
  why: 'grammar' | 'json' | 'reason';
};

export type PassLines = {
  /** The reply with every PROPOSE / BRIEF line and its scaffolding taken out. */
  text: string;
  /**
   * What the reply said BEFORE its first PROPOSE / BRIEF line, scaffolding
   * removed — null when there was none. coach-pass.ts reads its last line for
   * SKIP, as it reads the nudge parser's `lead`.
   */
  lead: string | null;
  proposals: ProposeLine[];
  malformed: MalformedProposeLine[];
  /** BRIEF lines, cleaned, in the order written (empty ones dropped). */
  brief: string[];
};

/** After bullets, list numbers, quote marks and emphasis, the first word. */
const PREFIX = String.raw`^[\s>*_\`•-]*(?:\d{1,2}[.)]\s+)?[\s*_\`]*`;
const PROPOSE_LINE = new RegExp(`${PREFIX}PROPOSE(?![A-Za-z])`);
const BRIEF_LINE = new RegExp(`${PREFIX}BRIEF(?![A-Za-z])`);
const LEAD_MARKER = new RegExp(PREFIX);

/** `PROPOSE`, then the optional qualifiers in either order, then the tool name. */
const HEAD = /^PROPOSE:?\s+(.*)$/;
const UNTIL = /^until\s+(\d{1,2}):(\d{2})\s+/;
const FINDING = /^finding\s+([A-Za-z0-9:_.@-]+)\s+/;
const TOOL = /^([a-z][a-z0-9_]*)\s*(.*)$/;

/** A reason is one line under a card, not a paragraph. */
export const PROPOSAL_REASON_MAX_CHARS = 200;
/** A brief line is one line on Home. */
export const BRIEF_LINE_MAX_CHARS = 220;

const FENCE_LINE = /^\s*(?:```|~~~)[\w-]*\s*$/;
const RULE_LINE = /^\s*([-*_=])(?:\s*\1){2,}\s*$/;
const LABEL_MAX_CHARS = 60;

function isLabel(line: string): boolean {
  const trimmed = line.trim();
  if (trimmed.length === 0 || trimmed.length > LABEL_MAX_CHARS) return false;
  if (/^#{1,6}\s+\S/.test(trimmed)) return true;
  if (/^(\*\*|__)[^*_]+\1:?$/.test(trimmed)) return true;
  return /:$/.test(trimmed.replace(/[*_`]+$/, ''));
}

/**
 * The nudge parser's scaffolding rule (nudge-plan.ts `stripScaffolding`), over
 * this module's lines: an opening fence whose nearest non-blank line below is
 * one of ours goes, a closing fence whose nearest one above is, a rule bordering
 * one, and a label directly above one. Runs to a fixed point. Nothing that does
 * not border one of our lines is touched.
 */
function stripScaffolding(lines: string[], removed: boolean[], ours: boolean[]): void {
  const nearest = (from: number, step: 1 | -1): number => {
    for (let j = from + step; j >= 0 && j < lines.length; j += step) {
      if (lines[j]!.trim().length > 0) return j;
    }
    return -1;
  };
  const opens = new Map<number, boolean>();
  let open = false;
  for (const [index, line] of lines.entries()) {
    if (!FENCE_LINE.test(line)) continue;
    open = !open;
    opens.set(index, open);
  }
  const frame = (j: number) => opens.has(j) || RULE_LINE.test(lines[j]!);
  const anchor = (j: number) => j !== -1 && removed[j] === true && (ours[j] === true || frame(j));
  let changed = true;
  while (changed) {
    changed = false;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      if (removed[i] || line.trim().length === 0) continue;
      const fence = opens.get(i);
      const goes =
        fence !== undefined
          ? anchor(nearest(i, fence ? 1 : -1))
          : RULE_LINE.test(line)
            ? anchor(nearest(i, 1)) || anchor(nearest(i, -1))
            : isLabel(line) && anchor(nearest(i, 1));
      if (goes) {
        removed[i] = true;
        changed = true;
      }
    }
  }
}

/**
 * The first balanced JSON object at the start of `text`, string-aware, or
 * null. Returns the object's source and what follows it.
 */
export function leadingJsonObject(text: string): { json: string; rest: string } | null {
  if (!text.startsWith('{')) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
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
      if (depth === 0) return { json: text.slice(0, i + 1), rest: text.slice(i + 1) };
    }
  }
  return null;
}

/** Markdown and wrapping quotes off, a leading separator off, whitespace collapsed. */
function cleanProse(raw: string, max: number): string {
  let body = raw
    .replace(/[*`#]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[-–—:|]\s*/, '')
    .trim();
  const quoted = /^["“'‘](.*)["”'’]$/.exec(body);
  if (quoted) body = quoted[1]!.trim();
  return body.length > max ? `${body.slice(0, max - 1).trimEnd()}…` : body;
}

/** One PROPOSE line, bare (bullets and outer emphasis off), to a result. */
function parseProposeLine(raw: string): ProposeLine | MalformedProposeLine {
  const line = raw.trim();
  // Only the OUTER emphasis: a tool name and a JSON string both carry
  // underscores, so stripping `_` everywhere (the nudge parser can) would
  // corrupt the very thing being parsed.
  const bare = line
    .replace(LEAD_MARKER, '')
    .replace(/[\s*_`]+$/, '')
    .trim();
  const head = HEAD.exec(bare);
  if (!head) return { line, why: 'grammar' };
  let rest = head[1]!;
  let until: string | null = null;
  let finding: string | null = null;
  // Each qualifier at most once, in either order.
  for (let i = 0; i < 2; i++) {
    const u: RegExpExecArray | null = until === null ? UNTIL.exec(rest) : null;
    if (u) {
      const hour: number = Number(u[1]);
      if (hour > 23 || Number(u[2]) > 59) return { line, why: 'grammar' };
      until = `${String(hour).padStart(2, '0')}:${u[2]}`;
      rest = rest.slice(u[0].length);
      continue;
    }
    const f: RegExpExecArray | null = finding === null ? FINDING.exec(rest) : null;
    if (f) {
      finding = f[1]!;
      rest = rest.slice(f[0].length);
    }
  }
  const named = TOOL.exec(rest);
  if (!named) return { line, why: 'grammar' };
  const [, tool, after] = named;
  const object = leadingJsonObject(after!.trim());
  if (!object) return { line, why: 'json' };
  let input: unknown;
  try {
    input = JSON.parse(object.json);
  } catch {
    return { line, why: 'json' };
  }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return { line, why: 'json' };
  const reason = cleanProse(object.rest, PROPOSAL_REASON_MAX_CHARS);
  if (reason.length === 0) return { line, why: 'reason' };
  return { tool: tool!, input: input as Record<string, unknown>, reason, until, finding, line };
}

/**
 * Take a pass reply apart: the note, the PROPOSE lines, the BRIEF lines.
 * Lines of other grammars (NUDGE) are left in `text` for their own parser.
 */
export function parsePassLines(reply: string): PassLines {
  const lines = reply.split('\n');
  const isPropose = lines.map((line) => PROPOSE_LINE.test(line));
  const isBrief = lines.map((line) => !PROPOSE_LINE.test(line) && BRIEF_LINE.test(line));
  const ours = lines.map((_, i) => isPropose[i]! || isBrief[i]!);
  const removed = [...ours];
  const first = ours.indexOf(true);

  const proposals: ProposeLine[] = [];
  const malformed: MalformedProposeLine[] = [];
  const brief: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (isPropose[index]) {
      const parsed = parseProposeLine(line);
      if ('why' in parsed) malformed.push(parsed);
      else proposals.push(parsed);
    } else if (isBrief[index]) {
      const body = cleanProse(
        line
          .replace(LEAD_MARKER, '')
          .replace(/^BRIEF:?/, '')
          .replace(/[\s*_`]+$/, ''),
        BRIEF_LINE_MAX_CHARS
      );
      if (body.length > 0) brief.push(body);
    }
  }

  if (first === -1) return { text: reply.trim(), lead: null, proposals, malformed, brief };
  stripScaffolding(lines, removed, ours);
  const kept = (upTo: number) =>
    lines
      .slice(0, upTo)
      .filter((_, index) => !removed[index])
      .join('\n')
      .trim();
  return { text: kept(lines.length), lead: kept(first), proposals, malformed, brief };
}
