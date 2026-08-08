import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
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
 * One turn in the thread.
 *
 * The user speaks in solid pine on the right; the Coach answers on bordered
 * porcelain slips on the left — typeset prose, not chat froth. Each bubble
 * squares off one corner toward its speaker, like a ledger entry's tab.
 *
 * A turn that did not finish says so. Two things must survive a reload here:
 * that the reply is a fragment rather than an answer, and — the case that
 * matters most — that any writes the owner approved mid-turn ALREADY LANDED in
 * their record even though the Coach never got to the end of the sentence. That
 * is stated in words, not implied by a chip.
 *
 * All of it is WORKFLOW state, so it is neutral ink and paper-deep only. The
 * signal-* palette is reserved for biological readings; a stalled network
 * request is not a health signal, and colouring it like one would devalue the
 * colours that are.
 */
export function MessageBubble({ message, onRetry }: Props) {
  if (message.role === 'user') {
    return (
      <View className="mb-3 max-w-[85%] self-end rounded-card rounded-br-sm bg-pine px-4 py-2.5">
        <Text className="text-[15px] leading-6 text-pine-on">{message.content}</Text>
      </View>
    );
  }

  // Assistant, mid-stream, nothing yet → the thinking indicator.
  if (message.streaming && message.content.length === 0) {
    return (
      <View className="mb-3 self-start rounded-card rounded-bl-sm border border-hairline bg-porcelain px-4 py-3">
        <TypingIndicator />
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
    <View className="mb-3 max-w-[88%] self-start">
      {/*
        Announce the reply to screen readers as it streams in — it is the most
        important event on the screen. The caret is decorative and hidden from
        assistive tech so it isn't read out as a character.
      */}
      <View
        accessibilityLiveRegion="polite"
        className="rounded-card rounded-bl-sm border border-hairline bg-porcelain px-4 py-3">
        <Text className="text-[15px] leading-6 text-ink">
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
          {unfinished && OUTCOME_CHIP[outcome] ? (
            <View className="rounded-btn bg-paper-deep px-2 py-0.5">
              <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
                {OUTCOME_CHIP[outcome]}
              </Text>
            </View>
          ) : null}
          {message.superseded ? (
            <View className="rounded-btn bg-paper-deep px-2 py-0.5">
              <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
                Superseded
              </Text>
            </View>
          ) : null}
        </View>
      ) : null}

      {unfinished && OUTCOME_LINE[outcome] ? (
        <Text className="mt-1 text-xs leading-5 text-ink-secondary">{OUTCOME_LINE[outcome]}</Text>
      ) : null}

      {/*
        Said plainly, because the owner's record changed: the writes are not
        pending, not rolled back, not waiting on the retry — they are in.
      */}
      {showWritesLanded ? (
        <Text className="mt-1 text-xs leading-5 text-ink">
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
        <Text className="mt-1 text-xs leading-5 text-ink-secondary">
          Replaced by the reply below. Kept because it is part of the record.
        </Text>
      ) : null}

      {canRetry ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry this turn"
          onPress={onRetry}
          className="mt-1.5 flex-row items-center gap-1 self-start active:opacity-60">
          <Ionicons name="refresh" size={13} color={palette.inkSecondary} />
          <Text className="text-xs text-ink-secondary">Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
