import { Text, View } from 'react-native';

import type { CheckinOutcome } from '@/lib/ai/pass-store';

/**
 * What the Coach tab says about a tapped check-in the Coach did NOT answer in
 * the thread (0064, owner's Q5).
 *
 * The plan left this open (its checker's note on the doorbell): a tap that
 * opens onto nothing reads as a broken tap. So when the Coach looked and said
 * nothing, could not be reached, or has no key, one plain line says which —
 * and when it answered (`spoke`) or had already answered today (`shown`), the
 * thread is the answer and this says nothing.
 */
export function checkinNote(outcome: CheckinOutcome | null): string | null {
  if (!outcome) return null;
  switch (outcome.result) {
    case 'silent':
      return 'The Coach looked and had nothing to add. Ask it anything below.';
    case 'offline':
      return 'The Coach could not be reached, so it has not answered. Ask it below once you are online.';
    case 'no-key':
      return 'The Coach needs an API key to check in. Add one in Settings › Coach.';
    default:
      return null;
  }
}

/**
 * The line itself, docked above the composer where the activity line sits:
 * "checking in…" while the Coach is answering, then the note, if there is one.
 * Mono for the transient ticker (the activity line's voice), serif for the
 * sentence. Neutral ink: this is workflow state, not biology and not an action.
 */
export function CheckinLine({
  answering,
  outcome,
}: {
  answering: boolean;
  outcome: CheckinOutcome | null;
}) {
  if (answering) {
    return (
      <View className="px-5 pb-1.5">
        <Text className="font-mono text-[11px] text-ink-muted">· checking in…</Text>
      </View>
    );
  }
  const note = checkinNote(outcome);
  if (!note) return null;
  return (
    <View className="px-5 pb-1.5">
      <Text className="font-serif text-[12px] leading-5 text-ink-secondary">{note}</Text>
    </View>
  );
}
