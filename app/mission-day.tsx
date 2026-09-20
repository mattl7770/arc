import { useFocusEffect, useLocalSearchParams } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { MissionItemRow } from '@/components/home/mission-item';
import { Block, Divider } from '@/components/ui/block';
import { DayPicker } from '@/components/ui/day-picker';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { getActiveMode } from '@/lib/db/repositories/day-modes';
import { listMission, missionRecordStart, toggleMission } from '@/lib/db/repositories/mission';
import {
  backfillPastRow,
  CARRY_MAX_DAYS,
  commitDayAhead,
  MISSION_HORIZON_DAYS,
  planForDay,
  rederiveDaysAhead,
  uncommitDayAhead,
  type PlannedEntry,
} from '@/lib/db/repositories/mission-generate';
import { arriveDay } from '@/lib/db/seed';
import { deriveMissionView } from '@/lib/home/derive-mission';
import { getModeDefinition } from '@/lib/modes/registry';
import { syncReminderNotifications } from '@/lib/notifications/reminders';
import { addDays, daysBetween } from '@/lib/protocols/cadence';
import { weekdayDate } from '@/lib/protocols/format';
import { stepDay } from '@/lib/utils/day-cursor';
import type { MissionItem } from '@/types/home';

/**
 * **Plan** — the mission on a day other than today.
 *
 * ## Why it is a pushed screen and not Home
 *
 * Home answers one question — *what should I do right now* — and every section
 * on it is about now (CLAUDE.md §5). Its mission is also a forward-clamped
 * write target that must not move (`src/hooks/use-today-mission.ts`). So the
 * day picker lives here, reached by a quiet label-voice `PLAN ›` beside
 * `PROTOCOLS ›` under the mission block. Owner's call, 2026-09-19, question 1
 * option (a).
 *
 * ## Three kinds of day, and they behave differently
 *
 *   - **TODAY** is the committed rows, read through `arriveDay` — the picker is
 *     itself a way to open a day, so a day committed ahead that has since
 *     arrived is converted here exactly as it would be on Home.
 *   - **A DAY AHEAD** (up to `MISSION_HORIZON_DAYS`) is COMPUTED on view and
 *     nothing is written by looking: no `daily_logs` row, no entry. The first
 *     tick commits the whole day and ticks that row in one transaction, and
 *     un-ticking the last tick un-commits it again. It is **tick-only**: a skip
 *     ahead would be a permanent suppression (a hand-tapped skip is never
 *     carried) and a remove ahead a tombstone on a plan that may still change.
 *   - **A PAST DAY** renders the rows it actually holds, and inside the carry
 *     window (seven days) they can be **backfilled**: a row you did and forgot
 *     to tick is ticked on its own day, stamped with the day of the tap and
 *     shown as *ticked N days later*. Two rows refuse, each saying why in one
 *     serif line rather than through a checkbox that quietly does nothing — a
 *     carried copy (the debt is live on today's mission, where the gesture
 *     belongs) and a row a carried copy has already settled. Beyond the window
 *     the day is the record, and says so.
 *
 * ## The synthetic ids
 *
 * A computed day's entries have no row and therefore no id, and every seam this
 * screen reuses needs one (`deriveMissionView` sorts by time and keys by id).
 * So an entry at position `i` becomes a `MissionItem` with `id = 'plan:i'`,
 * captured BEFORE the sort — the position is the contract `commitDayAhead`
 * resolves the tapped row through, and the sort must not be allowed to change
 * what it means.
 *
 * ## Surface
 *
 * `StackHeader` "Plan", parent "Home". The picker is bare — a control row
 * carries no device — and the day's rows sit on ONE `plate`, Home's own mission
 * device, drawn with the same `MissionItemRow`. No hero and therefore no
 * snooze: `snoozedIds` is always the empty set, because snoozing is a row
 * yielding the hero slot for a Home session and there is no hero here. No fold
 * either: this screen is read whole. The only accent is the completion stamps.
 */

const PARENT = 'Home';

/** Everything the screen needs about the day in view, read in one pass. */
type DayView = {
  date: string;
  /** Where the record begins, clamped at today — the picker's back bound. */
  earliest: string | null;
  /** True when these rows exist in the database rather than being computed. */
  committed: boolean;
  items: MissionItem[];
  /** The plan a FUTURE day would contain, in plan order. Empty otherwise. */
  plan: PlannedEntry[];
  /** The day's mode label, when one is set. */
  modeLabel: string | null;
};

/** A computed plan entry as a view-model row, keyed by its POSITION. */
function toPlannedItem(entry: PlannedEntry, index: number): MissionItem {
  return {
    id: `plan:${index}`,
    title: entry.title,
    scheduledTime: entry.scheduledTime ?? undefined,
    status: 'pending',
    category: entry.extras.category ?? CATEGORY_FALLBACK[entry.type],
    dose: entry.extras.dose,
    why: entry.extras.why,
    protocol: entry.extras.protocol,
    protocolId: entry.protocolId ?? undefined,
    itemId: entry.extras.item,
  };
}

/**
 * The same fallback `toMissionItem` applies, restated for entries that have no
 * row to read it off. Kept whole rather than imported because the repository's
 * copy is private to it and a shared one would be a third definition.
 */
const CATEGORY_FALLBACK: Record<PlannedEntry['type'], string> = {
  habit: 'Routine',
  meal: 'Nutrition',
  workout: 'Training',
  supplement: 'Supplements',
  medication: 'Medications',
  therapy: 'Therapies',
  metric: 'Metrics',
  note: 'Notes',
};

function readDay(date: string, today: string): DayView {
  const db = getDb();
  // Opening TODAY through the picker is opening today: a day committed ahead
  // that has since arrived must be converted here as well as on Home, or it
  // would keep its `ahead` marks and its missing carry until Home next focused.
  if (date === today) arriveDay(db, today);
  const items = listMission(db, date);
  const committed = items.length > 0;
  const mode = getActiveMode(db, date);
  return {
    date,
    earliest: missionRecordStart(db, today),
    committed,
    items,
    // Only a future day is ever computed. Today's plan already exists as rows,
    // and re-computing it would produce a second, subtly different answer
    // beside the one the user has been ticking.
    plan: !committed && date > today ? planForDay(db, date, { today }) : [],
    modeLabel: mode === 'normal' ? null : getModeDefinition(mode).label,
  };
}

export default function MissionDayScreen() {
  // A deep link can repeat the param, which expo-router delivers as string[]
  // despite the generic — coerce so a malformed link degrades to today.
  const params = useLocalSearchParams<{ date?: string | string[] }>();
  const requested = Array.isArray(params.date) ? params.date[0] : params.date;
  // The clock is read ONCE per render pass and carried, so the picker's bound,
  // the chin's words and every write agree about which day is today even if the
  // render straddles the boundary.
  const [today, setToday] = useState(() => todayISODate());
  const [date, setDate] = useState<string>(() => {
    const now = todayISODate();
    return typeof requested === 'string'
      ? stepDay(requested, 0, { latest: addDays(now, MISSION_HORIZON_DAYS), today: now })
      : now;
  });
  const [view, setView] = useState<DayView>(() => readDay(date, today));

  const reload = useCallback(() => {
    // Roll the screen forward if the calendar moved while it was away, but only
    // when the user was looking at today — a deliberately selected other day is
    // where they meant to be, and yanking them off it is the bug
    // app/nutrition-history.tsx documents at the same seam.
    const fresh = todayISODate();
    const next = date === today ? fresh : date;
    setToday(fresh);
    if (next !== date) setDate(next);
    setView(readDay(next, fresh));
  }, [date, today]);
  useFocusEffect(reload);

  const bounds = {
    latest: addDays(today, MISSION_HORIZON_DAYS),
    today,
    // The record's own start, never earlier: a picker that walks back through
    // years of days that never existed is the same lie mission-history's window
    // clip exists to prevent. `missionRecordStart` is clamped at today, so a
    // database whose only rows sit ahead has no floor to offer and the day in
    // view is the floor.
    earliest: view.earliest ?? (date < today ? date : today),
  };

  const selectDay = (next: string) => {
    setDate(next);
    setView(readDay(next, today));
  };

  const isAhead = date > today;
  const isPast = date < today;

  /**
   * The tap. Three days, three meanings:
   *
   *   - today or a committed day ahead: the ordinary toggle, stamped with the
   *     logical day of the tap. A committed day ahead whose last tick is taken
   *     back un-commits, so the day goes back to being computed rather than
   *     standing as an empty committed day every later edit has to diff against.
   *   - an UNCOMMITTED day ahead: the first tick commits the whole day. The row
   *     is named by its POSITION in the plan this screen rendered, plus what it
   *     believes is standing there — `commitDayAhead` recomputes and writes
   *     nothing if a protocol moved between the render and the tap.
   *   - a past day: nothing yet (Phase 3).
   */
  const onToggle = (id: string) => {
    const db = getDb();
    if (isPast) {
      // The repository owns the guards — the lines below are the explanation,
      // never the enforcement. A screen that only refused visually would leave
      // the gesture reachable from the next caller.
      backfillPastRow(db, id, today);
      setView(readDay(date, today));
      void syncReminderNotifications(db);
      return;
    }
    if (view.committed || !isAhead) {
      toggleMission(db, id, today);
      if (isAhead) uncommitDayAhead(db, date, today);
    } else {
      const ordinal = Number(id.slice('plan:'.length));
      const entry = view.plan[ordinal];
      if (!entry) return;
      commitDayAhead(db, date, today, {
        ordinal,
        expect: { title: entry.title, protocolId: entry.protocolId, itemId: entry.extras.item },
      });
    }
    // A completion moves what lands on later days under `adjusting` and under a
    // quota, so a day already committed ahead would otherwise go stale on the
    // most common gesture in the app. One LIMIT 1 when nothing is committed.
    rederiveDaysAhead(db, today);
    setView(readDay(date, today));
    void syncReminderNotifications(db);
  };

  // Rows: the committed ones, or the computed plan keyed by position. Captured
  // BEFORE the sort, because the position is what a commit resolves through.
  const rows = view.committed ? view.items : view.plan.map(toPlannedItem);
  // No hero on this screen, so nothing is ever snoozed out of one.
  const ordered = deriveMissionView(rows, EMPTY_SET).items;

  return (
    <Screen scroll>
      <StackHeader title="Plan" parent={PARENT} />

      <View className="mt-2">
        <DayPicker date={date} bounds={bounds} onChange={selectDay} subject="mission" />
      </View>

      {/* What the day IS, when it is not an ordinary one. Mono, the register
          Home uses for a fact about the calendar, and absent under Normal. */}
      {view.modeLabel ? (
        <Text className="mt-3 font-mono text-[11px] leading-4 text-ink-muted">
          {`${view.modeLabel} mode`}
        </Text>
      ) : null}

      <View className="mt-5">
        {ordered.length > 0 ? (
          <Block device="plate">
            <SectionLabel
              label="The day"
              note={`${ordered.filter((i) => i.status === 'completed').length} of ${ordered.length}`}
            />
            <View className="mt-1">
              {ordered.map((item, index) => {
                const refusal = isPast ? pastRefusal(item, date, today) : null;
                return (
                  <View key={item.id}>
                    <Divider first={index === 0} />
                    {/* No `onOpen`: a computed row has no stored row to open,
                        and the item sheet's verbs are Home's business. This
                        screen is the plan, not the item — so the chevron is not
                        drawn and the named VoiceOver action is not offered,
                        rather than being offered and doing nothing. */}
                    <MissionItemRow item={item} ahead={isAhead} onToggle={onToggle} />
                    {/* Why this one row cannot be ticked here, in words. A
                        disabled checkbox with no explanation is the failure
                        00-design-spec.md §5 names; the line says where the
                        gesture does belong. */}
                    {refusal ? (
                      <Text className="mb-3 font-serif text-[13px] italic leading-5 text-ink-secondary">
                        {refusal}
                      </Text>
                    ) : null}
                  </View>
                );
              })}
            </View>
          </Block>
        ) : (
          <EmptyDay date={date} today={today} />
        )}
      </View>

      {/* Beyond the carry window a past day is the record and nothing else. A
          miss older than a week is a fact about the PROTOCOL — which is what
          mission-history's "Where it's failing" answers — not a tick someone
          forgot. Said in one line, never by a plate of checkboxes that refuse
          without explaining. */}
      {isPast && ordered.length > 0 && daysBetween(date, today) > CARRY_MAX_DAYS ? (
        <Text className="mt-4 font-serif text-[14px] leading-6 text-ink-secondary">
          This day is settled. More than a week back, the record stands as it is.
        </Text>
      ) : null}
    </Screen>
  );
}

/** A stable identity, so `deriveMissionView`'s memo-friendly shape is not fought. */
const EMPTY_SET: ReadonlySet<string> = new Set<string>();

/**
 * Why THIS row on a past day cannot be ticked here, or null when it can.
 *
 * The explanation only — `backfillPastRow` owns the enforcement, and the two
 * must agree. Each line says where the gesture does belong rather than merely
 * that it is refused; the one thing worse than a control that does nothing is a
 * control that does nothing silently.
 */
function pastRefusal(item: MissionItem, date: string, today: string): string | null {
  if (daysBetween(date, today) > CARRY_MAX_DAYS) return null; // the day says it once, below
  if (item.carriedFrom !== undefined) {
    return `Owed from ${weekdayDate(item.carriedFrom.date)}. It is live on today’s mission — tick it there.`;
  }
  if (item.lateOn !== undefined) {
    return `Already done late, on ${weekdayDate(item.lateOn)}. Un-tick it there to re-open it.`;
  }
  return null;
}

/**
 * An empty day, authored — never a blank (00-design-spec.md §5). Three
 * different facts, and a reader must be able to tell them apart:
 *
 *   - a FUTURE day your protocols put nothing on. Real, and worth seeing: an
 *     every-3-days stack has empty days by design, and those are exactly the
 *     days worth checking tomorrow on.
 *   - a PAST day on which no plan was ever generated — the app was not opened,
 *     or nothing applied. Distinct from a day that HAD a plan, which draws its
 *     rows instead.
 *   - TODAY with nothing on it, which is Home's own empty state and says so
 *     there; here it is one line, because the action belongs on Home.
 */
function EmptyDay({ date, today }: { date: string; today: string }) {
  const line =
    date > today
      ? 'Your protocols put nothing on this day.'
      : date < today
        ? 'No plan was generated on this day.'
        : 'Your protocols put nothing on today.';
  return <Text className="font-serif text-[15px] leading-6 text-ink-secondary">{line}</Text>;
}
