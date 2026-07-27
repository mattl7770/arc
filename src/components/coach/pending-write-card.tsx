import { Pressable, Text, View } from 'react-native';

import type { PendingWrite } from '@/types/coach';

/**
 * The consequential-write gate, made visible: when the Coach wants to log or
 * change something, the agentic loop suspends and this card asks. Nothing is
 * written until Approve; Decline sends the model a "user declined" result it
 * must respect. Sits pinned above the composer so it can't be missed.
 */
export function PendingWriteCard({
  pending,
  onResolve,
}: {
  pending: PendingWrite;
  /** Carries the request's nonce so a tap can only answer what it was shown. */
  onResolve: (id: number, approved: boolean) => void;
}) {
  return (
    <View className="border-t border-hairline bg-porcelain px-5 py-3">
      <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
        Coach wants to
      </Text>
      <Text className="mt-1 text-[15px] leading-6 text-ink">{pending.summary}</Text>
      <View className="mt-2.5 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          onPress={() => onResolve(pending.id, true)}
          className="rounded-btn bg-pine px-4 py-2 active:opacity-70">
          <Text className="text-[13px] font-medium text-pine-on">Approve</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => onResolve(pending.id, false)}
          className="rounded-btn border border-hairline-strong px-4 py-2 active:opacity-60">
          <Text className="text-[13px] text-ink-secondary">Decline</Text>
        </Pressable>
      </View>
    </View>
  );
}
