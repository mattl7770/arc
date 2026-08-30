import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import type { CoachChatMessage } from '@/hooks/use-coach-chat';
import type { TurnStatus } from '@/lib/db/repositories/ai-chat';

import { TypingIndicator } from './typing-indicator';

type Props = {
  message: CoachChatMessage;
  onRetry: () => void;
};

/**
 * The chip label for a turn that did not finish. Workflow state, not a
 * biological one — so it is a neutral ink chip, never a signal colour.
 */
const INCOMPLETE_CHIP: Record<TurnStatus, string> = {
  max_tokens: 'cut off · length limit',
  tool_use_limit: 'unfinished · step limit',
  failed: 'unfinished · turn failed',
  superseded: 'abandoned · retried below',
};

/**
 * The one line that says what actually happened. When a write tool ran, that
 * fact leads: the user's health record changed even though the Coach never
 * finished the turn, and finding that out later is not acceptable.
 */
function incompleteNote(status: TurnStatus, wrote: boolean): string {
  const landed = ' The actions you approved already ran and are saved.';
  switch (status) {
    case 'max_tokens':
      return `This reply stopped at the model’s length limit — it is not a finished answer.${
        wrote ? landed : ''
      }`;
    case 'tool_use_limit':
      return `The Coach ran out of tool steps before it finished answering.${wrote ? landed : ''}`;
    case 'failed':
      return `This turn failed before it finished.${wrote ? landed : ''}`;
    case 'superseded':
      return `Abandoned part-way; the reply below replaces it.${wrote ? landed : ''}`;
  }
}

/**
 * What the bubble says. A turn can end with no text at all — an error before
 * the first token, or a turn that spent every step on tools — and an empty
 * bubble would read as an answer with nothing in it. Say what happened instead.
 */
function bubbleText(message: CoachChatMessage): string {
  if (message.content.length > 0) return message.content;
  if (message.error) return 'Couldn’t reach the Coach.';
  if (message.incomplete) return 'The Coach stopped before it wrote an answer.';
  return '';
}

/**
 * One turn in the thread.
 *
 * The user speaks in solid pine on the right; the Coach answers on bordered
 * porcelain slips on the left — typeset prose, not chat froth. Each bubble
 * squares off one corner toward its speaker, like a ledger entry's tab.
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
          {bubbleText(message)}
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

      {/*
        The turn did not finish. Say so plainly — an unfinished answer read as
        a finished one is the failure this guards against.
      */}
      {message.incomplete ? (
        <View className="mt-1.5">
          <View className="self-start rounded-btn bg-paper-deep px-2 py-0.5">
            <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
              {INCOMPLETE_CHIP[message.incomplete]}
            </Text>
          </View>
          <Text className="mt-1 text-xs leading-4 text-ink-secondary">
            {incompleteNote(message.incomplete, message.wrote === true)}
          </Text>
        </View>
      ) : null}

      {message.error ? (
        <Pressable
          accessibilityRole="button"
          onPress={onRetry}
          className="mt-1.5 flex-row items-center gap-1 self-start active:opacity-60">
          <Ionicons name="refresh" size={13} color={palette.signal.poor} />
          <Text className="text-xs text-signal-poor">Couldn’t send · Retry</Text>
        </Pressable>
      ) : null}
    </View>
  );
}
