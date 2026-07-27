import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useProtocols } from '@/hooks/use-protocols';
import { protocolTypeLabel } from '@/lib/protocols/format';

/**
 * Protocols — the versioned stacks and routines, pushed from the Data tab
 * (docs/information-architecture.md: lives in Data for now, first in line to
 * graduate to its own sub-app). Each protocol is a card: name, type, live
 * version + item count, paused state. Tapping opens the editor; the one pine
 * on this screen is "New protocol".
 *
 * The live versions will drive Today's Mission — that generator is a separate,
 * clearly-marked seam (see src/lib/db/repositories/protocols.ts), so this
 * screen says so honestly rather than pretending.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

export default function ProtocolsScreen() {
  const router = useRouter();
  const { protocols } = useProtocols();

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Protocols" />
      </View>

      <Text className="mt-1 text-[13px] leading-5 text-ink-secondary">
        Stacks and routines, versioned like code — every save is a new version, and history is never
        lost.
      </Text>

      {/* The one pine action on this screen. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New protocol"
        onPress={() => router.push('/protocol-edit')}
        className="mt-5 flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5 active:opacity-70">
        <Ionicons name="add" size={19} color={palette.pineOn} />
        <Text className="text-[15px] font-semibold text-pine-on">New protocol</Text>
      </Pressable>

      <View className="mt-8">
        {/* The count is a measured value — mono, beside the sans label. */}
        <View className="flex-row items-baseline justify-between">
          <SectionLabel>Your protocols</SectionLabel>
          {protocols.length > 0 ? (
            <Text className="font-mono text-[11px] text-ink-muted">{protocols.length}</Text>
          ) : null}
        </View>

        {protocols.length === 0 ? (
          <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
            Nothing here yet. A protocol is a stack or routine you run — a supplement stack, a
            morning routine, a training block. Create the first; every edit after that becomes a new
            version.
          </Text>
        ) : (
          <View className="mt-3 gap-2">
            {protocols.map((p) => (
              <Pressable
                key={p.id}
                accessibilityRole="button"
                accessibilityLabel={`${p.name}. ${protocolTypeLabel(p.type)}, ${
                  p.versionNumber === null
                    ? 'no version yet'
                    : `version ${p.versionNumber}, ${p.itemCount} ${p.itemCount === 1 ? 'item' : 'items'}`
                }${p.isActive ? '' : ', paused'}. Edit.`}
                onPress={() => router.push({ pathname: '/protocol-edit', params: { id: p.id } })}
                className="rounded-card border border-hairline bg-porcelain p-4 active:bg-paper-deep">
                <View className="flex-row items-center gap-3">
                  <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">
                    {p.name}
                  </Text>
                  {p.isActive ? null : (
                    <View className="rounded-btn bg-paper-deep px-2 py-0.5">
                      <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
                        Paused
                      </Text>
                    </View>
                  )}
                  <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
                </View>

                {p.description ? (
                  <Text
                    className="mt-1 text-[12.5px] leading-5 text-ink-secondary"
                    numberOfLines={2}>
                    {p.description}
                  </Text>
                ) : null}

                <View className="mt-2 flex-row items-center justify-between">
                  <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">
                    {protocolTypeLabel(p.type)}
                  </Text>
                  <Text className="font-mono text-[11px] text-ink-muted">
                    {p.versionNumber === null
                      ? 'no version yet'
                      : `v${p.versionNumber} · ${p.itemCount} ${p.itemCount === 1 ? 'item' : 'items'}`}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
        )}
      </View>

      {/* Honest seam marker — the generator is built with Home, not here. */}
      <Text className="mt-8 text-[11px] leading-4 text-ink-muted">
        Active protocols will drive Today&rsquo;s Mission — the generator arrives with the Home
        wiring.
      </Text>
    </Screen>
  );
}
