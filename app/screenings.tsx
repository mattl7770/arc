import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useScreenings, type ScreeningGroups } from '@/hooks/use-screenings';
import type { DateString } from '@/lib/db/types';
import {
  apptDateText,
  apptTimeText,
  cadenceLabel,
  CATEGORY_LABELS,
  daysBetween,
  dueDateText,
  dueLabel,
} from '@/lib/screenings/format';
import type { ScreeningRow, UpcomingAppointment } from '@/lib/screenings/types';

/**
 * Screenings — the preventive ledger, pushed from the Data tab
 * (docs/information-architecture.md: browsable in Data; Home later surfaces
 * what's *due* from the same dueScreenings seam).
 *
 * Conformed Set treatment — **ruled plates** end to end: every group here is a
 * ledger of records, so each is one plate with its rows ruled, its own tally in
 * the label's mono note slot, and no card-per-row.
 *
 * Above the ledger sits the **Preventive Horizon** — a measured 0 → 6wk+ axis
 * that places every dated screening and booking on a real timeline, so "what is
 * coming and when" is read off a drawing rather than out of a list. It carries
 * no enclosure of its own (see {@link HorizonAxis}), and the long note above
 * {@link buildHorizon} covers the four honesty problems it has to solve. Its
 * only colour is the caution signal on an overdue marker; see the firewall note
 * below.
 *
 * **Zero accent.** This is a browse surface with two peer add actions, and two
 * things cannot both be *the* one primary action — so neither takes the accent.
 * "Add screening" is a solid ink action and "Add appointment" a bordered one;
 * weight carries the hierarchy instead of hue.
 *
 * The firewall, the one exception: an OVERDUE row's due text keeps the caution
 * signal. A missed screening is genuine biological state, which is exactly what
 * the signal palette is for — everything else on the screen is neutral ink, and
 * the accent never marks biology in either direction. It takes the *ink* cut of
 * that hue (`signal-caution-ink`), because this is text; the swatch cut is for
 * fills and would not clear 4.5:1 here.
 */

type GroupKey = 'overdue' | 'dueSoon' | 'scheduled' | 'untracked';

const GROUP_LABELS: Record<GroupKey, string> = {
  overdue: 'Overdue',
  dueSoon: 'Due soon',
  scheduled: 'Scheduled',
  untracked: 'Not scheduled',
};

const GROUP_ORDER: GroupKey[] = ['overdue', 'dueSoon', 'scheduled', 'untracked'];

/* ==========================================================================
   The Preventive Horizon axis
   ==========================================================================

   A measured 0 → 6wk+ timeline sitting above the ledger, so "what is coming
   and when" is read off a horizon rather than out of a list. Everything below
   is drawn with bordered Views: there is no react-native-svg in this app and
   that stays true (01-rn-port-guide.md §5 names this exact screen — "a
   positioned row of Views, diamond = a rotated square View"). Positions are
   percentages in a `style` prop, never a built Tailwind class.

   Six weeks, not the ledger's thirty days: the two answer different questions
   and both say which they are. The axis is captioned NEXT 6 WK; the group
   below is captioned "Due soon". A screening at day 35 therefore sits on the
   axis and reads "Scheduled" in the ledger, which is true in both places.

   ## The four honesty problems this drawing has to solve

   1. **Nothing falls off the right edge.** Anything past six weeks is counted
      into an explicit 6WK+ bucket that names how many and the earliest date,
      and the terminal scale label only grows its "+" when that bucket is
      occupied.
   2. **Overdue is not moved.** A late screening has no honest position on a
      horizon that starts at now, so its marker clamps to the NOW stake — and
      its lane then states the date it was actually due, so the text tells the
      truth the position cannot. It takes the caution signal, because a missed
      screening is genuine biological state (00-design-spec.md §2); the accent
      appears nowhere on this screen.
   3. **Markers cannot occlude each other.** Two screenings in the same week
      would collide on a single rail, so each item gets its own lane. Position
      is the x coordinate, identity is the row. Collision is impossible by
      construction rather than resolved after the fact.
   4. **An empty horizon is authored, not an empty rail.** A rail with nothing
      on it is drafting chrome that pays no rent; when there is nothing to
      plot, the block says so in words instead.

   No sheet numbers, no station codes, no designator badges: the only glyphs
   here are the rail, its week stakes and one marker per real item. */

/** How far the horizon looks. Weeks are the unit the scale is stationed in. */
const HORIZON_WEEKS = 6;
const HORIZON_DAYS = HORIZON_WEEKS * 7;

/**
 * Lane ceiling. Past this the axis would grow taller than the ledger it is
 * meant to summarise, so the overflow is stated and the ledger below carries
 * it — nothing is silently dropped.
 */
const MAX_LANES = 8;

/** Marker box, in points. A rotated square, so it reads ~11px on the diagonal. */
const MARKER_SIZE = 8;

/** Lane height: enough for the 12.5px name plus air. Lanes are not tappable. */
const LANE_HEIGHT = 22;

/** Where an item stands relative to now — the three states a marker can take. */
type HorizonState = 'late' | 'due' | 'booked';

type HorizonItem = {
  key: string;
  name: string;
  state: HorizonState;
  /** The real calendar day, always — the lane prints this even when clamped. */
  day: DateString;
  /** Whole days from today; negative for a late screening. */
  days: number;
  /** 0–1 along the horizon, clamped at both ends. */
  position: number;
};

type Horizon = {
  /** Plotted lanes, soonest first, capped at {@link MAX_LANES}. */
  lanes: HorizonItem[];
  /** Within six weeks but over the lane ceiling — stated, not hidden. */
  hidden: number;
  /** Past the horizon: the 6WK+ bucket. */
  beyond: HorizonItem[];
  /** Screenings with neither a due date nor a booking — nothing to plot. */
  undated: number;
};

/**
 * Percentage for a `left`/`right` style. Typed as a template-literal so it
 * satisfies RN's `DimensionValue` without a cast.
 */
function pct(fraction: number): `${number}%` {
  return `${fraction * 100}%`;
}

/**
 * An appointment's ISO instant as its local calendar day. `format.ts` does the
 * same conversion inside `apptDateText` but does not export it, and this file
 * must not edit that module.
 */
function localDay(iso: string): DateString {
  const d = new Date(iso);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  return `${d.getFullYear()}-${mm}-${dd}`;
}

function makeItem(
  key: string,
  name: string,
  state: HorizonState,
  day: DateString,
  today: string
): HorizonItem {
  const days = daysBetween(today, day);
  return {
    key,
    name,
    state,
    day,
    days,
    position: Math.min(1, Math.max(0, days / HORIZON_DAYS)),
  };
}

/**
 * Turn the screen's real data into plottable items. Only what exists is
 * placed — nothing is estimated, and an item with no date is counted, not
 * invented onto the rail.
 *
 * **A booking absorbs its screening.** `appointments.screening_id` is an
 * explicit link, and the repository treats attending the booking as completing
 * the screening (`completeAppointment` stamps it done as of the visit). Two
 * markers for one event would therefore be a double count, so a linked pair is
 * one lane, placed on the day it will actually happen. That also means a
 * screening whose due date has passed but which is already booked plots at its
 * booking rather than at the NOW stake: it is handled, and the ledger below
 * still lists it under Overdue until the visit is closed out.
 */
function buildHorizon(
  groups: ScreeningGroups,
  appointments: UpcomingAppointment[],
  today: string
): Horizon {
  const screenings = [
    ...groups.overdue,
    ...groups.dueSoon,
    ...groups.scheduled,
    ...groups.untracked,
  ];
  const screeningIds = new Set(screenings.map((s) => s.id));

  // Soonest booking per screening; `appointments` is already sorted by date.
  const booking = new Map<string, UpcomingAppointment>();
  for (const a of appointments) {
    if (a.screening_id && screeningIds.has(a.screening_id) && !booking.has(a.screening_id)) {
      booking.set(a.screening_id, a);
    }
  }

  const plotted: HorizonItem[] = [];
  let undated = 0;

  for (const s of screenings) {
    const booked = booking.get(s.id);
    if (booked) {
      plotted.push(makeItem(s.id, s.name, 'booked', localDay(booked.scheduled_at), today));
    } else if (s.next_due != null) {
      const late = daysBetween(today, s.next_due) < 0;
      plotted.push(makeItem(s.id, s.name, late ? 'late' : 'due', s.next_due, today));
    } else {
      undated += 1;
    }
  }

  for (const a of appointments) {
    // Skip the one already folded into its screening's lane above.
    if (a.screening_id && booking.get(a.screening_id) === a) continue;
    plotted.push(makeItem(a.id, a.title, 'booked', localDay(a.scheduled_at), today));
  }

  const byDate = (x: HorizonItem, y: HorizonItem) =>
    x.days - y.days || x.name.localeCompare(y.name);
  const within = plotted.filter((i) => i.days <= HORIZON_DAYS).sort(byDate);
  const beyond = plotted.filter((i) => i.days > HORIZON_DAYS).sort(byDate);

  return {
    lanes: within.slice(0, MAX_LANES),
    hidden: Math.max(0, within.length - MAX_LANES),
    beyond,
    undated,
  };
}

/**
 * Marker fills. FORM carries the state as much as colour does — solid for work
 * still owed, hollow for work already committed to a slot — so the three read
 * apart in a photocopy, the same principle as Home's mission tick ladder.
 *
 * `late` takes the signal SWATCH cut: this is a fill, where 3:1 applies. The
 * lane's *text* takes `signal-caution-ink`, never the swatch (00-design-spec.md
 * §2). Whole class strings, never a built prefix.
 */
const MARKER_FILL: Record<HorizonState, string> = {
  late: 'bg-signal-caution',
  due: 'bg-ink',
  booked: 'border border-ink bg-paper-hi',
};

const STATE_WORD: Record<HorizonState, string> = {
  late: 'Was due',
  due: 'Due',
  booked: 'Booked',
};

/** The rail: a ruled line, a NOW stake, one stake per week, a terminal stake. */
function HorizonRail() {
  return (
    <View className="h-4">
      <View className="absolute left-0 right-0 top-[7px] h-px bg-ink" />
      {[1, 2, 3, 4, 5].map((week) => (
        <View
          key={week}
          style={{ left: pct(week / HORIZON_WEEKS), marginLeft: -0.5, top: 4 }}
          className="absolute h-[7px] w-px bg-hairline"
        />
      ))}
      {/* Now, and the end of what this drawing claims to know. */}
      <View className="absolute left-0 top-[1px] h-[13px] w-[1.5px] bg-ink" />
      <View className="absolute right-0 top-[2px] h-[11px] w-px bg-ink-muted" />
    </View>
  );
}

/**
 * The stationed scale. Stakes stand at every week but only every second one is
 * captioned — major and minor stations, which is what keeps 10px mono legible
 * across a phone. The terminal caption grows its "+" only when something is
 * actually out there, so the mark never implies a bucket that is empty.
 */
function HorizonScale({ open }: { open: boolean }) {
  const stations: { week: number; text: string }[] = [
    { week: 0, text: 'NOW' },
    { week: 2, text: '2 WK' },
    { week: 4, text: '4 WK' },
    { week: HORIZON_WEEKS, text: open ? '6 WK+' : '6 WK' },
  ];
  return (
    <View className="h-[13px]">
      {stations.map((station) => (
        <Text
          key={station.week}
          style={{ left: pct(station.week / HORIZON_WEEKS), marginLeft: -20, width: 40 }}
          className={`absolute text-center font-mono text-[10px] ${
            station.week === 0 ? 'text-ink' : 'text-ink-muted'
          }`}>
          {station.text}
        </Text>
      ))}
    </View>
  );
}

/**
 * One item, one lane. The marker sits at the item's day; the caption hangs off
 * whichever side has room (right of the marker in the near half, left of it in
 * the far half), so nothing is centred on a marker and nothing can clip past
 * the field's edges. That side-swap is also why no lane needs its text
 * measured before it can be placed.
 *
 * The caption always prints the real date. For a `late` item the marker has
 * been clamped to the NOW stake — its position is a floor, not a measurement —
 * and the date is what keeps that honest.
 */
function HorizonLane({ item, today }: { item: HorizonItem; today: string }) {
  const near = item.position <= 0.5;
  const late = item.state === 'late';
  return (
    <View style={{ height: LANE_HEIGHT }}>
      <View
        style={{
          left: pct(item.position),
          marginLeft: -MARKER_SIZE / 2,
          top: (LANE_HEIGHT - MARKER_SIZE) / 2,
          width: MARKER_SIZE,
          height: MARKER_SIZE,
          transform: [{ rotate: '45deg' }],
        }}
        className={`absolute ${MARKER_FILL[item.state]}`}
      />
      <View
        style={
          near
            ? { left: pct(item.position), right: 0, marginLeft: 11 }
            : { left: 0, right: pct(1 - item.position), marginRight: 11 }
        }
        className={`absolute inset-y-0 flex-row items-center gap-1.5 ${
          near ? 'justify-start' : 'justify-end'
        }`}>
        <Text numberOfLines={1} className="shrink font-serif text-[12.5px] text-ink">
          {item.name}
        </Text>
        <Text
          className={`font-label text-[10px] uppercase tracking-[1px] ${
            late ? 'text-signal-caution-ink' : 'text-ink-muted'
          }`}>
          {STATE_WORD[item.state]}
        </Text>
        <Text
          className={`font-mono text-[10px] ${
            late ? 'text-signal-caution-ink' : 'text-ink-secondary'
          }`}>
          {dueDateText(item.day, today)}
        </Text>
      </View>
    </View>
  );
}

/**
 * The 6WK+ bucket — everything the horizon cannot reach, counted rather than
 * dropped. Its marker is a *pair* of hollow diamonds stacked at the terminal
 * stake so it cannot be misread as one more item, and its caption states the
 * count and the earliest date behind it.
 */
function BeyondLane({ items, today }: { items: HorizonItem[]; today: string }) {
  const marker = {
    top: (LANE_HEIGHT - MARKER_SIZE) / 2,
    width: MARKER_SIZE,
    height: MARKER_SIZE,
    transform: [{ rotate: '45deg' }],
  };
  return (
    <View style={{ height: LANE_HEIGHT }}>
      <View
        style={{ left: pct(1), marginLeft: -MARKER_SIZE / 2 - 5, ...marker }}
        className="absolute border border-ink-muted bg-paper-hi"
      />
      <View
        style={{ left: pct(1), marginLeft: -MARKER_SIZE / 2, ...marker }}
        className="absolute border border-ink-muted bg-paper-hi"
      />
      <View
        style={{ left: 0, right: 0, marginRight: 17 }}
        className="absolute inset-y-0 flex-row items-center justify-end gap-1.5">
        <Text className="font-mono text-[10px] text-ink-secondary">{items.length}</Text>
        <Text numberOfLines={1} className="shrink font-serif text-[12.5px] text-ink-secondary">
          beyond this horizon, from
        </Text>
        <Text className="font-mono text-[10px] text-ink-secondary">
          {dueDateText(items[0]!.day, today)}
        </Text>
      </View>
    </View>
  );
}

/** A footer note: a count in mono, what it counts in the label voice. */
function HorizonNote({ count, text }: { count: number; text: string }) {
  return (
    <View className="flex-row items-center gap-1.5">
      <Text className="font-mono text-[10px] text-ink-muted">{count}</Text>
      <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">{text}</Text>
    </View>
  );
}

/** The whole drawing read aloud, in the order the eye takes it. */
function horizonLabel(horizon: Horizon, today: string): string {
  const parts = [`Preventive horizon, next ${HORIZON_WEEKS} weeks.`];
  for (const item of horizon.lanes) {
    parts.push(
      `${item.name}, ${STATE_WORD[item.state].toLowerCase()} ${dueDateText(item.day, today)}.`
    );
  }
  if (horizon.hidden > 0) {
    parts.push(`${horizon.hidden} more within ${HORIZON_WEEKS} weeks, listed below.`);
  }
  if (horizon.beyond.length > 0) {
    parts.push(
      `${horizon.beyond.length} beyond this horizon, from ${dueDateText(horizon.beyond[0]!.day, today)}.`
    );
  }
  if (horizon.undated > 0) parts.push(`${horizon.undated} undated, not on the horizon.`);
  return parts.join(' ');
}

/**
 * The axis block. Inset by `mx-5` so the centred NOW and 6 WK captions have room
 * to hang past the ends of the rail without reaching the sheet's gutter.
 *
 * **No enclosure.** This used to be a `<Block device="plate">` on the reading
 * that a schedule is a record. On hardware a box drawn around a drawing that is
 * ITSELF made of rules reads as one more stray line (owner, 2026-08-10) — and
 * the grid device lost its marks for exactly this reason: the axis IS the
 * object, built from alignment, stakes and one marker per real item, and an
 * outer box adds a second enclosure that carries no information the drawing
 * does not already carry. Same call, same rationale (src/components/ui/block.tsx,
 * "a grid draws no rules").
 */
function HorizonAxis({ horizon, today }: { horizon: Horizon; today: string }) {
  const empty = horizon.lanes.length === 0 && horizon.beyond.length === 0;

  return (
    <View>
      {empty ? (
        // Authored, not blank: a rail with nothing on it would be chrome.
        <Text className="font-serif text-[12.5px] leading-5 text-ink-secondary">
          Nothing dated yet. Give a screening a due date, or book an appointment, and it will be
          placed on this horizon.
        </Text>
      ) : (
        <View accessible accessibilityLabel={horizonLabel(horizon, today)} className="mx-5">
          <HorizonRail />
          <HorizonScale open={horizon.beyond.length > 0} />
          <View className="mt-1.5">
            {horizon.lanes.map((item) => (
              <HorizonLane key={item.key} item={item} today={today} />
            ))}
            {horizon.beyond.length > 0 ? <BeyondLane items={horizon.beyond} today={today} /> : null}
          </View>
        </View>
      )}

      {/* The overflow notes. Separated by air, not by a rule: with no plate to
          run between, a hairline here would close nothing and read as a stroke
          lying loose on the sheet. */}
      {horizon.hidden > 0 || horizon.undated > 0 ? (
        <View className="mt-4 gap-1">
          {horizon.hidden > 0 ? (
            <HorizonNote count={horizon.hidden} text="more within 6 wk — listed below" />
          ) : null}
          {horizon.undated > 0 ? (
            <HorizonNote count={horizon.undated} text="undated — not on the horizon" />
          ) : null}
        </View>
      ) : null}
    </View>
  );
}

function ScreeningRowView({
  screening,
  group,
  today,
  first,
  onPress,
}: {
  screening: ScreeningRow;
  group: GroupKey;
  today: string;
  first: boolean;
  onPress: () => void;
}) {
  const sub = `${CATEGORY_LABELS[screening.category]} · ${cadenceLabel(screening.interval_months)}`;

  let value: string | null = null;
  let qualifier: string | null = null;
  if (screening.next_due != null) {
    if (group === 'scheduled') {
      value = dueDateText(screening.next_due, today);
    } else {
      value = dueLabel(screening.next_due, today);
      qualifier = dueDateText(screening.next_due, today);
    }
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${screening.name}. ${sub}. ${value ?? 'No date'}. Edit.`}
      onPress={onPress}
      className={`min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60 ${
        first ? '' : 'border-t border-hairline'
      }`}>
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{screening.name}</Text>
        <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
          {sub}
        </Text>
      </View>
      {value != null ? (
        <View className="items-end">
          {/*
            Signal colour marks a biological/health state only — see header
            note. This is TEXT, so it takes the ink cut, not the swatch:
            `signal-caution` (#A97B22) is a fill colour and measures 3.41:1 on
            this plate, under 4.5:1. `signal-caution-ink` measures 6.77:1
            (00-design-spec.md §2).
          */}
          <Text
            className={`font-mono text-[13px] ${
              group === 'overdue' ? 'text-signal-caution-ink' : 'text-ink'
            }`}>
            {value}
          </Text>
          {qualifier ? (
            <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{qualifier}</Text>
          ) : null}
        </View>
      ) : (
        // No data, no number: an absent date is an em-dash, never a guess.
        <Text className="font-mono text-[13px] text-ink-muted">—</Text>
      )}
      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
    </Pressable>
  );
}

function AppointmentRowView({
  appt,
  today,
  first,
  onPress,
}: {
  appt: UpcomingAppointment;
  today: string;
  first: boolean;
  onPress: () => void;
}) {
  const sub = [
    appt.provider,
    appt.location,
    appt.screening_name ? `for ${appt.screening_name}` : null,
  ]
    .filter(Boolean)
    .join(' · ');

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${appt.title}. ${apptDateText(appt.scheduled_at, today)}, ${apptTimeText(
        appt.scheduled_at
      )}. Edit.`}
      onPress={onPress}
      className={`min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60 ${
        first ? '' : 'border-t border-hairline'
      }`}>
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{appt.title}</Text>
        {sub ? (
          <Text className="mt-0.5 font-serif text-[11px] text-ink-muted" numberOfLines={1}>
            {sub}
          </Text>
        ) : null}
      </View>
      <View className="items-end">
        <Text className="font-mono text-[13px] text-ink">
          {apptDateText(appt.scheduled_at, today)}
        </Text>
        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
          {apptTimeText(appt.scheduled_at)}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
    </Pressable>
  );
}

export default function ScreeningsScreen() {
  const router = useRouter();
  const { today, groups, emptyLedger, appointments, pastAppointments } = useScreenings();

  const horizon = buildHorizon(groups, appointments, today);
  // On a genuinely empty screen the ledger's own invite speaks; a second
  // authored empty above it would just be the same sentence twice.
  const showHorizon = !emptyLedger || appointments.length > 0;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Screenings" />
      </View>

      {/* a. The horizon — the next six weeks, drawn to scale. */}
      {showHorizon ? (
        <View className="mt-6">
          <SectionLabel label="Preventive horizon" note={`NEXT ${HORIZON_WEEKS} WK`} />
          <View className="mt-3">
            <HorizonAxis horizon={horizon} today={today} />
          </View>
        </View>
      ) : null}

      {/* b. The ledger — screenings grouped by due status, overdue first. */}
      {emptyLedger ? (
        // Authored, never blank — and never boxed: this is a paragraph, and a
        // border around one paragraph encloses no object.
        <View className="mt-6">
          <Text className="font-serif text-[17px] font-semibold text-ink">
            The preventive ledger
          </Text>
          <Text className="mt-1.5 font-serif text-[12.5px] leading-5 text-ink-secondary">
            The exams that guard the long game — colonoscopy, skin checks, imaging, dental, vision —
            each with its cadence, so nothing quietly slips a year.
          </Text>
        </View>
      ) : (
        GROUP_ORDER.map((key) => {
          const items = groups[key];
          if (items.length === 0) return null;
          return (
            <View key={key} className="mt-6">
              {/* The tally is the group's own count — it reconciles by construction. */}
              <SectionLabel label={GROUP_LABELS[key]} note={String(items.length)} />
              <View className="mt-3">
                <Block device="plate">
                  {items.map((s, index) => (
                    <ScreeningRowView
                      key={s.id}
                      screening={s}
                      group={key}
                      today={today}
                      first={index === 0}
                      onPress={() =>
                        router.push({ pathname: '/screening-form', params: { id: s.id } })
                      }
                    />
                  ))}
                </Block>
              </View>
            </View>
          );
        })
      )}

      {/* c. Add a screening — solid ink, not accent: see the header note. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Add screening"
        onPress={() => router.push('/screening-form')}
        className="mt-5 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-ink py-3.5 active:opacity-70">
        <Ionicons name="add" size={18} color={palette.paperHi} />
        <Text className="font-label text-[15px] font-semibold text-paper-hi">Add screening</Text>
      </Pressable>

      {/* d. Awaiting outcome — bookings whose day passed while still
          'scheduled'. Kept visible so they can be closed (mark completed /
          cancel) — completing a linked one stamps its screening done as of
          the visit. Hidden entirely when there's nothing to resolve. */}
      {pastAppointments.length > 0 ? (
        <View className="mt-8">
          <SectionLabel label="Awaiting outcome" note={String(pastAppointments.length)} />
          <View className="mt-3">
            <Block device="plate">
              {pastAppointments.map((a, index) => (
                <AppointmentRowView
                  key={a.id}
                  appt={a}
                  today={today}
                  first={index === 0}
                  onPress={() =>
                    router.push({ pathname: '/appointment-form', params: { id: a.id } })
                  }
                />
              ))}
            </Block>
          </View>
        </View>
      ) : null}

      {/* e. Calendar — upcoming booked appointments, soonest first. */}
      <View className="mt-8">
        <SectionLabel
          label="Calendar"
          note={appointments.length > 0 ? String(appointments.length) : undefined}
        />
        {/* Nothing booked is a sentence, not a record — so it is not plated. */}
        {appointments.length === 0 ? (
          <Text className="mt-2 font-serif text-[13px] text-ink-muted">Nothing booked</Text>
        ) : (
          <View className="mt-3">
            <Block device="plate">
              {appointments.map((a, index) => (
                <AppointmentRowView
                  key={a.id}
                  appt={a}
                  today={today}
                  first={index === 0}
                  onPress={() =>
                    router.push({ pathname: '/appointment-form', params: { id: a.id } })
                  }
                />
              ))}
            </Block>
          </View>
        )}

        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add appointment"
          onPress={() => router.push('/appointment-form')}
          className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
          <Ionicons name="add" size={16} color={palette.inkSecondary} />
          <Text className="font-label text-[14px] font-medium text-ink-secondary">
            Add appointment
          </Text>
        </Pressable>
      </View>
    </Screen>
  );
}
