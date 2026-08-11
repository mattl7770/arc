import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useProtocols } from '@/hooks/use-protocols';
import { protocolTypeLabel } from '@/lib/protocols/format';

/**
 * Protocols — the versioned stacks and routines, pushed from the Data tab
 * (docs/information-architecture.md: lives in Data for now, first in line to
 * graduate to its own sub-app).
 *
 * Conformed Set treatment — one **ruled plate**: the protocol list is a record,
 * and a record is a table, so the stack of separate cards became a single plate
 * with ruled rows. The closing rationale is a **margin annotation**.
 *
 * Accent budget: exactly one — "New protocol", the single primary action on the
 * screen. The paused chip and the version string are workflow, not biology, so
 * they stay neutral ink; signal colours never mark chrome.
 *
 * The live versions drive Today's Mission — a day's plan is committed when it is
 * generated, which the closing note states plainly rather than implying an edit
 * lands immediately.
 */
export default function ProtocolsScreen() {
  const router = useRouter();
  const { protocols } = useProtocols();

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Protocols" />
      </View>

      {/* The one accent on this screen. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New protocol"
        onPress={() => router.push('/protocol-edit')}
        className="mt-5 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5 active:opacity-70">
        <Ionicons name="add" size={19} color={palette.pineOn} />
        <Text className="font-label text-[15px] font-semibold text-pine-on">New protocol</Text>
      </Pressable>

      <View className="mt-8">
        {/* The count is a measured value — mono, carried by the label's note slot. */}
        <SectionLabel
          label="Your protocols"
          note={protocols.length > 0 ? String(protocols.length) : undefined}
        />

        <View className="mt-3">
          <Block device="plate">
            {protocols.length === 0 ? (
              // Empty is authored, never blank — and it keeps the plate: this
              // is the state a fresh install opens in, and the record's place
              // is drawn before it has contents.
              <View className="py-1">
                <Text className="font-serif text-[15px] font-semibold text-ink">
                  No protocols yet
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  A protocol is a stack or routine you run — a supplement stack, a morning routine,
                  a training block. Create the first; every edit after that becomes a new version.
                </Text>
              </View>
            ) : (
              protocols.map((p, index) => (
                <View key={p.id}>
                  <Divider first={index === 0} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${p.name}. ${protocolTypeLabel(p.type)}, ${
                      p.versionNumber === null
                        ? 'no version yet'
                        : `version ${p.versionNumber}, ${p.itemCount} ${p.itemCount === 1 ? 'item' : 'items'}`
                    }${p.isActive ? '' : ', paused'}. Edit.`}
                    onPress={() =>
                      router.push({ pathname: '/protocol-edit', params: { id: p.id } })
                    }
                    className="min-h-[44px] py-3 active:opacity-60">
                    <View className="flex-row items-center gap-3">
                      <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">
                        {p.name}
                      </Text>
                      {/* A state word, not a boxed badge. Drawn on exactly one
                        kind of row and absent on every other, which is all the
                        distinction it needs — a border around two syllables is
                        a mark the reader has to interpret. Bare Text so it sits
                        on the row's baseline; a bordered View aligns by its
                        bottom edge and drops below the line
                        (app/protocol-versions.tsx makes the same call). */}
                      {p.isActive ? null : (
                        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                          Paused
                        </Text>
                      )}
                      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
                    </View>

                    {p.description ? (
                      <Text
                        className="mt-1 font-serif text-[12.5px] leading-5 text-ink-secondary"
                        numberOfLines={2}>
                        {p.description}
                      </Text>
                    ) : null}

                    <View className="mt-1.5 flex-row items-center justify-between gap-3">
                      <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                        {protocolTypeLabel(p.type)}
                      </Text>
                      <Text className="font-mono text-[11px] text-ink-muted">
                        {p.versionNumber === null
                          ? 'no version yet'
                          : `v${p.versionNumber} · ${p.itemCount} ${p.itemCount === 1 ? 'item' : 'items'}`}
                      </Text>
                    </View>
                  </Pressable>
                </View>
              ))
            )}
          </Block>
        </View>
      </View>

      {/* How an edit here reaches Home — the generator commits a day once, so an
          edit made today lands on tomorrow's mission. */}
      <View className="mt-8">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            Active protocols drive Today&rsquo;s Mission. A day&rsquo;s plan is committed when it is
            generated, so an edit made today shapes tomorrow&rsquo;s mission.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
