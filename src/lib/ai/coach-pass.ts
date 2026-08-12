/**
 * The coach pass — the one place the Coach speaks WITHOUT being asked.
 *
 * Everything else in the Coach runs because the user typed something. This
 * runs on its own: once per calendar day when the app opens, and again when
 * something worth a second look appears (a new watch-tone signal, an
 * experiment reaching its readout, a lab import). It is the difference between
 * a reference librarian and a coach (docs/coach-intelligence-review.md §4
 * Phase 4).
 *
 * Two design decisions make it safe to run anywhere, unattended:
 *
 *   READ-ONLY BY CONSTRUCTION. The pass is given the read tools only, so there
 *   is no write to gate and no confirmation UI to require. Nothing it decides
 *   can change the user's data behind their back. When it concludes something
 *   should change, it says so — and acting on that happens in the thread,
 *   where the confirmation gate lives and the user is present.
 *
 *   IT MAY SAY NOTHING. The directive tells the model to reply with exactly
 *   SKIP when the day doesn't warrant a word. A coach that produces a
 *   paragraph every single morning trains the user to ignore it; silence on an
 *   unremarkable day is what makes the other days land. Recognising that
 *   sentinel is {@link isPassSkip}'s job, and it is a parser rather than a
 *   prompt on purpose — the prompt is the second line of defence, because a
 *   sentinel that leaks reaches the owner as the Coach's own words.
 *
 * The judgment itself is entirely the model's. Nothing here decides what a low
 * readiness morning, a stalled lift, or a missed week should mean — the
 * deterministic layer only decides WHEN to wake the model up.
 */
import type { Database } from '@/lib/db/database';
import { todayISODate } from '@/lib/db/date';

import { apiKeyStore } from './api-key-store';
import { runCoachTurn, type FetchLike } from './model-client';
import { buildCoachSystemPrompt } from './system-prompt';
import { buildTurnContext } from './turn-context';
// Explicit /index: a bare directory import resolves under Metro but not under
// Node ESM, and this module IS loaded headlessly (db/coach-pass.test.mjs).
import { READ_TOOLS, toolByName, toWireTools } from './tools/index';
import type { CoachToolCall } from './types';

/** The model replies with exactly this when the day needs nothing said. */
export const PASS_SKIP = 'SKIP';

/**
 * One line that is the sentinel and nothing else. Tolerates surrounding
 * whitespace, terminal punctuation the model adds unbidden ("SKIP."), and
 * markdown emphasis ("**SKIP**") — none of which are content, and any of which
 * shipped verbatim is the same defect.
 */
const SKIP_LINE = /^[*_\s]*skip[.!]*[*_\s]*$/i;

/**
 * Did the pass decide to say nothing?
 *
 * **The rule: the LAST non-empty line is the sentinel, alone.** (An empty reply
 * counts too — nothing said is nothing said.)
 *
 * ## What the old rule got wrong
 *
 * It was `/^skip[.!]?$/i` against the whole trimmed reply, which requires the
 * ENTIRE response to be the sentinel. The owner's phone showed what that costs
 * (2026-08-11): the model narrated first — "I'll read the current state and
 * check for anything worth flagging." — called its tools, then said SKIP. The
 * whole-string test failed, so the pass concluded the Coach had spoken and
 * published the narration *and the sentinel* to Home's "Coach noticed" card and
 * into the thread. A sentinel is an internal token; the owner should never see
 * one, and a card whose entire content is the Coach announcing it is about to
 * look at something is worse than no card.
 *
 * ## Why the last line, and not the alternatives
 *
 * *Sentinel anywhere on its own line* is more permissive in the one direction
 * that cannot be recovered from. Silence is invisible: a genuine observation
 * wrongly swallowed is never seen, never retried, and consumes the day
 * (pass-store.ts treats silence as a judgment). A note that quotes the
 * instruction back, or lists options one per line, must not be able to silence
 * itself from the middle.
 *
 * *Stripping known preamble shapes* was rejected outright — the set of ways a
 * model can clear its throat is unbounded, so every phrasing the regexes miss
 * ships a sentinel. A rule that fails open on an unenumerated case is not a
 * parser.
 *
 * *Last line* fits the actual grammar of the failure. Whatever the model says
 * on the way there, its verdict is the last thing it writes, and a verdict of
 * SKIP is a decision about the whole reply — including any observation it
 * manufactured above it, which is precisely what the directive tells it not to
 * produce. So text above a trailing sentinel is discarded on purpose, not
 * missed.
 *
 * ## The false-positive direction
 *
 * A real note that merely contains the word must not be silenced, and cannot
 * be: "Four sessions logged this week — it is fine to skip today's" ends in a
 * line with eleven other words on it, so {@link SKIP_LINE} does not match.
 * Only a line whose entire content is the sentinel counts. The narrow residual
 * case — a genuine note whose final line is the bare word "Skip." as advice to
 * the owner — is accepted as the cost of the rule: it needs the Coach to end a
 * paragraph on one word that happens to be the sentinel, and the alternative is
 * shipping "SKIP" to the owner on every model that clears its throat.
 *
 * This is the FIRST line of defence and the one that has to hold. The directive
 * also asks for no preamble and the model client now settles a turn on its
 * post-tool text only (src/lib/ai/model-client.ts settledText), so in practice
 * this should see a bare "SKIP" — but a prompt is a request and a parser is a
 * guarantee, and only one of the two is allowed to be the guarantee.
 */
export function isPassSkip(text: string): boolean {
  const lines = text.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]!;
    if (line.trim().length === 0) continue; // trailing blank lines / whitespace
    return SKIP_LINE.test(line);
  }
  return true; // nothing but whitespace — the Coach said nothing at all
}

/** Why the pass ran — shapes the directive and the dedupe key. */
export type PassTrigger =
  | { kind: 'daily' }
  | { kind: 'signal'; detail: string }
  | { kind: 'checkin'; part: 'morning' | 'evening' };

/**
 * Why a pass produced no message. The distinction matters: `silent` is a
 * JUDGMENT (the Coach looked and had nothing worth saying) and consumes the
 * day; `failed` is an ABSENCE (no key, no network, the call threw) and must
 * not — otherwise one aeroplane-mode morning silently cancels that day's pass
 * and the user is told nothing, by a system that never actually looked.
 */
export type CoachPassStatus = 'spoke' | 'silent' | 'failed';

export type CoachPassResult = {
  /** What the Coach decided to say, or null when it chose silence. */
  message: string | null;
  status: CoachPassStatus;
  toolCalls: CoachToolCall[];
};

/** The instruction the pass runs under. Deliberately open — no scenario named. */
export function passDirective(trigger: PassTrigger, today: string): string {
  const opening =
    trigger.kind === 'daily'
      ? `This is your own once-a-day look at ${today}. The user did not ask for it and is not waiting on a reply.`
      : trigger.kind === 'checkin'
        ? trigger.part === 'morning'
          ? `This is the user's morning check-in for ${today}. They opened ARC expecting a word from you.`
          : `This is the user's evening check-in for ${today}. Compare what the day planned against what actually happened.`
        : `Something changed worth a second look (${trigger.detail}). The user did not ask for this.`;

  return [
    `[Automatic ${trigger.kind} pass — the user did not type this.]`,
    opening,
    '',
    'Read what you need — the state block above, get_insights, the snapshot, and anything they point to.',
    'Then decide, as their coach, whether anything genuinely warrants a word right now.',
    '',
    'Do not narrate. Call the tools you need without announcing them first — no "let me look at",',
    'no "I will check". Nothing you write before you have the results is shown to anyone, so write',
    'nothing until you have them. Your reply is one thing only: the observation, or the sentinel.',
    '',
    'If it does: two or three sentences at most. Lead with the thing itself, numbers attached.',
    'Say plainly what you would change and why — you cannot change anything in this pass, so make',
    'it something they can act on or reply to.',
    '',
    `If the day is unremarkable, reply with exactly ${PASS_SKIP} and nothing else — bare, on its own,`,
    'with no sentence before or after it. Silence on a quiet day is what makes the other days',
    'matter, so do not manufacture an observation to avoid saying it.',
  ].join('\n');
}

export type RunPassOptions = {
  trigger: PassTrigger;
  now?: Date;
  /** Injected in tests; expo/fetch on device. */
  fetchImpl?: FetchLike;
  /**
   * Override the model. The pass runs unattended and often says nothing, so it
   * defaults to the cheapest capable model rather than the user's chat pick —
   * paying Opus rates for "SKIP" every morning is indefensible.
   */
  model?: string;
};

/** The model the pass uses unless overridden — cheap, fast, good enough to triage. */
export const PASS_MODEL = 'claude-haiku-4-5';

/**
 * expo/fetch, resolved LAZILY through a guarded require (the api-key-store /
 * reminders pattern). A module-level import would make this file unloadable
 * off-device, and the pass is exactly the logic most worth testing headlessly.
 */
function defaultFetch(): FetchLike | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    return (require('expo/fetch') as { fetch: FetchLike }).fetch;
  } catch {
    return null;
  }
}

/**
 * Run one pass. Never throws and never surfaces an error to a user who did not
 * ask for anything — but it does report WHY it was quiet, so the scheduler can
 * tell a considered silence from a failure to look at all.
 */
export async function runCoachPass(
  db: Database,
  options: RunPassOptions
): Promise<CoachPassResult> {
  const apiKey = apiKeyStore.get();
  if (!apiKey) return { message: null, status: 'failed', toolCalls: [] };
  const fetchImpl = options.fetchImpl ?? defaultFetch();
  if (!fetchImpl) return { message: null, status: 'failed', toolCalls: [] };

  const now = options.now ?? new Date();
  const today = todayISODate(now);

  try {
    const result = await runCoachTurn(
      {
        apiKey,
        model: options.model ?? PASS_MODEL,
        fetchImpl,
      },
      {
        system: buildCoachSystemPrompt(),
        systemContext: buildTurnContext(db, now),
        messages: [{ role: 'user', content: passDirective(options.trigger, today) }],
        // READ tools only: with no write in the registry there is nothing to
        // gate, so an unattended pass cannot change anything.
        tools: toWireTools(READ_TOOLS),
      },
      {
        onToken: () => {},
        executeTool: async (name, input) => {
          const tool = toolByName(name);
          if (!tool || !tool.readOnly) {
            // Defence in depth: even if a write tool somehow reaches here, the
            // pass refuses it rather than running it unattended.
            return {
              content: `${name} is not available in an automatic pass. Say what you would do instead.`,
              isError: true,
            };
          }
          try {
            return {
              content: await tool.execute(db, input as Record<string, unknown>, { now }),
            };
          } catch (error) {
            return {
              content: error instanceof Error ? error.message : 'Tool execution failed.',
              isError: true,
            };
          }
        },
      }
    );

    const text = result.text.trim();
    // A SKIP means silence, however the model punctuates it and whatever it
    // wrote above it — see isPassSkip for the rule and why it is that rule.
    const skipped = isPassSkip(text);
    return {
      message: skipped ? null : text,
      status: skipped ? 'silent' : 'spoke',
      toolCalls: result.toolCalls,
    };
  } catch {
    // Offline, no network, a bad key, a refusal — the user never sees this. But
    // it is NOT a judgment that today was unremarkable, so it reports 'failed'
    // and the day stays open for a real look later.
    return { message: null, status: 'failed', toolCalls: [] };
  }
}
