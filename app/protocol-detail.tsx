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
  weekdayDate,
} from '@/lib/protocols/format';

/**
 * One protocol: what it asks of you now, and whether you are doing it.
 *
 * This screen is the answer to the defect the rework was called for — *"no
 * adherence loop back to the protocol"*. `log_entries.protocol_id` has been
 * written on every generated row since the generator shipped, and preserved
 * through deletes, and nothing read it back. Now it does, per item.
 *
 * ## Four objects, in the order the questions come
 *
 * 1. **Now** — a `field` verdict: the live phase, how far into it, and what the
 *    phase actually asks for. A protocol is a plan, and the first thing to know
 *    about a plan is which part of it is running. **Each item is a row that
 *    opens the per-item editor** (2026-09-19): the verb this screen needed most
 *    was *change this item*, and until then the only way to reach one was the
 *    whole form. Those rows are CONTENT inside the field, not a nested device —
 *    a row that pushes a screen is still content (src/components/ui/block.tsx).
 * 2. **Coming up** — a `plate` of the next six days, from the projection
 *    (`planForDay` under `committing: false`). It carries ONE honesty sentence
 *    in a `margin`: a computed day must not wear the face of a committed one.
 *    A quota item never appears in it — an allowance is not a day — and reads
 *    its allowance on its NOW row instead.
 * 3. **Adherence** — a `plate`: the rate since the LIVE VERSION landed,
 *    its four-way ledger (`done · skipped · partial · untouched`) summing to
 *    the denominator beside it, and then one row per item, worst-missed first.
 *    Bounded at the live version deliberately: adherence to a protocol you have
 *    since changed is a fact about a different protocol. It moved BELOW *Coming
 *    up* in the re-cut: it led the screen, which put how well a protocol had
 *    been run above what it asks of you next.
 * 4. **The document** — a `plate` of rows into the editor and the version
 *    history, so the screen ends in an action rather than a number.
 *
 * *Settings* sits in the header's action slot — name, description, type,
 * Active/Paused, the phase anchor and the two 0050 policies. It left the
 * editor because none of it is a daily decision and all of it sat above the
 * items on a screen you open to change a dose.
 *
 * ## The two empty states are different facts and are drawn differently
 *
 * "Nothing was skipped" is not "nothing was ever logged", and this codebase has
 * shipped that confusion twice. So a protocol whose live version landed today
 * says **"v4 landed today"** and prints no rate at all; a protocol with a
 * window but no planned rows in it says the window asked for nothing. Neither
 * renders a zero.
 *
 * ## The plate's copy was re-set on 2026-09-14 (backlog A9)
 *
 * The label read **"How it is going"** and the empty states answered in kind —
 * *"Nothing settled to judge yet"*, *"There is no rate to state"*. The owner
 * named this plate as the archetype of the AI slop across the app, and he was
 * right about it: a section label is a name for what is filed under it, not an
 * assistant asking after you, and a screen that measures does not narrate its
 * own patience. The label is now the noun — **Adherence** — and every sentence
 * under it states the fact and stops. The numbers were never the problem and
 * did not change.
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

  const { protocol, version, phase, adherence, coming, allowances } = record;
  const where = phaseSummary(phase);
  const items = phase.kind === 'running' ? phase.window.phase.items : [];
  const paused = protocol.is_active !== 1;
  // planned − completed − skipped − partial: the rows that simply ran out the
  // day. Named rather than implied, so the ledger reconciles to the denominator.
  const untouched = adherence.planned - adherence.completed - adherence.skipped - adherence.partial;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader
          title={protocol.name}
          parent={PARENT}
          action={
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Protocol settings"
              onPress={() =>
                router.push({ pathname: '/protocol-settings', params: { id: protocol.id } })
              }
              hitSlop={8}
              className="min-h-[44px] justify-center pl-3 active:opacity-60">
              <Text className="font-label text-[11px] font-semibold tracking-[0.3px] text-ink-secondary">
                Settings
              </Text>
            </Pressable>
          }
        />
      </View>

      <Text className="mt-2 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
        {protocolTypeLabel(protocol.type)}
        {' · '}
        {/* A version number is a measured value inside a label — mono. */}
        <Text className="font-mono">{version ? `v${version.version_number}` : 'no version'}</Text>
        {paused ? ' · Paused' : ''}
      </Text>
      {protocol.description ? (
        /* The description reads HERE, not on the hub row — two serif lines per
           row is what made a six-protocol hub a page and a half. A margin, not
           prose on the page: it is an annotation about the file. */
        <View className="mt-3">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {protocol.description}
            </Text>
          </Block>
        </View>
      ) : null}

      {/* 1. Where it is up to — and the way into every item. */}
      <View className="mt-7">
        <SectionLabel label="Now" note={where ?? undefined} />
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
                  {/* A paused protocol's clock keeps RUNNING by design — pausing
                      a titration for a fortnight must not put you back on week
                      1 — so the phase line below stays true and the head line
                      is what says the plan is not being asked for. */}
                  {paused ? 'Paused — puts nothing on a day' : (where ?? 'Running')}
                </Text>
                <Text className="mt-1.5 font-mono text-[11px] text-ink-muted">
                  {paused ? 'clock reads ' : ''}
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
                  <View className="mt-2">
                    {items.map((item) => {
                      const allowance = allowances.get(item.id);
                      return (
                        <Pressable
                          key={item.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Edit ${item.title}, ${
                            item.scheduled_time ?? 'any time'
                          }${item.dose ? `, ${item.dose}` : ''}, ${cadenceLabel(item.cadence)}${
                            allowance ? `, ${allowance.done} of ${allowance.perWeek} this week` : ''
                          }`}
                          onPress={() =>
                            router.push({
                              pathname: '/protocol-item',
                              params: { id: protocol.id, item: item.id },
                            })
                          }
                          className="min-h-[44px] flex-row items-baseline gap-2 py-2 active:opacity-60">
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
                          <Text
                            numberOfLines={1}
                            className="font-label text-[10px] uppercase tracking-[0.5px] text-ink-muted">
                            {cadenceLabel(item.cadence)}
                            {/* A quota has no next day — it has an ALLOWANCE,
                                spread across every remaining day of the week.
                                It reads here, and never in Coming up. */}
                            {allowance ? (
                              <Text className="font-mono">
                                {` · ${allowance.done} of ${allowance.perWeek}`}
                              </Text>
                            ) : null}
                          </Text>
                          <Ionicons name="chevron-forward" size={13} color={palette.inkMuted} />
                        </Pressable>
                      );
                    })}
                  </View>
                )}
                {/* A version-less protocol renders no items, so this row is the
                    only way to give it one — and that save writes v1, exactly
                    as the Coach's tool does on the same protocol. */}
                {items.length === 0 ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Add an item"
                    onPress={() =>
                      router.push({ pathname: '/protocol-item', params: { id: protocol.id } })
                    }
                    className="mt-3 min-h-[44px] flex-row items-center gap-2 active:opacity-60">
                    <Ionicons name="add" size={16} color={palette.inkSecondary} />
                    <Text className="font-label text-[13px] text-ink-secondary">Add an item</Text>
                  </Pressable>
                ) : null}
              </>
            )}
          </Block>
        </View>
      </View>

      {/* 2. Coming up — the projection, and the one sentence that keeps it
             honest. Not drawn for a paused or ended protocol: the projection
             is empty for both, and a section headed "Coming up" over nothing
             would be a claim. */}
      {coming.length > 0 ? (
        <View className="mt-7">
          <SectionLabel label="Coming up" note="next 6 days" />
          <View className="mt-3">
            <Block device="plate">
              {coming.map((day, index) => (
                <View key={day.date}>
                  <Divider first={index === 0} />
                  <View className="flex-row items-baseline gap-3 py-2.5">
                    {/* A day is a measured value — mono. */}
                    <Text className="w-16 font-mono text-[11px] text-ink-secondary">
                      {weekdayDate(day.date)}
                    </Text>
                    <Text className="flex-1 font-serif text-[14px] leading-5 text-ink">
                      {day.titles.join(' · ')}
                    </Text>
                  </View>
                </View>
              ))}
            </Block>
          </View>
          {/* The projection's one honesty sentence. A computed day must not
              wear the face of a committed one — the provenance rule 0034
              states for numbers, and the family 00-design-spec.md §5 keeps.
              It is a margin because it annotates the plate above it. */}
          <View className="mt-2">
            <Block device="margin">
              <Text className="font-serif text-[11px] leading-4 text-ink-muted">
                Projected from the plan. These days are not committed yet.
              </Text>
            </Block>
          </View>
        </View>
      ) : null}

      {/* 3. Adherence. */}
      <View className="mt-7">
        <SectionLabel
          label="Adherence"
          note={adherence.planned > 0 ? rateText(adherence.rate) : undefined}
        />
        <View className="mt-3">
          <Block device="plate">
            {version === null ? (
              <View className="py-1">
                <Text className="font-serif text-[15px] font-semibold text-ink">
                  No version saved
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  This protocol has never put an item on a day. The first save writes v1.
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
                    : 'No planned items yet'}
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  {adherence.days <= 1
                    ? 'Counting starts tomorrow. Today is still open, and an item not yet due is not a miss.'
                    : 'No day since this version landed has put an item on the plan, so there is no rate.'}
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
                  {/* `done late` is a PARENTHETICAL inside skipped, not a fifth
                      term: a debt paid on a later day leaves the day it was
                      missed a miss and earns no rate credit (0050). The four
                      terms still reconcile to the denominator printed below. */}
                  <Text className="mt-1.5 font-mono text-[11px] leading-5 text-ink-muted">
                    {`${adherence.completed} done · ${adherence.skipped} skipped${
                      adherence.doneLate > 0 ? ` (${adherence.doneLate} done late)` : ''
                    } · ${adherence.partial} partial · ${untouched} untouched`}
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

      {/* 4. The document. */}
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
