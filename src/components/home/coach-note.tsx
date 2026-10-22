import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { ProposalRows } from '@/components/coach/proposal-card';
import { palette } from '@/constants/theme';
import type { StoredProposal } from '@/lib/ai/proposals';

/**
 * The Coach speaking first — Home's Coach card.
 *
 * This is the only thing on Home the user did not ask for: the output of an
 * automatic pass (src/lib/ai/coach-pass.ts). It holds up to three things, each
 * shown only when the pass produced it, so on an ordinary day it is absent:
 *
 *   THE BRIEF (2026-10-21) — the first look of the day writes three to five
 *   lines on what matters today, every number traced to what the pass read
 *   (proposals.ts `vetBrief`). On top, because it is the day's opening word.
 *   While it exists, Home does not draw the deterministic Coach brief; without
 *   one (no key, no pass yet, a quiet failure) that brief is the fallback.
 *
 *   THE NOTE — what the Coach judged worth saying. At most once a day, and only
 *   when there is something to say — the model replies SKIP otherwise — so it
 *   must never be dressed as an alert. Its dismiss costs one tap and dismisses
 *   the note only.
 *
 *   THE DRAFTS (2026-10-21) — changes the Coach drafted for his approval, each
 *   with Approve and Decline. Approve runs the chat write path, re-reading the
 *   row first (proposals.ts); the same drafts appear in the thread.
 *
 * Same porcelain slip as before, one eyebrow to mark that the Coach initiated
 * it. Tapping Reply opens the thread, where the note is already the latest turn.
 */
export function CoachNote({
  message,
  onDismiss,
  brief = null,
  proposals = [],
  busyId = null,
  onApprove,
  onDecline,
}: {
  message: string | null;
  onDismiss: () => void;
  brief?: string[] | null;
  proposals?: StoredProposal[];
  busyId?: string | null;
  onApprove?: (id: string) => void;
  onDecline?: (id: string) => void;
}) {
  const router = useRouter();
  const hasDrafts = proposals.length > 0 && !!onApprove && !!onDecline;

  return (
    <View className="rounded-card border border-hairline bg-porcelain p-4">
      <View className="flex-row items-center justify-between">
        <View className="flex-row items-center gap-2">
          <View className="h-1.5 w-1.5 rounded-full bg-pine" />
          <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
            {brief ? 'Coach · today' : 'Coach noticed'}
          </Text>
        </View>
        {message ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Dismiss the Coach's note"
            hitSlop={10}
            onPress={onDismiss}
            className="active:opacity-60">
            <Ionicons name="close" size={16} color={palette.inkMuted} />
          </Pressable>
        ) : null}
      </View>

      {brief ? (
        <View className="mt-3 gap-1.5">
          {brief.map((line, index) => (
            <Text key={index} className="font-serif text-[13px] leading-5 text-ink-secondary">
              {line}
            </Text>
          ))}
        </View>
      ) : null}

      {message ? (
        <Text className={`${brief ? 'mt-4' : 'mt-3'} text-[15px] leading-6 text-ink`}>
          {message}
        </Text>
      ) : null}

      {hasDrafts ? (
        <View className="mt-4">
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
            For your approval
          </Text>
          <ProposalRows
            proposals={proposals}
            busyId={busyId}
            onApprove={onApprove}
            onDecline={onDecline}
          />
        </View>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Open the Coach conversation"
        onPress={() => router.push('/coach')}
        className="mt-4 flex-row items-center gap-1 self-start active:opacity-70">
        <Text className="text-sm font-medium text-pine">Reply</Text>
        <Ionicons name="chevron-forward" size={14} color={palette.pine} />
      </Pressable>
    </View>
  );
}
