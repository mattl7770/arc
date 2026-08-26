import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { getPreferences, getWaterTarget, setWaterTarget } from '@/lib/db/repositories/user';
import {
  deleteWaterEntry,
  listWaterEntries,
  logWater,
  updateWaterEntry,
  waterDaySeries,
  waterRecordStart,
  type WaterDay,
  type WaterEntry,
} from '@/lib/db/repositories/water';
import { shortDate, windowLabel } from '@/lib/experiments/format';
import { metricByKey, resolveDisplay, roundToSpec, type DisplaySpec } from '@/lib/log/metrics';
import { daysBetween } from '@/lib/screenings/format';

/**
 * The water record — what sits behind the Data tab's **Water** trend row, and
 * the one screen in the app that tracks, logs AND edits a single metric.
 *
 * ## Water is stored per capture, and that was checked, not assumed
 *
 * The design question here was whether *"edit water related entries"* is even
 * expressible, because a mutable running daily total has no entries to edit. It
 * is: every capture is its own `wearable_data` row, the table's only unique
 * index is partial on `(source_device, source_raw_id)` and manual rows leave
 * that id NULL, so two logs on one day are two rows and each can be corrected or
 * removed on its own. The full finding, and why the mutable-total trap belongs
 * to HealthKit's day buckets rather than to water, is recorded at the head of
 * src/lib/db/repositories/water.ts. **No migration was needed.**
 *
 * ## Four objects, in the order the question is asked
 *
 * 1. **Today** (`field` — the verdict, and the only verdict here): the day's
 *    total, against the goal if one is set, with the day's own proportion bar.
 * 2. **Add** (`plate`): three unit-aware quick amounts and a free entry, writing
 *    straight to the day in view. The point of the screen is that logging water
 *    does not cost a trip to the keypad.
 * 3. **Entries** (`plate`): the day's captures, each one tappable into an inline
 *    editor with Save and a two-tap Delete. This is the half most likely to be
 *    skipped, so it is the half the screen is built around.
 * 4. **By day** (`plate`): the window, newest first, each day a proportion bar
 *    and each day selectable — which is how a PAST entry is reached and
 *    corrected without a second route.
 *
 * Then the goal row, because a screen that judges against a target has to reach
 * the target.
 *
 * ## The day in view is a selection, and everything follows it
 *
 * `day` drives Today, Add, and Entries together. Tapping a row in **By day**
 * moves all three, so correcting last Tuesday's mis-typed bottle is: open the
 * day, tap the entry, fix the number. Add writes to the selected day too and
 * says so in its own header ("Add · Aug 12") whenever that day is not today —
 * a block that silently backdates would be worse than one that cannot.
 *
 * ## Units are the user's, never ml
 *
 * Storage is canonical ml; every figure on this screen is rendered through
 * `resolveDisplay(water, units)`, and every number the user TYPES is read back
 * through the same spec. The oz/ml switch in Settings therefore changes this
 * screen entirely without touching a stored row. The quick amounts are per-unit
 * literals (a "bottle" is 16 oz or 500 ml, not 473 ml) — the same table
 * app/metric-entry.tsx uses, for the same reason.
 *
 * ## No target is a real state, not a zero
 *
 * There is no stock hydration goal and there must not be one: an invented
 * denominator would manufacture a percentage, a bar and an implied failure out
 * of a number ARC chose. Until the user sets one, this screen prints the total
 * and nothing else — no bar, no percent, no "of". The goal lives in the
 * preferences blob (`goals.waterMl`), so raising it re-judges the history
 * against the new number; the trade-off against versioning it like
 * `nutrition_targets` is argued in src/lib/db/repositories/user.ts.
 *
 * ## Three absences, three different sentences — and none of them a zero
 *
 * | State | What it says |
 * | --- | --- |
 * | Never logged any water | "No water logged yet." + the stamp with the quick amounts |
 * | A day inside the record with none | the row reads "Nothing logged" and an em-dash |
 * | Under a week on record | "Only N days on record — too little to read as a trend." |
 *
 * A day with nothing logged and a day with a small amount are different facts,
 * so `entries === 0` — never `ml === 0` — is what selects the empty (a capture
 * is always positive, so the two would agree today; keying on the count is what
 * keeps them apart if that ever stops being true).
 *
 * ## Ink
 *
 * Hydration against a goal is **behaviour, not biology** — an adherence reading,
 * not a biomarker — so no `signal-*` colour appears here at any point; that
 * firewall runs both ways (00-design-spec.md §2). The accent (pine) marks
 * intake and nothing else, and it is spent on exactly one thing per state:
 * the per-day bars, OR — on a database that has never logged water — the single
 * stamp that gets the first amount in.
 *
 * Date formatting comes from `@/lib/experiments/format`; Hermes has no `Intl`
 * and there is no reason for a ninth hand-rolled month table.
 */

/**
 * The window. **14, to agree with the row that opens this screen** — the Data
 * tab's Water trend draws a 14-point series, and a drill-down that judged 30
 * would disagree with the sparkline about the same fortnight.
 */
const WINDOW_DAYS = 14;

/** Under this many days on record, the average is stated but explicitly disclaimed. */
const TREND_FLOOR = 7;

/**
 * The quick amounts, in the DISPLAY unit — the same table and the same values as
 * the keypad's (app/metric-entry.tsx), so one tap means the same thing wherever
 * it is made. Per-unit literals rather than a converted oz figure: a metric
 * bottle is 500 ml, not 473, and a rounded conversion would log a number the
 * user did not choose.
 *
 * Whole class strings, never a built fragment — Tailwind's scanner only sees
 * names that appear literally in source.
 */
const QUICK: Record<'oz' | 'ml', readonly { label: string; amount: number }[]> = {
  oz: [
    { label: 'Glass', amount: 8 },
    { label: 'Bottle', amount: 16 },
    { label: 'Large', amount: 24 },
  ],
  ml: [
    { label: 'Glass', amount: 240 },
    { label: 'Bottle', amount: 500 },
    { label: 'Large', amount: 750 },
  ],
};

/** A typed amount is a display number; the cap stops a fat-fingered 99999. */
const MAX_DISPLAY = 10000;

type WaterView = {
  today: string;
  /** First day ever logged, or null when water has never been logged. */
  recordStart: string | null;
  /** True calendar length of the record, which may exceed the window. */
  daysOnRecord: number;
  /** The window, clipped to the record. Oldest → today. */
  days: WaterDay[];
  /** Canonical ml, or null when the user has set no goal. */
  targetMl: number | null;
  spec: DisplaySpec;
  volumeUnit: 'oz' | 'ml';
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/**
 * "1 entry" / "2 entries" — its own helper because {@link plural} appends a bare
 * `s` and would print "2 entrys". Caught by the render suite, which is the point
 * of asserting on the words the screen actually shows rather than on its shape.
 */
function entryCount(n: number): string {
  return `${n} ${n === 1 ? 'entry' : 'entries'}`;
}

/** 1840 -> "1,840", hand-rolled so the thousands comma doesn't lean on Intl. */
function fmtInt(n: number): string {
  return Math.round(n)
    .toString()
    .replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

function read(): WaterView {
  const db = getDb();
  const today = todayISODate();
  const units = getPreferences(db).units;
  const metric = metricByKey('water')!;
  const spec = resolveDisplay(metric, units);
  const recordStart = waterRecordStart(db);

  const series = waterDaySeries(db, WINDOW_DAYS, today);
  // Clipped to the record's own start: a four-day-old record draws four rows,
  // never a fortnight of empty that reads as a fortnight of not drinking.
  const days = recordStart === null ? [] : series.filter((p) => p.date >= recordStart);

  return {
    today,
    recordStart,
    // Clamped at 1: a record cannot be shorter than the day it began on, and
    // every elapsed computation in this codebase clamps rather than trusting two
    // clocks to agree (SQLite's `now` reads a finer clock than Date.now()).
    daysOnRecord: recordStart === null ? 0 : Math.max(1, daysBetween(recordStart, today) + 1),
    days,
    targetMl: getWaterTarget(db),
    spec,
    volumeUnit: units.volume === 'ml' ? 'ml' : 'oz',
  };
}

/** Canonical ml -> a rounded display number in the user's unit. */
function toDisplay(spec: DisplaySpec, ml: number): number {
  return roundToSpec(spec, spec.fromCanonical(ml));
}

/** "51 oz" — a canonical value in the user's unit, with the thousands comma. */
function fmtVolume(spec: DisplaySpec, ml: number): string {
  return `${fmtInt(toDisplay(spec, ml))} ${spec.unit}`;
}

export default function WaterScreen() {
  const [view, setView] = useState(read);
  // The day every other block follows. Held separately from `view` so a reload
  // never yanks the user back to today mid-correction.
  const [day, setDay] = useState<string>(() => todayISODate());
  const [entries, setEntries] = useState<WaterEntry[]>(() => listWaterEntries(getDb(), day));

  /** The entry open in the inline editor, and the text in its field. */
  const [editing, setEditing] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [deleteArmed, setDeleteArmed] = useState(false);
  /** The free-amount field in the Add block. */
  const [addText, setAddText] = useState('');
  /** The goal field, open only while the user is changing it. */
  const [goalOpen, setGoalOpen] = useState(false);
  const [goalText, setGoalText] = useState('');

  const refresh = useCallback((forDay: string) => {
    setView(read());
    setEntries(listWaterEntries(getDb(), forDay));
  }, []);

  // op-sqlite is synchronous, so the first read already ran in the initializers
  // above; this re-reads on return from Settings (a unit or goal may have
  // changed). It also rolls the selected day forward when the calendar day
  // changed while the screen was away — but ONLY when the user was tracking
  // "today" (day still equals the day that was current at the last read). A
  // deliberately selected past day is a correction in progress and stays put.
  // The no-focus case (the screen simply left open across midnight, no event to
  // run this) is handled at write time in `add`, where the log day is resolved
  // fresh — so a stale `day` can never backdate the new day's first glass.
  useFocusEffect(
    useCallback(() => {
      const freshToday = todayISODate();
      const nextDay = day === view.today ? freshToday : day;
      if (nextDay !== day) setDay(nextDay);
      refresh(nextDay);
    }, [refresh, day, view.today])
  );

  const { today, recordStart, daysOnRecord, days, targetMl, spec, volumeUnit } = view;

  const selectDay = (next: string) => {
    setDay(next);
    setEditing(null);
    setDeleteArmed(false);
    setEntries(listWaterEntries(getDb(), next));
  };

  const add = (displayAmount: number) => {
    if (!Number.isFinite(displayAmount) || displayAmount <= 0) return;
    if (displayAmount > MAX_DISPLAY) return;
    // Resolve the log day fresh when the user is tracking "today". If the screen
    // sat open across midnight no focus event fires to roll `day` over, so
    // trusting it would backdate the new day's first glass to yesterday; a
    // deliberately selected past day (day !== today) is honoured as-is.
    const writeDay = day === today ? todayISODate() : day;
    try {
      logWater(getDb(), writeDay, spec.toCanonical(displayAmount));
      setAddText('');
      // Follow a rollover so Today/Add/Entries all show the day just written to.
      if (writeDay !== day) setDay(writeDay);
      refresh(writeDay);
    } catch (error) {
      console.warn('[water] log failed', error);
    }
  };

  const saveEdit = (id: string) => {
    const typed = Number(editText);
    if (!Number.isFinite(typed) || typed <= 0 || typed > MAX_DISPLAY) return;
    try {
      updateWaterEntry(getDb(), id, spec.toCanonical(typed));
      setEditing(null);
      refresh(day);
    } catch (error) {
      console.warn('[water] edit failed', error);
    }
  };

  const remove = (id: string) => {
    // Two taps, like every other destructive control in the app
    // (app/meal-detail.tsx): the first arms, the second removes.
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    try {
      deleteWaterEntry(getDb(), id);
      setEditing(null);
      setDeleteArmed(false);
      refresh(day);
    } catch (error) {
      console.warn('[water] delete failed', error);
    }
  };

  const saveGoal = () => {
    const typed = Number(goalText);
    const next =
      goalText.trim() === '' || !Number.isFinite(typed) || typed <= 0
        ? null
        : spec.toCanonical(typed);
    setWaterTarget(getDb(), next);
    setGoalOpen(false);
    refresh(day);
  };

  // --- The day in view ------------------------------------------------------
  const selected = days.find((d) => d.date === day) ?? { date: day, ml: 0, entries: 0 };
  const logged = selected.entries > 0;
  const pct = targetMl && targetMl > 0 ? Math.min(100, (selected.ml / targetMl) * 100) : null;
  const isToday = day === today;
  const dayName = isToday ? 'today' : shortDate(day);

  // --- The window's reading -------------------------------------------------
  // The average is over days ON RECORD, not over the calendar window: dividing
  // by 14 when the record is 4 days old would under-report by a factor of three.
  const daysInWindow = days.length;
  const windowMl = days.reduce((sum, d) => sum + d.ml, 0);
  const averageMl = daysInWindow > 0 ? windowMl / daysInWindow : null;
  const daysLogged = days.filter((d) => d.entries > 0).length;

  // The authored sentence under the verdict. Null once the record is long enough
  // for the figures to stand alone — a heading with a permanent line of prose
  // beneath it is exactly the filler the owner has twice asked to lose.
  let verdict: string | null = null;
  if (recordStart === null) {
    verdict = 'No water logged yet. Tap an amount below and the record starts.';
  } else if (!logged && isToday) {
    verdict = 'Nothing logged today yet.';
  } else if (!logged) {
    verdict = `Nothing was logged on ${shortDate(day)}.`;
  } else if (daysInWindow < TREND_FLOOR) {
    verdict = `Only ${plural(daysInWindow, 'day')} on record — too little to read as a trend.`;
  }

  const newestFirst = [...days].reverse();
  const rowClass = 'min-h-[44px] flex-row items-center gap-3 py-3';

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Water" parent="Data" />
      </View>

      {/* a. The verdict for the day in view. A measured field, not a plate:
          this is a reading taken off the record below it, not a record. */}
      <View className="mt-6">
        <Block device="field">
          <SectionLabel
            label={isToday ? 'Today' : shortDate(day)}
            note={recordStart !== null ? `${plural(daysOnRecord, 'day')} on record` : undefined}
          />
          <View className="mt-2 flex-row items-baseline gap-1.5">
            {/* No data, no number: an em-dash, never a stand-in zero. A day with
                nothing logged and a day of 0 are different facts. */}
            <Text
              className={
                logged ? 'font-mono text-4xl text-ink' : 'font-mono text-4xl text-ink-muted'
              }>
              {logged ? fmtInt(toDisplay(spec, selected.ml)) : '—'}
            </Text>
            {logged ? <Text className="font-mono text-sm text-ink-muted">{spec.unit}</Text> : null}
            {/* The denominator appears ONLY when the user set one. */}
            {logged && targetMl !== null ? (
              <Text className="font-mono text-sm text-ink-muted">
                {`of ${fmtVolume(spec, targetMl)}`}
              </Text>
            ) : null}
          </View>

          {/* The intake mark. Behaviour, so the accent — never a signal colour.
              A filled track and a filled fill: no borders anywhere near a rule
              this thin (a one-sided border width would paint a rectangle). */}
          {pct !== null && logged ? (
            <View className="mt-2.5 h-[3px] bg-paper-deep">
              <View className="h-[3px] bg-pine" style={{ width: `${pct}%` }} />
            </View>
          ) : null}

          {logged ? (
            <Text className="mt-2 font-mono text-[10px] text-ink-muted">
              {`${entryCount(selected.entries)}${
                targetMl !== null ? ` · ${Math.round((selected.ml / targetMl) * 100)}% of goal` : ''
              }`}
            </Text>
          ) : null}

          {verdict ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              {verdict}
            </Text>
          ) : null}
        </Block>
      </View>

      {/* b. Log — the reason this screen exists rather than a link to the
          keypad. Three amounts at one tap, plus a free entry for anything else.
          Writes to the SELECTED day, and says so when that is not today. */}
      <View className="mt-8">
        <Block device="plate">
          <SectionLabel label="Add" note={isToday ? undefined : `to ${shortDate(day)}`} />
          <View className="mt-2 flex-row gap-2">
            {QUICK[volumeUnit].map((q) => (
              <Pressable
                key={q.label}
                accessibilityRole="button"
                accessibilityLabel={`Add ${q.amount} ${spec.unit} of water, ${q.label}, to ${dayName}`}
                onPress={() => add(q.amount)}
                className="min-h-[44px] flex-1 items-center justify-center rounded-btn border border-hairline bg-paper-hi px-1 py-2 active:bg-paper-dim">
                <Text className="font-label text-[12px] font-semibold text-ink">{q.label}</Text>
                <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                  {`+${q.amount} ${spec.unit}`}
                </Text>
              </Pressable>
            ))}
          </View>

          <View className="mt-2 flex-row items-center gap-2">
            {/* An input is never `bg-paper-hi` — capture stock recesses. */}
            <TextInput
              accessibilityLabel={`Amount in ${spec.unit}`}
              value={addText}
              onChangeText={setAddText}
              keyboardType="numeric"
              placeholder={`Amount in ${spec.unit}`}
              placeholderTextColor={palette.inkMuted}
              className="min-h-[44px] flex-1 rounded-btn border border-paper-deep bg-paper-dim px-3 py-2 font-mono text-[15px] text-ink"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Add ${addText || 'the typed amount'} ${spec.unit} to ${dayName}`}
              disabled={addText.trim() === ''}
              onPress={() => add(Number(addText))}
              className={
                addText.trim() === ''
                  ? 'min-h-[44px] flex-row items-center justify-center gap-1.5 rounded-btn bg-paper-deep px-4 py-2'
                  : 'min-h-[44px] flex-row items-center justify-center gap-1.5 rounded-btn bg-pine px-4 py-2 active:opacity-70'
              }>
              <Text
                className={
                  addText.trim() === ''
                    ? 'font-label text-[14px] font-semibold text-ink-muted'
                    : 'font-label text-[14px] font-semibold text-pine-on'
                }>
                Add
              </Text>
            </Pressable>
          </View>
        </Block>
      </View>

      {/* c. Edit — the day's captures, each one correctable and removable. The
          half most likely to be skipped, so it is the half with the most care:
          a device-sourced row (none today, but the schema allows one) is drawn
          without the affordance rather than offering an edit the next sync
          would silently revert. */}
      <View className="mt-8">
        <Block device="plate">
          <SectionLabel label="Entries" note={isToday ? 'today' : shortDate(day)} />
          {entries.length === 0 ? (
            <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
              {isToday
                ? 'Nothing logged today. Anything you add appears here to correct or remove.'
                : `Nothing was logged on ${shortDate(day)}.`}
            </Text>
          ) : (
            <View className="mt-1">
              {entries.map((entry, index) => {
                const open = editing === entry.id;
                return (
                  <View key={entry.id}>
                    <Divider first={index === 0} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ expanded: open }}
                      accessibilityLabel={
                        entry.editable
                          ? `${fmtVolume(spec, entry.ml)} at ${clockFromISO(entry.at)}. ${
                              open ? 'Close' : 'Edit'
                            }.`
                          : `${fmtVolume(spec, entry.ml)} at ${clockFromISO(entry.at)}, from ${
                              entry.source
                            }. Not editable.`
                      }
                      disabled={!entry.editable}
                      onPress={() => {
                        setDeleteArmed(false);
                        if (open) {
                          setEditing(null);
                          return;
                        }
                        setEditing(entry.id);
                        setEditText(String(toDisplay(spec, entry.ml)));
                      }}
                      className={`${rowClass} active:opacity-60`}>
                      <Text className="w-14 font-mono text-[11px] text-ink-muted">
                        {clockFromISO(entry.at)}
                      </Text>
                      <View className="flex-1">
                        <Text className="font-mono text-[15px] text-ink">
                          {fmtVolume(spec, entry.ml)}
                        </Text>
                        {/* Provenance only where it is NOT the ordinary case —
                            a manual row says nothing, because everything here is
                            manual until a device channel exists. */}
                        {entry.editable ? null : (
                          <Text className="mt-0.5 font-serif text-[11px] leading-4 text-ink-muted">
                            {`From ${entry.source} — edit it there.`}
                          </Text>
                        )}
                      </View>
                      {entry.editable ? (
                        <Ionicons
                          name={open ? 'chevron-up' : 'chevron-down'}
                          size={14}
                          color={palette.inkMuted}
                        />
                      ) : null}
                    </Pressable>

                    {open ? (
                      <View className="pb-3">
                        <View className="flex-row items-center gap-2">
                          <TextInput
                            accessibilityLabel={`Corrected amount in ${spec.unit}`}
                            value={editText}
                            onChangeText={setEditText}
                            keyboardType="numeric"
                            placeholderTextColor={palette.inkMuted}
                            className="min-h-[44px] flex-1 rounded-btn border border-paper-deep bg-paper-dim px-3 py-2 font-mono text-[15px] text-ink"
                          />
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel="Save the corrected amount"
                            onPress={() => saveEdit(entry.id)}
                            className="min-h-[44px] items-center justify-center rounded-btn bg-pine px-4 py-2 active:opacity-70">
                            <Text className="font-label text-[14px] font-semibold text-pine-on">
                              Save
                            </Text>
                          </Pressable>
                        </View>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            deleteArmed ? 'Confirm removing this entry' : 'Remove this entry'
                          }
                          onPress={() => remove(entry.id)}
                          className="mt-2 min-h-[44px] flex-row items-center justify-center gap-1.5 rounded-btn border border-hairline px-4 py-2 active:opacity-60">
                          <Ionicons name="trash-outline" size={15} color={palette.inkSecondary} />
                          <Text className="font-label text-[14px] font-semibold text-ink-secondary">
                            {deleteArmed ? 'Tap again to remove' : 'Remove'}
                          </Text>
                        </Pressable>
                      </View>
                    ) : null}
                  </View>
                );
              })}
            </View>
          )}
        </Block>
      </View>

      {/* d. The record. Clipped to the record's own start, and every row is the
          way into that day's entries — which is how a PAST capture is corrected
          without a second route. */}
      {days.length > 0 ? (
        <View className="mt-8">
          <Block device="plate">
            <SectionLabel
              label="By day"
              note={
                days.length === 1
                  ? shortDate(days[0]!.date)
                  : windowLabel(days[0]!.date, days[days.length - 1]!.date)
              }
            />
            {averageMl !== null && daysLogged > 0 ? (
              <Text className="mt-1.5 font-mono text-[11px] text-ink-muted">
                {`${fmtVolume(spec, averageMl)} average · ${daysLogged} of ${daysInWindow} days logged`}
              </Text>
            ) : null}
            <View className="mt-1">
              {newestFirst.map((point, index) => {
                const has = point.entries > 0;
                const dayPct =
                  targetMl && targetMl > 0 ? Math.min(100, (point.ml / targetMl) * 100) : null;
                const isSelected = point.date === day;
                return (
                  <View key={point.date}>
                    <Divider first={index === 0} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityState={{ selected: isSelected }}
                      accessibilityLabel={
                        has
                          ? `${shortDate(point.date)}. ${fmtVolume(spec, point.ml)}. Open this day.`
                          : `${shortDate(point.date)}. Nothing logged. Open this day.`
                      }
                      onPress={() => selectDay(point.date)}
                      className={`${rowClass} active:opacity-60`}>
                      <Text
                        className={
                          isSelected
                            ? 'w-14 font-mono text-[11px] text-ink'
                            : 'w-14 font-mono text-[11px] text-ink-muted'
                        }>
                        {shortDate(point.date)}
                      </Text>
                      <View className="flex-1">
                        {has ? (
                          dayPct !== null ? (
                            <View className="h-[3px] bg-paper-deep">
                              <View className="h-[3px] bg-pine" style={{ width: `${dayPct}%` }} />
                            </View>
                          ) : null
                        ) : (
                          <Text className="font-serif text-[13px] text-ink-muted">
                            Nothing logged
                          </Text>
                        )}
                      </View>
                      <View className="items-end">
                        <Text
                          className={
                            has
                              ? 'font-mono text-[13px] text-ink'
                              : 'font-mono text-[13px] text-ink-muted'
                          }>
                          {has ? fmtVolume(spec, point.ml) : '—'}
                        </Text>
                        {point.date === today ? (
                          <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                            today, still open
                          </Text>
                        ) : null}
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
                    </Pressable>
                  </View>
                );
              })}
            </View>
          </Block>
        </View>
      ) : null}

      {/* e. The goal. A screen that judges against a target has to reach the
          target — and on a database that has never logged water, the stamp
          below takes the accent instead, so the budget stays at one per state. */}
      <View className="mt-8">
        <Block device="plate">
          {goalOpen ? (
            <>
              <SectionLabel label="Daily goal" note={spec.unit} />
              <View className="mt-2 flex-row items-center gap-2">
                <TextInput
                  accessibilityLabel={`Daily goal in ${spec.unit}`}
                  value={goalText}
                  onChangeText={setGoalText}
                  keyboardType="numeric"
                  placeholder="Leave empty for no goal"
                  placeholderTextColor={palette.inkMuted}
                  className="min-h-[44px] flex-1 rounded-btn border border-paper-deep bg-paper-dim px-3 py-2 font-mono text-[15px] text-ink"
                />
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Save the daily goal"
                  onPress={saveGoal}
                  className="min-h-[44px] items-center justify-center rounded-btn bg-pine px-4 py-2 active:opacity-70">
                  <Text className="font-label text-[14px] font-semibold text-pine-on">Save</Text>
                </Pressable>
              </View>
            </>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                targetMl !== null
                  ? `Daily goal, ${fmtVolume(spec, targetMl)}. Change it.`
                  : 'Set a daily goal.'
              }
              onPress={() => {
                setGoalText(targetMl !== null ? String(toDisplay(spec, targetMl)) : '');
                setGoalOpen(true);
              }}
              className="min-h-[44px] flex-row items-center gap-3 active:opacity-60">
              <Ionicons name="flag-outline" size={18} color={palette.inkSecondary} />
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Daily goal</Text>
                {/* No goal is an authored state, not a zero and not a guess. */}
                {targetMl === null ? (
                  <Text className="mt-0.5 font-serif text-[11px] leading-4 text-ink-muted">
                    None set — totals show without a target.
                  </Text>
                ) : null}
              </View>
              {targetMl !== null ? (
                <Text className="font-mono text-[11px] text-ink-muted">
                  {fmtVolume(spec, targetMl)}
                </Text>
              ) : null}
              <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
            </Pressable>
          )}
        </Block>
      </View>

      {/* f. The first amount in. Only on a database that has never logged water
          — this is the one next action there, so it takes the accent the
          per-day bars would otherwise have spent. */}
      {recordStart === null ? (
        <View className="mt-8">
          <Block device="stamp" cap>
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
              No water yet
            </Text>
            <Text className="mt-2 font-serif text-[19px] font-semibold leading-6 text-ink">
              The record starts with one glass
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Log a glass, ${QUICK[volumeUnit][0]!.amount} ${spec.unit}`}
              onPress={() => add(QUICK[volumeUnit][0]!.amount)}
              className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine px-4 py-3 active:opacity-70">
              <Ionicons name="water-outline" size={18} color={palette.pineOn} />
              <Text className="font-label text-[15px] font-semibold text-pine-on">
                {`Log a glass · ${QUICK[volumeUnit][0]!.amount} ${spec.unit}`}
              </Text>
            </Pressable>
          </Block>
        </View>
      ) : null}
    </Screen>
  );
}
