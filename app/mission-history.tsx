import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import {
  missionAdherence,
  missionBySource,
  missionDailySeries,
  missionRecordStart,
  type MissionDayPoint,
  type MissionSourceRecord,
} from '@/lib/db/repositories/mission';
import { listProtocols } from '@/lib/db/repositories/protocols';
import { shortDate, windowLabel } from '@/lib/experiments/format';
import { daysBetween } from '@/lib/screenings/format';

/**
 * The execution record — what sits behind the Data tab's **Mission** trend row.
 *
 * Until now that row navigated to Home, which is not a destination: Home is
 * today's plan, and the question a trend row asks is about the days *behind*
 * you. This screen answers exactly one question, which is the one the owner
 * asked for — **"how well am I actually executing my day, and where am I
 * failing?"** — and it is built to end in an action rather than a number.
 *
 * ## Three objects, in the order the question is asked
 *
 * 1. **Execution** (`field` — a verdict, and the only verdict here): the rate,
 *    its four-way ledger, and how much history it is drawn from.
 * 2. **Where it's failing** (`plate`): one row per SOURCE — a protocol, an
 *    experiment, or a retired mode's historical items — worst first, each
 *    naming its own worst item and each
 *    tapping through to the protocol that keeps generating it. This sits
 *    ABOVE the day-by-day record deliberately: actionability beats information
 *    density (CLAUDE.md §5), and the protocol is the thing you can change.
 * 3. **By day** (`plate`): the record itself, newest first. It is the evidence
 *    for the two objects above it, so it comes last.
 *
 * Then the row into Protocols, because a screen about a plan you are not
 * executing has to reach the plan.
 *
 * ## What is deliberately NOT here
 *
 * **No sparkline.** The Data tab's row draws one, and it is honest there
 * because it is explicitly a COUNT. On this screen a bar per day would have to
 * carry the rate, and a completed-count bar cannot: 2-of-2 and 2-of-8 draw
 * identically, which is precisely the reading this screen exists to correct.
 * The by-day rows carry a proportion bar each instead — same drawing primitive
 * as app/nutrition-history.tsx's target bar, per day, labelled, and absent
 * entirely on a day with no plan.
 *
 * **No streak.** A streak needs a rule about what breaks it, and every
 * candidate rule here is currently a lie: with Modes removed (2026-08-25,
 * docs/information-architecture.md §Modes) there is no excusal mechanism for
 * future days at all, so a streak would punish the user for correctly resting
 * while sick. If excusal is ever redesigned (per-item skip reasons were the
 * evaluation's candidate), a streak becomes possible; until then it would be
 * a moralising number the data cannot support.
 *
 * ## Today is not a miss, and a young install is not a failing one
 *
 * Two honesty rules do most of the work here (00-design-spec.md §5):
 *
 * - **The rate is computed over days that are OVER.** A pending item at 09:00
 *   is a morning, not a miss. Including today would make the headline read
 *   worst first thing in the morning and best last thing at night, which is a
 *   fact about the clock, not about execution.
 * - **The window is clipped to the record** (`missionRecordStart`). A fortnight
 *   window over a four-day-old install draws four rows and says "4 days on
 *   record", never ten rows of empty that read as ten days of not bothering.
 *   Under seven finished days it also says so in words, because a rate over
 *   three days is not a trend and must not be presented as one.
 *
 * Three different absences therefore say three different things, and none of
 * them renders as a zero:
 *
 * | State | What it says |
 * | --- | --- |
 * | Nothing ever planned | "No mission has been planned yet…" + the stamp into Protocols |
 * | The record starts today | "The record starts today. Nothing has finished yet." |
 * | Days on record, none planned | "No plan was generated on any of the last 14 days." |
 * | Planned, nothing missed | "Nothing was missed. All N planned items were completed." |
 * | A day inside the record with no plan | the row reads "No plan" and an em-dash — never `0 of 0` |
 *
 * The last two are the pair this codebase has already confused twice: *nothing
 * was skipped* and *nothing was ever logged* are different facts.
 *
 * ## Ink
 *
 * Mission completion is **behaviour, not biology**, so no `signal-*` colour
 * appears on this screen at any point — that firewall runs both ways. The
 * accent (pine/petrol) marks completion and nothing else: it is either the
 * per-day completion bars OR, on a database with no record at all, the single
 * stamp into Protocols. Never both, so the budget is one thing per state.
 *
 * Date formatting comes from `@/lib/experiments/format` rather than a fifth
 * local copy of the month table — Hermes has no `Intl`, so every one of these
 * is hand-rolled and there is no reason for two of them.
 */

/**
 * The window. **14, to agree with the row that opens this screen** — the Data
 * tab's Mission trend is captioned "Completed · last 14 days" and draws a
 * 14-point series; a screen behind it showing 30 would make the sparkline and
 * its own drill-down disagree about the same period.
 */
const WINDOW_DAYS = 14;

/** Under this many finished days, the rate is stated but explicitly disclaimed. */
const TREND_FLOOR = 7;

type MissionRecordView = {
  today: string;
  /** First day ever planned, or null when nothing ever was. */
  recordStart: string | null;
  /** True calendar length of the record, which may exceed the window. */
  daysOnRecord: number;
  /** The window, clipped to the record. Oldest → today. */
  days: MissionDayPoint[];
  /** Of those, the days that are over. Every judgement is made on these. */
  settled: MissionDayPoint[];
  adherence: number | null;
  /** Over `settled`. `completed + skipped + partial + untouched === planned`. */
  totals: {
    planned: number;
    completed: number;
    skipped: number;
    partial: number;
    untouched: number;
  };
  sources: MissionSourceRecord[];
  /** Protocols that WILL contribute to a mission — the generator's own filter. */
  activeProtocols: number;
};

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

function read(): MissionRecordView {
  const db = getDb();
  const today = todayISODate();
  const recordStart = missionRecordStart(db);

  const series = missionDailySeries(db, WINDOW_DAYS, today);
  const days = recordStart === null ? [] : series.filter((p) => p.date >= recordStart);
  const settled = days.filter((p) => p.date < today);

  const from = settled[0]?.date ?? null;
  const to = settled[settled.length - 1]?.date ?? null;
  const sources = from !== null && to !== null ? missionBySource(db, from, to) : [];

  // Totals come from `sources` because it carries `partial`, which the day
  // series does not — and the ledger line has to sum to `planned` to satisfy
  // §5. The two count the same rows over the same range through the same shared
  // predicates, so `sum(sources.planned)` and `sum(settled.planned)` are the
  // same number by construction (asserted in db/data-trends.test.mjs §14d).
  let planned = 0;
  let completed = 0;
  let skipped = 0;
  let partial = 0;
  for (const source of sources) {
    planned += source.planned;
    completed += source.completed;
    skipped += source.skipped;
    partial += source.partial;
  }

  return {
    today,
    recordStart,
    // Clamped: a record cannot be shorter than the day it began on, and every
    // elapsed computation in this codebase clamps at zero rather than trusting
    // two clocks to agree.
    daysOnRecord: recordStart === null ? 0 : Math.max(1, daysBetween(recordStart, today) + 1),
    days,
    settled,
    // The shared definition, identical to the one the Data tab's row quotes —
    // a rate over days that HAD a plan, null when none did.
    adherence: missionAdherence(settled),
    totals: {
      planned,
      completed,
      skipped,
      partial,
      untouched: planned - completed - skipped - partial,
    },
    sources,
    activeProtocols: listProtocols(db).filter((p) => p.isActive && p.versionNumber !== null).length,
  };
}

export default function MissionHistoryScreen() {
  const router = useRouter();
  const [view, setView] = useState(read);
  const reload = useCallback(() => setView(read()), []);
  useFocusEffect(reload);

  const { today, recordStart, daysOnRecord, days, settled, adherence, totals, sources } = view;

  const rate = adherence !== null ? `${Math.round(adherence * 100)}%` : '—';

  // The authored sentence under the verdict. Null once there is enough history
  // for the figure to stand on its own — a heading with a permanent line of
  // prose beneath it is exactly the filler the owner has twice asked to lose.
  let verdict: string | null = null;
  if (recordStart === null) {
    verdict = 'No mission has been planned yet — activate a protocol and each day gets a plan.';
  } else if (settled.length === 0) {
    verdict = 'The record starts today. Nothing has finished yet.';
  } else if (adherence === null) {
    verdict = `No plan was generated on any of the last ${WINDOW_DAYS} days.`;
  } else if (settled.length < TREND_FLOOR) {
    verdict = `Only ${plural(settled.length, 'finished day')} on record — too little to read as a trend.`;
  }

  // Sums to `totals.planned`, which is the denominator printed beside the rate.
  const ledger =
    totals.planned > 0
      ? [
          `${totals.completed} done`,
          `${totals.skipped} skipped`,
          ...(totals.partial > 0 ? [`${totals.partial} partial`] : []),
          `${totals.untouched} untouched`,
        ].join(' · ')
      : null;

  const settledWindow =
    settled.length > 0
      ? settled.length === 1
        ? shortDate(settled[0]!.date)
        : windowLabel(settled[0]!.date, settled[settled.length - 1]!.date)
      : null;

  // Whole strings, never JSX interpolation split across children. React's SSR
  // separates adjacent text children with comment nodes, so `of {n} planned`
  // renders as three nodes and no test — and no VoiceOver reading — sees one
  // phrase. Every measured phrase on this screen is built here as one string.
  //
  // It states the JUDGED window only. The record's own extent is already on the
  // section label ("4 days on record"), and an earlier draft printed both —
  // "Since Aug 9 · judged Aug 9 → Aug 11" — which says Aug 9 twice on a line
  // whose whole job is to be read in one pass.
  const extent = settledWindow !== null ? `Judged ${settledWindow}` : null;

  const failing = sources.filter((s) => s.planned - s.completed > 0);
  const newestFirst = [...days].reverse();

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Mission" parent="Data" />
      </View>

      {/* a. The verdict. A measured field, not a plate: this is a reading taken
          off the record below it, not a record of its own. */}
      <View className="mt-6">
        <Block device="field">
          <SectionLabel
            label="Execution"
            note={recordStart !== null ? `${plural(daysOnRecord, 'day')} on record` : undefined}
          />
          <View className="mt-2 flex-row items-baseline gap-1.5">
            {/* No data, no number: an em-dash, never a stand-in zero. */}
            <Text
              className={
                adherence !== null
                  ? 'font-mono text-4xl text-ink'
                  : 'font-mono text-4xl text-ink-muted'
              }>
              {rate}
            </Text>
            {adherence !== null ? (
              <Text className="font-mono text-sm text-ink-muted">{`of ${totals.planned} planned`}</Text>
            ) : null}
          </View>
          {ledger ? (
            <Text className="mt-1.5 font-mono text-[11px] text-ink-muted">{ledger}</Text>
          ) : null}
          {extent ? (
            <Text className="mt-1 font-mono text-[10px] text-ink-muted">{extent}</Text>
          ) : null}
          {verdict ? (
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
              {verdict}
            </Text>
          ) : null}
        </Block>
      </View>

      {/* b. The actionable half — and the reason this screen is not the Home
          tab. Each row is a source of plan items and, where one still exists,
          a route into the protocol that keeps generating them. */}
      {settled.length > 0 ? (
        <View className="mt-8">
          <Block device="plate">
            {/* The count, not the date range: the line directly above already
                prints the range, and a section note is a tally. */}
            <SectionLabel
              label="Where it's failing"
              note={`${plural(settled.length, 'finished day')}`}
            />
            {failing.length === 0 ? (
              <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
                {totals.planned === 0
                  ? 'No plan was generated on any of these days.'
                  : `Nothing was missed. All ${totals.planned} planned items were completed.`}
              </Text>
            ) : (
              <View className="mt-1">
                {failing.map((source, index) => {
                  const missed = source.planned - source.completed;
                  const worst = source.items[0];
                  const worstMissed = worst ? worst.planned - worst.completed : 0;
                  const navigable = source.protocolId !== null;

                  const body = (
                    <>
                      <View className="flex-1">
                        <Text numberOfLines={1} className="font-serif text-[15px] text-ink">
                          {source.name}
                        </Text>
                        {source.kind === 'protocol_gone' ? (
                          <Text className="mt-0.5 font-serif text-[11px] leading-4 text-ink-muted">
                            This protocol has been deleted.
                          </Text>
                        ) : null}
                        {worst && worstMissed > 0 ? (
                          <View className="mt-0.5 flex-row items-baseline gap-1">
                            <Text
                              numberOfLines={1}
                              className="shrink font-serif text-[11px] leading-4 text-ink-muted">
                              {worst.title}
                            </Text>
                            <Text className="font-mono text-[10px] text-ink-muted">
                              {`${worstMissed} of ${worst.planned} missed`}
                            </Text>
                          </View>
                        ) : null}
                      </View>
                      {/* Everything on this plate is stated as a MISS, headline
                          included. It read `3 of 6` over `3 missed`, which put
                          two figures in one column under two different framings
                          — done-of-planned above missed — and nothing on the row
                          said which was which. On a section headed "Where it's
                          failing" the failure is the headline. */}
                      <View className="items-end">
                        <Text className="font-mono text-[15px] text-ink">{`${missed} missed`}</Text>
                        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                          {`of ${source.planned} planned`}
                        </Text>
                      </View>
                      {navigable ? (
                        <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
                      ) : null}
                    </>
                  );

                  const rowClass = 'min-h-[44px] flex-row items-center gap-3 py-3';
                  return (
                    <View key={source.key}>
                      <Divider first={index === 0} />
                      {navigable ? (
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`${source.name}. ${missed} of ${source.planned} planned items missed. Open the protocol.`}
                          onPress={() =>
                            router.push({
                              pathname: '/protocol-edit',
                              params: { id: source.protocolId! },
                            })
                          }
                          className={`${rowClass} active:opacity-60`}>
                          {body}
                        </Pressable>
                      ) : (
                        <View className={rowClass}>{body}</View>
                      )}
                    </View>
                  );
                })}
              </View>
            )}
          </Block>
        </View>
      ) : null}

      {/* c. The record. Clipped to the record's own start, so a young install
          shows the days it has and nothing else. */}
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
            <View className="mt-1">
              {newestFirst.map((point, index) => {
                const planned = point.planned > 0;
                const pct = planned ? Math.round((point.completed / point.planned) * 100) : 0;
                return (
                  <View key={point.date}>
                    <Divider first={index === 0} />
                    <View className="min-h-[44px] flex-row items-center gap-3 py-3">
                      <Text className="w-14 font-mono text-[11px] text-ink-muted">
                        {shortDate(point.date)}
                      </Text>
                      <View className="flex-1">
                        {planned ? (
                          // The completion mark. Behaviour, so the accent —
                          // never a signal colour. A filled track and a filled
                          // fill: no borders anywhere near a rule this thin.
                          <View className="h-[3px] bg-paper-deep">
                            <View className="h-[3px] bg-pine" style={{ width: `${pct}%` }} />
                          </View>
                        ) : (
                          <Text className="font-serif text-[13px] text-ink-muted">No plan</Text>
                        )}
                      </View>
                      <View className="items-end">
                        <Text
                          className={
                            planned
                              ? 'font-mono text-[13px] text-ink'
                              : 'font-mono text-[13px] text-ink-muted'
                          }>
                          {planned ? `${point.completed} of ${point.planned}` : '—'}
                        </Text>
                        {point.date === today ? (
                          <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                            today, still open
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  </View>
                );
              })}
            </View>
          </Block>
        </View>
      ) : null}

      {/* d. The way out. A screen about a plan you are not executing has to
          reach the plan — and on a database with no record at all this is the
          one next action, so it takes the accent the completion bars would
          otherwise have spent. */}
      <View className="mt-8">
        {recordStart === null ? (
          <Block device="stamp" cap>
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
              No plan yet
            </Text>
            <Text className="mt-2 font-serif text-[19px] font-semibold leading-6 text-ink">
              The day&apos;s plan comes from your protocols
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open protocols"
              onPress={() => router.push('/protocols')}
              className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine px-4 py-3 active:opacity-70">
              <Ionicons name="git-branch-outline" size={18} color={palette.pineOn} />
              <Text className="font-label text-[15px] font-semibold text-pine-on">
                Set up a protocol
              </Text>
            </Pressable>
          </Block>
        ) : (
          <Block device="plate">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Protocols. ${plural(view.activeProtocols, 'active protocol')}.`}
              onPress={() => router.push('/protocols')}
              className="min-h-[44px] flex-row items-center gap-3 active:opacity-60">
              <Ionicons name="git-branch-outline" size={18} color={palette.inkSecondary} />
              <Text className="flex-1 font-serif text-[15px] text-ink">Protocols</Text>
              <Text className="font-mono text-[11px] text-ink-muted">
                {`${view.activeProtocols} active`}
              </Text>
              <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
            </Pressable>
          </Block>
        )}
      </View>
    </Screen>
  );
}
