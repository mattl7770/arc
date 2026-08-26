import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useProtocolRecord } from '@/hooks/use-protocols';
import {
  cadenceLabel,
  durationLabel,
  phaseSummary,
  protocolTypeLabel,
  rateText,
  shortDate,
  spanLabel,
} from '@/lib/protocols/format';

/**
 * One protocol: what it asks of you now, and whether you are doing it.
 *
 * This screen is the answer to the defect the rework was called for — *"no
 * adherence loop back to the protocol"*. `log_entries.protocol_id` has been
 * written on every generated row since the generator shipped, and preserved
 * through deletes, and nothing read it back. Now it does, per item.
 *
 * ## Three objects, in the order the questions come
 *
 * 1. **Where it is up to** — a `field` verdict: the live phase, how far into
 *    it, and what the phase actually asks for. A protocol is a plan, and the
 *    first thing to know about a plan is which part of it is running.
 * 2. **How it is going** — a `plate`: the rate since the LIVE VERSION landed,
 *    its four-way ledger (`done · skipped · partial · untouched`) summing to
 *    the denominator beside it, and then one row per item, worst-missed first.
 *    Bounded at the live version deliberately: adherence to a protocol you have
 *    since changed is a fact about a different protocol.
 * 3. **The document** — a `plate` of rows into the editor and the version
 *    history, so the screen ends in an action rather than a number.
 *
 * ## The two empty states are different facts and are drawn differently
 *
 * "Nothing was skipped" is not "nothing was ever logged", and this codebase has
 * shipped that confusion twice. So a protocol whose live version landed today
 * says **"v4 landed today — nothing has settled yet"** and prints no rate at
 * all; a protocol with a window but no planned rows in it says the window
 * asked for nothing. Neither renders a zero.
 *
 * Accent budget: **zero.** This is a reference surface — you read it, you do not
 * act inside it — and the rows into the editor and the history are navigation,
 * not primary actions. Adherence is BEHAVIOUR, not biology, so nothing here
 * takes a `signal-*` colour either; the figures are measurements and take mono.
 */

/** The screen the back control returns to — the only screen that pushes this. */
const PARENT = 'Protocols';

export default function ProtocolDetailScreen() {
  // A deep link can repeat the param (?id=a&id=b), which expo-router delivers
  // as string[] despite the generic — coerce so a malformed link degrades to
  // the "no longer exists" branch instead of throwing at the SQLite bind.
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const router = useRouter();
  const record = useProtocolRecord(id);

  if (!record) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Protocol" parent={PARENT} />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This protocol no longer exists.
        </Text>
      </Screen>
    );
  }

  const { protocol, version, phase, adherence } = record;
  const where = phaseSummary(phase);
  const items = phase.kind === 'running' ? phase.window.phase.items : [];
  // planned − completed − skipped − partial: the rows that simply ran out the
  // day. Named rather than implied, so the ledger reconciles to the denominator.
  const untouched =
    adherence.planned - adherence.completed - adherence.skipped - adherence.partial;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={protocol.name} parent={PARENT} />
      </View>

      <Text className="mt-2 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
        {protocolTypeLabel(protocol.type)}
        {protocol.is_active === 1 ? '' : ' · Paused'}
      </Text>
      {protocol.description ? (
        <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
          {protocol.description}
        </Text>
      ) : null}

      {/* 1. Where it is up to. */}
      <View className="mt-7">
        <SectionLabel
          label="Now"
          note={version ? `v${version.version_number}` : undefined}
        />
        <View className="mt-3">
          <Block device="field">
            {phase.kind === 'ended' ? (
              <>
                <Text className="font-serif text-[17px] font-semibold leading-6 text-ink">
                  This protocol has ended.
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  Its last phase ran out on {shortDate(phase.endedOn)}. It puts nothing on a day
                  until you extend a phase or add another.
                </Text>
              </>
            ) : phase.kind === 'not_started' ? (
              <>
                <Text className="font-serif text-[17px] font-semibold leading-6 text-ink">
                  Starts {shortDate(phase.startsOn)}.
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  Nothing from it lands on a day before then.
                </Text>
              </>
            ) : (
              <>
                <Text className="font-serif text-[17px] font-semibold leading-6 text-ink">
                  {where ?? 'Running'}
                </Text>
                <Text className="mt-1.5 font-mono text-[11px] text-ink-muted">
                  {`started ${shortDate(protocol.started_on ?? adherence.since ?? '—')}`}
                  {phase.window.length === null
                    ? ''
                    : ` · this phase ${durationLabel(phase.window.length)}`}
                </Text>

                {items.length === 0 ? (
                  <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
                    This phase lists no items, so it puts nothing on a day.
                  </Text>
                ) : (
                  <View className="mt-3">
                    {items.map((item) => (
                      <View key={item.id} className="mt-2 flex-row items-baseline gap-2">
                        {/* The clock is a measurement — mono, and an em-dash
                            where there is no time rather than a blank column
                            the eye reads as a rendering fault. */}
                        <Text className="w-12 font-mono text-[11px] text-ink-muted">
                          {item.scheduled_time ?? '—'}
                        </Text>
                        <Text className="flex-1 font-serif text-[14px] leading-5 text-ink">
                          {item.title}
                          {item.dose ? (
                            <Text className="font-mono text-[12px] text-ink-secondary">
                              {`  ${item.dose}`}
                            </Text>
                          ) : null}
                        </Text>
                        <Text className="font-label text-[10px] uppercase tracking-[0.5px] text-ink-muted">
                          {cadenceLabel(item.cadence)}
                        </Text>
                      </View>
                    ))}
                  </View>
                )}
              </>
            )}
          </Block>
        </View>
      </View>

      {/* 2. How it is going. */}
      <View className="mt-7">
        <SectionLabel
          label="How it is going"
          note={adherence.planned > 0 ? rateText(adherence.rate) : undefined}
        />
        <View className="mt-3">
          <Block device="plate">
            {version === null ? (
              <View className="py-1">
                <Text className="font-serif text-[15px] font-semibold text-ink">
                  Nothing saved yet
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  This protocol has no version, so it has never put anything on a day. The first
                  save writes v1.
                </Text>
              </View>
            ) : adherence.planned === 0 ? (
              <View className="py-1">
                {/* The distinction the house rules exist for: a version that
                    landed today has no record, which is a different fact from
                    a record of nothing done. Neither is 0%. */}
                <Text className="font-serif text-[15px] font-semibold text-ink">
                  {adherence.days <= 1
                    ? `v${version.version_number} landed today`
                    : 'Nothing settled to judge yet'}
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  {adherence.days <= 1
                    ? 'Adherence starts counting from tomorrow — today is still open, and an item you have not reached yet is not a miss.'
                    : 'Since this version landed, no day it covered put an item on the plan. There is no rate to state.'}
                </Text>
              </View>
            ) : (
              <>
                <View className="py-1">
                  <Text className="font-serif text-[15px] font-semibold leading-6 text-ink">
                    <Text className="font-mono">{`v${version.version_number}`}</Text>
                    {` · ${spanLabel(adherence.days)} · `}
                    <Text className="font-mono">{rateText(adherence.rate)}</Text>
                  </Text>
                  {/* The ledger reconciles: the four terms sum to the
                      denominator printed beside them. */}
                  <Text className="mt-1.5 font-mono text-[11px] leading-5 text-ink-muted">
                    {`${adherence.completed} done · ${adherence.skipped} skipped · ${adherence.partial} partial · ${untouched} untouched`}
                  </Text>
                  <Text className="font-mono text-[11px] text-ink-muted">
                    {`of ${adherence.planned} planned, ${shortDate(adherence.from ?? '')} → ${shortDate(adherence.to ?? '')}`}
                  </Text>
                </View>

                {adherence.items.map((item) => (
                  <View key={`${item.itemId ?? 'x'}:${item.title}`}>
                    <Divider />
                    <View className="flex-row items-baseline gap-3 py-2.5">
                      <Text className="flex-1 font-serif text-[14px] leading-5 text-ink">
                        {item.title}
                      </Text>
                      <Text className="font-mono text-[11px] text-ink-muted">
                        {`${item.completed}/${item.planned}`}
                      </Text>
                      <Text className="w-10 text-right font-mono text-[11px] text-ink-secondary">
                        {rateText(item.planned === 0 ? null : item.completed / item.planned)}
                      </Text>
                    </View>
                  </View>
                ))}
              </>
            )}
          </Block>
        </View>
      </View>

      {/* 3. The document. */}
      <View className="mt-7">
        <SectionLabel label="The document" />
        <View className="mt-3">
          <Block device="plate">
            <Divider first />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Edit this protocol"
              onPress={() =>
                router.push({ pathname: '/protocol-edit', params: { id: protocol.id } })
              }
              className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
              <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
              <Text className="flex-1 font-serif text-[15px] text-ink">Edit</Text>
              <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
            </Pressable>

            <Divider />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                version
                  ? `Version history, currently at version ${version.version_number}`
                  : 'Version history'
              }
              onPress={() =>
                router.push({ pathname: '/protocol-versions', params: { id: protocol.id } })
              }
              className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
              <Ionicons name="time-outline" size={17} color={palette.inkSecondary} />
              <Text className="flex-1 font-serif text-[15px] text-ink">Version history</Text>
              {/* The live version number is a measurement — mono. */}
              <Text className="font-mono text-[11px] text-ink-muted">
                {version ? `now v${version.version_number}` : 'none yet'}
              </Text>
              <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
            </Pressable>
          </Block>
        </View>
      </View>
    </Screen>
  );
}
