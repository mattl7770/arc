import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import { clockFromISO } from '@/lib/db/date';
import type { AiTurnOutcome } from '@/lib/db/types';
import { isRetryableOutcome, type CoachChatView } from '@/hooks/use-coach-chat';

import { TypingIndicator } from './typing-indicator';

type Props = {
  message: CoachChatView;
  onRetry: () => void;
};

/** The neutral status chip's word for each unfinished outcome. Whole strings. */
const OUTCOME_CHIP: Record<AiTurnOutcome, string | null> = {
  complete: null,
  truncated: 'Cut off',
  tool_limit: 'Stopped short',
  refused: 'Not answered',
  failed: 'Unfinished',
};

/**
 * The plain sentence under the chip. A chip alone is a label; this is the part
 * that tells the owner what actually happened to the turn.
 */
const OUTCOME_LINE: Record<AiTurnOutcome, string | null> = {
  complete: null,
  truncated: 'The Coach hit its length limit — this reply stops mid-thought.',
  tool_limit: 'The Coach ran out of steps before it finished this answer.',
  refused: 'The Coach declined to answer this.',
  failed: 'The turn stopped before it finished.',
};

/**
 * Wall-clock "HH:MM" for a turn, or null when the row carries no usable time.
 *
 * **No data, no number** (00-design-spec.md §5). `createdAt` is `Date.parse` of
 * a persisted timestamp, so a malformed row yields NaN — and `new Date(NaN)
 * .toISOString()` throws, which would take the whole thread down over a stamp.
 * An unreadable time renders as no time, never as a plausible-looking one.
 */
function turnClock(createdAt: number): string | null {
  return Number.isFinite(createdAt) ? clockFromISO(new Date(createdAt).toISOString()) : null;
}

/**
 * One turn in the thread.
 *
 * ## Conformed Set treatment
 *
 * The turns are drawn **directly on the sheet**. The thread used to sit on the
 * `well` device with the turns as marks on the recess; the owner read that box
 * as gratuitous on hardware and it came off (2026-08-09, see the surface note in
 * app/(tabs)/coach.tsx). Nothing here changed with it: the enclosure was the
 * screen's, the treatment is the turn's. The user speaks in solid accent on the
 * right — one of the six things §2 allows the accent to mark — and the Coach
 * answers on bordered `paper-hi` slips on the left, which is the plate treatment
 * at bubble scale. `paper-hi` on `paper` is a lighter step than `paper-hi` on
 * `paper-dim` was, so the Coach's slips now read as raised rather than as
 * inlaid; the hairline is what holds their edge, and it is unchanged.
 *
 * **Every corner is square**, including the bubbles. The mockup keeps a 12px
 * radius with one corner squared toward the speaker, but that is a browser
 * artefact of a set whose stated geometry is "corners: square" (§4) — and at a
 * `rounded-btn` scale of 2px a single squared corner is invisible anyway. The
 * speaker is named instead, in the label voice, the way the mockup's own
 * `cf-turn-who` names it: it survives a screenshot, a colour-blind reader and a
 * one-line turn, which a corner radius does not.
 *
 * All three voices appear: `font-label` for the speaker eyebrow, `font-mono` for
 * the turn's clock time and the tool chips (mono measures), `font-serif` for the
 * turn itself — Coach turns are prose, and prose is the serif's job.
 *
 * Vertical rhythm belongs to the thread, not the turn: the screen spaces
 * consecutive turns, so this component carries no outer margin of its own and
 * the last turn cannot leave a gap inside the well.
 *
 * ## A turn that did not finish says so
 *
 * Two things must survive a reload: that the reply is a fragment rather than an
 * answer, and — the case that matters most — that any writes the owner approved
 * mid-turn ALREADY LANDED in their record even though the Coach never got to the
 * end of the sentence. That is stated in words, not implied by a chip.
 *
 * All of it is WORKFLOW state, so it is neutral ink and paper tones only. The
 * signal-* palette is reserved for biological readings; a stalled network
 * request is not a health signal, and colouring it like one would devalue the
 * colours that are.
 */
export function MessageBubble({ message, onRetry }: Props) {
  const clock = turnClock(message.createdAt);

  if (message.role === 'user') {
    return (
      <View className="max-w-[85%] self-end">
        <Speaker who="You" clock={clock} tone="accent" align="right" />
        <View className="bg-pine px-3.5 py-2.5">
          <Text className="font-serif text-[15px] leading-6 text-pine-on">{message.content}</Text>
        </View>
      </View>
    );
  }

  // Assistant, mid-stream, nothing yet → the thinking indicator.
  if (message.streaming && message.content.length === 0) {
    return (
      <View className="max-w-[88%] self-start">
        <Speaker who="Coach" clock={clock} tone="muted" align="left" />
        <View className="border border-hairline bg-paper-hi px-3.5 py-3">
          <TypingIndicator />
        </View>
      </View>
    );
  }

  const outcome = message.outcome ?? 'complete';
  const unfinished = !message.streaming && outcome !== 'complete';
  const writes = message.writes ?? [];
  // The load-bearing combination: the turn broke off, but writes already
  // committed. Silence here would let an approved change look like it never ran.
  const showWritesLanded = unfinished && writes.length > 0;
  const canRetry = !message.streaming && !message.superseded && isRetryableOutcome(outcome);

  return (
    <View className="max-w-[88%] self-start">
      <Speaker who="Coach" clock={clock} tone="muted" align="left" />

      {/*
        Announce the reply to screen readers as it streams in — it is the most
        important event on the screen. The caret is decorative and hidden from
        assistive tech so it isn't read out as a character.
      */}
      <View
        accessibilityLiveRegion="polite"
        className="border border-hairline bg-paper-hi px-3.5 py-3">
        <Text className="font-serif text-[15px] leading-6 text-ink">
          {/* An error before the first token leaves content empty; show a line
              rather than an empty bubble. The retry pill sits below. */}
          {message.content.length === 0 && outcome === 'failed'
            ? 'Couldn’t reach the Coach.'
            : message.content}
          {message.streaming ? (
            <Text className="text-pine" accessibilityElementsHidden importantForAccessibility="no">
              {' ▍'}
            </Text>
          ) : null}
        </Text>
      </View>

      {/* Transparency chips: which data the turn actually read or wrote. */}
      {message.tools && message.tools.length > 0 ? (
        <Text className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
          {message.tools.join(' · ')}
        </Text>
      ) : null}

      {/* Workflow status: what became of this turn. Neutral ink throughout. */}
      {unfinished || message.superseded ? (
        <View className="mt-1.5 flex-row flex-wrap items-center gap-1.5">
          {unfinished && OUTCOME_CHIP[outcome] ? <StateChip label={OUTCOME_CHIP[outcome]} /> : null}
          {message.superseded ? <StateChip label="Superseded" /> : null}
        </View>
      ) : null}

      {unfinished && OUTCOME_LINE[outcome] ? (
        <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
          {OUTCOME_LINE[outcome]}
        </Text>
      ) : null}

      {/*
        Said plainly, because the owner's record changed: the writes are not
        pending, not rolled back, not waiting on the retry — they are in.
      */}
      {showWritesLanded ? (
        <Text className="mt-1 font-serif text-[12px] leading-5 text-ink">
          {'Saved before it stopped: '}
          <Text className="font-mono text-[11px] uppercase tracking-[1px] text-ink">
            {writes.join(' · ')}
          </Text>
          {
            '. Those changes are already in your record — only the reply is incomplete, so don’t log them again.'
          }
        </Text>
      ) : null}

      {message.superseded ? (
        <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
          Replaced by the reply below. Kept because it is part of the record.
        </Text>
      ) : null}

      {canRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry this turn"
          onPress={onRetry}
          className="min-h-[44px] flex-row items-center gap-1.5 self-start active:opacity-60">
          <Ionicons name="refresh" size={13} color={palette.inkSecondary} />
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
            Retry
          </Text>
        </Pressable>
      ) : null}
    </View>
  );
}

/**
 * The speaker eyebrow: who said it, and when. The name is the label voice and
 * the clock is mono — the same "serif speaks, mono measures" split the rest of
 * the set uses, applied at the smallest scale on the screen.
 *
 * Both tone and alignment are whole class strings picked from a map, never a
 * built prefix: Tailwind's scanner only sees literal class names.
 */
const SPEAKER_TONE = {
  accent: 'text-pine-deep',
  muted: 'text-ink-muted',
} as const;

const SPEAKER_ALIGN = {
  left: 'mb-1 flex-row items-baseline gap-1.5',
  right: 'mb-1 flex-row items-baseline justify-end gap-1.5',
} as const;

function Speaker({
  who,
  clock,
  tone,
  align,
}: {
  who: string;
  clock: string | null;
  tone: keyof typeof SPEAKER_TONE;
  align: keyof typeof SPEAKER_ALIGN;
}) {
  return (
    <View className={SPEAKER_ALIGN[align]}>
      <Text
        className={`font-label text-[10px] font-semibold uppercase tracking-[1.2px] ${SPEAKER_TONE[tone]}`}>
        {who}
      </Text>
      {clock ? <Text className="font-mono text-[10px] text-ink-muted">{clock}</Text> : null}
    </View>
  );
}

/**
 * A workflow-state chip — squared, bordered, neutral. Never signal-*: "cut off"
 * and "superseded" are facts about a network turn, not about the owner's body.
 */
function StateChip({ label }: { label: string }) {
  return (
    <View className="border border-hairline bg-paper-hi px-2 py-0.5">
      <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-secondary">
        {label}
      </Text>
    </View>
  );
}
