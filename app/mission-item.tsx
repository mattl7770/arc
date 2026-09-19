import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { MoveControl } from '@/components/protocols/move-control';
import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useMissionItem, type MissionItemView } from '@/hooks/use-mission-item';
import { getDb } from '@/lib/db/client';
import {
  moveMissionItem,
  removeMissionItem,
  setMissionStatus,
  skipCarried,
} from '@/lib/db/repositories/mission';
import { unsnoozeItem } from '@/lib/home/snooze-store';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
import { cadenceLabel, phaseSummary, weekdayDate } from '@/lib/protocols/format';

/**
 * One mission row, opened.
 *
 * ## What this screen is for
 *
 * A mission row was a dead end. It could be ticked and nothing else: it could
 * not say which protocol put it there, could not be skipped, moved, removed,
 * un-snoozed or un-skipped by hand, and could not reach the protocol that made
 * it. Every one of those verbs already existed in the repository — `moveMissionItem`
 * and `removeMissionItem` have shipped with their guards since the Coach's
 * mission tools, and nothing in the app drew them — and every fact needed to
 * offer them was already stamped on the row.
 *
 * The row's tap stays a **toggle**. This opens from the trailing chevron and
 * from a named VoiceOver action on the row (src/components/home/mission-item.tsx),
 * so nothing about the one-tap check-off changes.
 *
 * ## Accent budget: ZERO
 *
 * The same reason the protocol detail has none: this is a screen you read and
 * choose from, and none of these verbs is THE next action — the hero on Home
 * is. A filled control here would claim otherwise.
 *
 * ## Devices, one per block
 *
 * The owed-from line is a `margin` (a note in the gutter), the cadence a
 * `field`, the verbs and the two doors are `plate`s. The move control carries
 * **no block** — it is a form, form (b) of the capture-surface rule — and opens
 * BELOW the verbs plate rather than inside it, because a recessed field on
 * raised plate stock is the surface inversion block.tsx exists to stop.
 */

const PARENT = 'Home';

export default function MissionItemScreen() {
  // A deep link can repeat the param (?id=a&id=b), which expo-router delivers
  // as string[] despite the generic — coerce so a malformed link degrades to
  // the "no longer on today" branch instead of throwing at the SQLite bind.
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const view = useMissionItem(id);

  if (!view) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Item" parent={PARENT} />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This item is no longer on today.
        </Text>
      </Screen>
    );
  }

  return <MissionItemSheet view={view} />;
}

function MissionItemSheet({ view }: { view: MissionItemView }) {
  const router = useRouter();
  const [moving, setMoving] = useState(false);
  const { item, protocol, phase, definition, nextOn, allowance, snoozed } = view;

  /** Every write here settles or re-opens a row, so every one re-syncs C10. */
  const after = () => {
    view.reload();
    void syncReminderNotifications(getDb());
  };

  const head = [item.category, protocol?.name, phase ? phaseSummary(phase) : null]
    .filter(Boolean)
    .join(' · ');
  // When and how much — both measured, so both mono, exactly as the hero sets
  // the same two facts.
  const figure = [item.scheduledTime, item.dose].filter(Boolean).join(' · ');

  return (
    <Screen scroll>
      <View className="pt-2">
        {/* The title is printed WHOLE here. The row on Home truncates it to one
            line to make room for the chevron, and this is where that cost is
            paid back. */}
        <StackHeader title={item.title} parent={PARENT} />
      </View>

      {head ? (
        <Text className="mt-2 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
          {head}
        </Text>
      ) : null}
      {figure ? <Text className="mt-2 font-mono text-[12px] text-ink">{figure}</Text> : null}
      {item.why ? (
        <Text className="mt-2 font-serif text-[13px] italic leading-5 text-ink-secondary">
          {item.why}
        </Text>
      ) : null}

      {item.carriedFrom ? (
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              {`Owed from ${weekdayDate(item.carriedFrom.date)}`}
              {item.carriedDays ? ` · ${item.carriedDays} day${item.carriedDays === 1 ? '' : 's'} late` : ''}
            </Text>
          </Block>
        </View>
      ) : null}

      {/* CADENCE — only for a row that still has an item behind it. */}
      {protocol ? (
        <View className="mt-7">
          <SectionLabel label="Cadence" />
          <View className="mt-3">
            <Block device="field">
              {definition === null ? (
                <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                  This item is no longer in the live version, so it has no cadence to state. The
                  row stands until the day ends.
                </Text>
              ) : allowance ? (
                <Text className="font-serif text-[14px] leading-6 text-ink">
                  {cadenceLabel(definition.cadence)}
                  {'  ·  '}
                  {/* An allowance is a count, so it is mono — and it is the
                      whole honest answer for a quota. A quota has no next day:
                      it is spread across every remaining day of the week until
                      it is met, and printing a day for one would be inventing
                      a fact the plan does not hold. */}
                  <Text className="font-mono text-[12px] text-ink-secondary">
                    {`${allowance.done} of ${allowance.perWeek} this week`}
                  </Text>
                </Text>
              ) : (
                <Text className="font-serif text-[14px] leading-6 text-ink">
                  {cadenceLabel(definition.cadence)}
                  {nextOn ? (
                    <Text className="font-mono text-[12px] text-ink-secondary">
                      {`  ·  next ${weekdayDate(nextOn)}`}
                    </Text>
                  ) : null}
                </Text>
              )}
            </Block>
          </View>
        </View>
      ) : null}

      {/* TODAY — the verbs. Drawn for every row, including a mode item and an
          experiment's intervention, which have no protocol behind them but are
          still rows on a day. */}
      <View className="mt-7">
        <SectionLabel label="Today" />
        <View className="mt-3">
          <Block device="plate">
            {item.status === 'pending' ? (
              <>
                <Divider first />
                <Row
                  icon="remove-circle-outline"
                  label="Skip today"
                  onPress={() => {
                    // A carried row IS the debt, so skipping it has to reach
                    // the original — leaving that row `pending` would re-levy
                    // the same miss tomorrow and make the skip meaningless.
                    if (item.carriedFrom) skipCarried(getDb(), item.id);
                    else setMissionStatus(getDb(), item.id, 'skipped');
                    after();
                  }}
                />
                <Divider />
                <Row
                  icon="time-outline"
                  label="Move to …"
                  expanded={moving}
                  onPress={() => setMoving((open) => !open)}
                />
                <Divider />
                <Row
                  icon="close-circle-outline"
                  label="Remove from today"
                  onPress={() => {
                    if (item.dailyLogId) removeMissionItem(getDb(), item.dailyLogId, item.id);
                    after();
                    router.back();
                  }}
                />
                {snoozed ? (
                  <>
                    <Divider />
                    <Row
                      icon="arrow-undo-outline"
                      label="Unsnooze"
                      onPress={() => {
                        unsnoozeItem(item.id);
                        after();
                      }}
                    />
                  </>
                ) : null}
              </>
            ) : item.status === 'skipped' ? (
              item.carriedFrom ? (
                <>
                  <Divider first />
                  <Row
                    icon="arrow-undo-outline"
                    label="Put back"
                    onPress={() => {
                      setMissionStatus(getDb(), item.id, 'pending');
                      after();
                    }}
                  />
                </>
              ) : (
                /* Authored, one sentence: since 2026-09-19 the row's own tap is
                   the undo, so a second control for it here would be chrome. */
                <Text className="py-1 font-serif text-[13px] leading-5 text-ink-secondary">
                  Skipped. Tap the row on Home to put it back.
                </Text>
              )
            ) : item.status === 'partial' ? (
              <>
                <Divider first />
                <Row
                  icon="arrow-undo-outline"
                  label="Put back"
                  onPress={() => {
                    setMissionStatus(getDb(), item.id, 'pending');
                    after();
                  }}
                />
              </>
            ) : (
              <>
                <Divider first />
                <Row
                  icon="arrow-undo-outline"
                  label="Mark not done"
                  onPress={() => {
                    setMissionStatus(getDb(), item.id, 'pending');
                    after();
                  }}
                />
              </>
            )}
          </Block>
        </View>

        {moving && item.status === 'pending' ? (
          <View className="mt-5">
            <SectionLabel label="Move to" />
            <MoveControl
              initial={item.scheduledTime ?? ''}
              onMove={(time) => {
                if (item.dailyLogId) moveMissionItem(getDb(), item.dailyLogId, item.id, time);
                setMoving(false);
                after();
              }}
            />
          </View>
        ) : null}

        {item.carriedFrom ? (
          /* What *Remove* does to a debt, said where it can be acted on. */
          <Text className="mt-3 font-serif text-[12px] leading-4 text-ink-muted">
            Removing this copy clears it from today only. The debt is owed from{' '}
            {weekdayDate(item.carriedFrom.date)} and comes back tomorrow.
          </Text>
        ) : null}
      </View>

      {/* THE ITEM — the two doors, for a row that came from a protocol. */}
      {protocol && definition ? (
        <View className="mt-7">
          <SectionLabel label="The item" />
          <View className="mt-3">
            <Block device="plate">
              <Divider first />
              <Row
                icon="create-outline"
                label="Edit this item"
                chevron
                onPress={() =>
                  router.push({
                    pathname: '/protocol-item',
                    params: { id: protocol.id, item: definition.id },
                  })
                }
              />
              <Divider />
              <Row
                icon="git-branch-outline"
                label={`Open ${protocol.name}`}
                chevron
                onPress={() =>
                  router.push({ pathname: '/protocol-detail', params: { id: protocol.id } })
                }
              />
            </Block>
          </View>
        </View>
      ) : null}
    </Screen>
  );
}

/** One verb or one door. Neutral ink throughout — this screen spends no accent. */
function Row({
  icon,
  label,
  onPress,
  chevron,
  expanded,
}: {
  icon: React.ComponentProps<typeof Ionicons>['name'];
  label: string;
  onPress: () => void;
  /** A door, not a verb: it pushes a screen and says so. */
  chevron?: boolean;
  /** For a control that opens something below it, so the state is announced. */
  expanded?: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={expanded === undefined ? undefined : { expanded }}
      onPress={onPress}
      className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
      <Ionicons name={icon} size={17} color={palette.inkSecondary} />
      <Text className="flex-1 font-serif text-[15px] text-ink">{label}</Text>
      {chevron ? <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} /> : null}
      {expanded !== undefined ? (
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-down'}
          size={14}
          color={palette.inkMuted}
        />
      ) : null}
    </Pressable>
  );
}
