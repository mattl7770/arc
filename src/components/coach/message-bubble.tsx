import Ionicons from '@expo/vector-icons/Ionicons';
import type { ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import type { AiTurnOutcome } from '@/lib/db/types';
import { isRetryableOutcome, type CoachChatView } from '@/hooks/use-coach-chat';

import { TypingIndicator } from './typing-indicator';

type Props = {
  message: CoachChatView;
  onRetry: () => void;
};

/** The neutral status chip's word for each unfinished outcome. Whole strings. */
const OUTCOME_CHIP: Record<AiTurnOutcome, string | null> = {
  complete: null,
  truncated: 'Cut off',
  tool_limit: 'Stopped short',
  refused: 'Not answered',
  failed: 'Unfinished',
};

/**
 * The plain sentence under the chip. A chip alone is a label; this is the part
 * that tells the owner what actually happened to the turn.
 */
const OUTCOME_LINE: Record<AiTurnOutcome, string | null> = {
  complete: null,
  truncated: 'The Coach hit its length limit — this reply stops mid-thought.',
  tool_limit: 'The Coach ran out of steps before it finished this answer.',
  refused: 'The Coach declined to answer this.',
  failed: 'The turn stopped before it finished.',
};

/**
 * Wall-clock "HH:MM" for a turn, or null when the row carries no usable time.
 *
 * **No data, no number** (00-design-spec.md §5). `createdAt` is `Date.parse` of
 * a persisted timestamp, so a malformed row yields NaN — and `new Date(NaN)
 * .toISOString()` throws, which would take the whole thread down over a stamp.
 * An unreadable time renders as no time, never as a plausible-looking one.
 */
function turnClock(createdAt: number): string | null {
  return Number.isFinite(createdAt) ? clockFromISO(new Date(createdAt).toISOString()) : null;
}

/**
 * Abbreviated months for the gutter, spelled-out months for speech — the same
 * split, and the same two tables, as home/date-eyebrow.tsx's folio line. That
 * file is the app's reference hand-rolled date format and this matches it rather
 * than inventing a second one: Hermes ships without `Intl`, so
 * `toLocaleDateString` silently ignores its options object on device and returns
 * a different string than it does in the web preview.
 *
 * The weekday is dropped. `date-eyebrow` prints "TUE 28 JUL" on a full-width
 * line; this has 36pt (see {@link Turn}), so it takes the day-and-month part of
 * that same format and nothing more.
 */
const MONTHS = [
  'JAN',
  'FEB',
  'MAR',
  'APR',
  'MAY',
  'JUN',
  'JUL',
  'AUG',
  'SEP',
  'OCT',
  'NOV',
  'DEC',
] as const;

const MONTHS_SPOKEN = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
] as const;

/** The gutter's date lines, plus the form the speaker's label says aloud. */
type TurnDate = {
  /** "28 JUL" — the printed day and month. */
  printed: string;
  /** "2025", or null when the turn is from the current calendar year. */
  year: string | null;
  /** "28 July 2025" — months spelled out, because "JUL" is read inconsistently. */
  spoken: string;
};

/**
 * The turn's calendar date, or **null when the turn happened today**.
 *
 * ## Why the date is on the turn and not on a separator row
 *
 * The obvious drawing is a "TUE 28 JUL" row inserted between the last turn of
 * one day and the first of the next, and in a thread that is read top to bottom
 * in one sitting that is the better drawing — it states each day once instead of
 * on every line. It is not what shipped, for two reasons.
 *
 * The first is structural. A separator is a fact about a PAIR of turns, so only
 * the thread renderer can decide to draw one; this component is handed one
 * message and has no idea what precedes it. That is a change to app/(tabs)/coach.tsx,
 * which is outside this change's boundary — and a `previousCreatedAt` prop added
 * here in advance would be a prop nothing passes, which is the drafting chrome
 * 00-design-spec.md §5 throws out.
 *
 * The second is that the noise argument the separator answers is already
 * answered, and more cheaply: **today's turns carry no date at all.** A thread is
 * overwhelmingly read on the day it is written, so the common case prints exactly
 * what it printed before — a bare "10:21" — and a stamp only appears on a turn
 * that genuinely needs disambiguating. That also keeps the date attached to the
 * turn it stamps rather than to a row above it, so scrolling into the middle of
 * an old conversation, or screenshotting one bubble, still tells the owner when
 * it was said. A separator scrolled off the top does not.
 *
 * The residual cost is honest and small: a long thread read a week later repeats
 * "3 AUG" down several consecutive turns. That is the case the separator wins,
 * and it is the rarer one.
 *
 * ## The year
 *
 * Printed only when it is not the current one. "10 AUG" on a turn from last year
 * is not terse, it is wrong — it reads as this year — and this app is meant to
 * run for decades. Within the current year the year would be noise, so it is
 * absent (§5: no number that isn't carrying information).
 *
 * `todayISODate` on both sides is deliberate: it is the app's single definition
 * of a LOCAL calendar day, the same one `daily_logs.date` is keyed by, so a turn
 * at 23:40 belongs to the day the wall clock says it does.
 */
function turnDate(createdAt: number, now: Date = new Date()): TurnDate | null {
  // Same guard as turnClock, same reason: a malformed stamp renders as no date
  // rather than as a plausible-looking wrong one (§5).
  if (!Number.isFinite(createdAt)) return null;
  const at = new Date(createdAt);
  if (todayISODate(at) === todayISODate(now)) return null;

  const day = at.getDate();
  const month = MONTHS[at.getMonth()] ?? '';
  const monthSpoken = MONTHS_SPOKEN[at.getMonth()] ?? '';
  const sameYear = at.getFullYear() === now.getFullYear();
  return {
    printed: `${day} ${month}`,
    year: sameYear ? null : String(at.getFullYear()),
    spoken: sameYear ? `${day} ${monthSpoken}` : `${day} ${monthSpoken} ${at.getFullYear()}`,
  };
}

/**
 * One turn in the thread.
 *
 * ## Conformed Set treatment
 *
 * The turns are drawn **directly on the sheet**. The thread used to sit on the
 * `well` device with the turns as marks on the recess; the owner read that box
 * as gratuitous on hardware and it came off (2026-08-09, see the surface note in
 * app/(tabs)/coach.tsx). Nothing here changed with it: the enclosure was the
 * screen's, the treatment is the turn's. The user speaks in solid accent on the
 * right — one of the six things §2 allows the accent to mark — and the Coach
 * answers on bordered `paper-hi` slips on the left, which is the plate treatment
 * at bubble scale. `paper-hi` on `paper` is a lighter step than `paper-hi` on
 * `paper-dim` was, so the Coach's slips now read as raised rather than as
 * inlaid; the hairline is what holds their edge, and it is unchanged.
 *
 * **Every corner is square**, including the bubbles. The mockup keeps a 12px
 * radius with one corner squared toward the speaker, but that is a browser
 * artefact of a set whose stated geometry is "corners: square" (§4) — and at a
 * `rounded-btn` scale of 2px a single squared corner is invisible anyway. The
 * speaker is named instead, in the label voice, the way the mockup's own
 * `cf-turn-who` names it: it survives a screenshot, a colour-blind reader and a
 * one-line turn, which a corner radius does not.
 *
 * All three voices appear: `font-label` for the speaker eyebrow, `font-mono` for
 * the turn's clock time and the tool chips (mono measures), `font-serif` for the
 * turn itself — Coach turns are prose, and prose is the serif's job.
 *
 * ## The turn is two columns: a clock gutter and everything else
 *
 * `.cf-turn` is `grid-template-columns: 36px 1fr` — the mono clock in a fixed
 * left gutter, the turn in the remaining column, a hairline between turns. The
 * app had folded the clock into the speaker eyebrow instead, which is the same
 * information and a worse drawing: an inline "COACH 07:41" makes the timestamps
 * of successive turns start at whatever x the speaker's name happens to end at,
 * so the one column in the thread that is pure measurement never lines up with
 * itself. In the gutter they stack into a readable time column down the left
 * edge, which is what a mono column is *for* (mono measures), and the eyebrow is
 * left saying only who spoke. {@link Turn} draws it, and the gutter is rendered
 * whether or not there is a time to put in it — an unreadable timestamp still
 * must not shift the turn beside it sideways.
 *
 * The gutter carries the turn's DATE too, on a second line under the clock, and
 * only on turns that are not today's — "10:21" and "10:29" read identically
 * whether they were yesterday or this morning, which is what the owner reported
 * (2026-08-11). The column keeps its 36pt exactly; {@link turnDate} records why
 * this is a per-turn stamp rather than a date separator between days, and
 * {@link Turn} why the line goes below the clock rather than above it.
 *
 * **Drawn first, spoken last** — the gutter leads in child order, which is also
 * accessibility order, so moving the clock out here made every turn announce a
 * bare "07:41" ahead of its own speaker. The gutter's copy is hidden from
 * assistive tech and the time is re-said inside the speaker's label instead; the
 * reasoning and the rejected alternatives are on {@link Turn}.
 *
 * **Two open questions, recorded rather than answered.** Both are consequences
 * of putting a left gutter in front of a thread that aligns by speaker, and both
 * want an owner's eye on hardware rather than a guess here:
 *
 *   1. A USER turn is wrapped too, so its stamp sits in the far-left gutter
 *      while its bubble hugs the right edge — the time and the turn on opposite
 *      sides of the screen. The sheet never has this problem because `.cf-turn`
 *      left-aligns both speakers; the app keeps side-of-screen as the speaker
 *      cue (see the alignment note above), and the gutter is what the two
 *      choices collide over.
 *   2. `max-w-[85%]` now measures 85% of the POST-gutter column. On a 375pt
 *      screen: 335pt of content, less the 36pt gutter and its 10pt gap, leaves
 *      289pt — so a full-width user bubble went from 284.8pt to 245.7pt, about
 *      39pt narrower, and long user turns wrap sooner than they used to.
 *
 * **Alignment inside the right column is ours, not the sheet's.** The mockup
 * left-aligns both speakers and leans on `cf-turn-who` to tell them apart; the
 * app keeps the user's turn hugging the right edge, because side-of-screen is
 * the one chat convention every reader already has and the accent bubble is
 * doing that work anyway. What was ported is the geometry the sheet actually
 * fixes — the gutter and the rules — not its choice to give that up.
 *
 * Vertical rhythm belongs to the thread, not the turn: the screen pads and rules
 * each turn (app/(tabs)/coach.tsx), so this component carries no outer margin of
 * its own and the last turn cannot leave a gap above the composer.
 *
 * ## A turn that did not finish says so
 *
 * Two things must survive a reload: that the reply is a fragment rather than an
 * answer, and — the case that matters most — that any writes the owner approved
 * mid-turn ALREADY LANDED in their record even though the Coach never got to the
 * end of the sentence. That is stated in words, not implied by a chip.
 *
 * All of it is WORKFLOW state, so it is neutral ink and paper tones only. The
 * signal-* palette is reserved for biological readings; a stalled network
 * request is not a health signal, and colouring it like one would devalue the
 * colours that are.
 */
export function MessageBubble({ message, onRetry }: Props) {
  const clock = turnClock(message.createdAt);
  // Null on today's turns, which is nearly all of them — see turnDate.
  const date = turnDate(message.createdAt);

  if (message.role === 'user') {
    return (
      <Turn clock={clock} date={date}>
        <View className="max-w-[85%] self-end">
          <Speaker who="You" clock={clock} date={date} tone="accent" align="right" />
          <View className="bg-pine px-3.5 py-2.5">
            <Text className="font-serif text-[15px] leading-6 text-pine-on">{message.content}</Text>
          </View>
        </View>
      </Turn>
    );
  }

  // Assistant, mid-stream, nothing yet → the thinking indicator.
  if (message.streaming && message.content.length === 0) {
    return (
      <Turn clock={clock} date={date}>
        <View className="max-w-[88%] self-start">
          <Speaker who="Coach" clock={clock} date={date} tone="muted" align="left" />
          <View className="border border-hairline bg-paper-hi px-3.5 py-3">
            <TypingIndicator />
          </View>
        </View>
      </Turn>
    );
  }

  const outcome = message.outcome ?? 'complete';
  const unfinished = !message.streaming && outcome !== 'complete';
  const writes = message.writes ?? [];
  // The load-bearing combination: the turn broke off, but writes already
  // committed. Silence here would let an approved change look like it never ran.
  const showWritesLanded = unfinished && writes.length > 0;
  const canRetry = !message.streaming && !message.superseded && isRetryableOutcome(outcome);

  return (
    <Turn clock={clock} date={date}>
      <View className="max-w-[88%] self-start">
        <Speaker who="Coach" clock={clock} date={date} tone="muted" align="left" />

        {/*
          Announce the reply to screen readers as it streams in — it is the most
          important event on the screen. The caret is decorative and hidden from
          assistive tech so it isn't read out as a character.
        */}
        <View
          accessibilityLiveRegion="polite"
          className="border border-hairline bg-paper-hi px-3.5 py-3">
          <Text className="font-serif text-[15px] leading-6 text-ink">
            {/* An error before the first token leaves content empty; show a line
                rather than an empty bubble. The retry pill sits below. */}
            {message.content.length === 0 && outcome === 'failed'
              ? 'Couldn’t reach the Coach.'
              : message.content}
            {message.streaming ? (
              <Text
                className="text-pine"
                accessibilityElementsHidden
                importantForAccessibility="no">
                {' ▍'}
              </Text>
            ) : null}
          </Text>
        </View>

        {/* Transparency chips: which data the turn actually read or wrote, and
            what it cost — the only recurring cost in ARC is model tokens, so it
            should be visible rather than a black box. */}
        {message.tools && message.tools.length > 0 ? (
          <Text className="mt-1 font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
            {message.tools.join(' · ')}
          </Text>
        ) : null}
        {message.usageCaption && !message.streaming ? (
          <Text className="mt-0.5 font-mono text-[10px] tracking-[0.5px] text-ink-muted">
            {message.usageCaption}
          </Text>
        ) : null}

        {/* Honesty over polish: a reply that hit a length/round-trip cap must
            never read as complete. Quiet ink, no alarm color — it's a fact,
            not a failure. */}
        {message.truncated && !message.streaming ? (
          <Text className="mt-1 text-xs text-ink-muted">
            Reply cut short — ask the Coach to continue.
          </Text>
        ) : null}

        {/* Workflow status: what became of this turn. Neutral ink throughout. */}
        {unfinished || message.superseded ? (
          <View className="mt-1.5 flex-row flex-wrap items-center gap-1.5">
            {unfinished && OUTCOME_CHIP[outcome] ? (
              <StateChip label={OUTCOME_CHIP[outcome]} />
            ) : null}
            {message.superseded ? <StateChip label="Superseded" /> : null}
          </View>
        ) : null}

        {unfinished && OUTCOME_LINE[outcome] ? (
          <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
            {OUTCOME_LINE[outcome]}
          </Text>
        ) : null}

        {/*
          Said plainly, because the owner's record changed: the writes are not
          pending, not rolled back, not waiting on the retry — they are in.
        */}
        {showWritesLanded ? (
          <Text className="mt-1 font-serif text-[12px] leading-5 text-ink">
            {'Saved before it stopped: '}
            <Text className="font-mono text-[11px] uppercase tracking-[1px] text-ink">
              {writes.join(' · ')}
            </Text>
            {
              '. Those changes are already in your record — only the reply is incomplete, so don’t log them again.'
            }
          </Text>
        ) : null}

        {message.superseded ? (
          <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-secondary">
            Replaced by the reply below. Kept because it is part of the record.
          </Text>
        ) : null}

        {canRetry ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Retry this turn"
            onPress={onRetry}
            className="min-h-[44px] flex-row items-center gap-1.5 self-start active:opacity-60">
            <Ionicons name="refresh" size={13} color={palette.inkSecondary} />
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
              Retry
            </Text>
          </Pressable>
        ) : null}
      </View>
    </Turn>
  );
}

/**
 * The turn's two-column frame: a fixed 36pt gutter carrying the mono clock, and
 * the turn itself in the column that remains (`.cf-turn`,
 * `grid-template-columns: 36px 1fr`).
 *
 * The gutter is drawn even when `clock` is null. `turnClock` returns null for an
 * unparseable timestamp — no data, no number (§5) — and if the gutter collapsed
 * with it, that one turn would sit 36pt left of every other turn in the thread,
 * turning a missing stamp into a broken column. A fixed empty gutter says the
 * time is absent; a missing gutter says the layout is.
 *
 * No `tabular-nums`: `clockFromISO` zero-pads both fields, so every stamp in the
 * column is already the same five characters, and Menlo is monospaced regardless.
 *
 * ## The gutter is drawn first and spoken never
 *
 * Accessibility order follows child order, and the gutter is the first child —
 * so the moment the clock moved out here, every turn in the thread started
 * announcing a naked "07:41" before the listener knew who had spoken. Sighted
 * reading has a column of stamps to place at a glance; a linear reading has one
 * stray number ahead of its own turn.
 *
 * The clock is therefore hidden from assistive tech HERE and re-said by
 * {@link Speaker} as part of the speaker's own label ("You, 07:41"). Of the three
 * ways out, this is the only one that leaves the drawing untouched and needs no
 * platform behaviour the app cannot rely on:
 *
 *   - Making the whole `Turn` `accessible` would fuse speaker, time and body
 *     into one utterance, but it also swallows every focusable thing inside the
 *     turn — the Retry control most of all, which would stop being reachable.
 *     A reordered announcement is not worth an unreachable button.
 *   - Re-ordering the accessible children without moving them visually needs
 *     RN's `experimental_accessibilityOrder`. The prefix is the whole objection:
 *     this app ships to one phone whose rebuild costs the owner twenty minutes,
 *     and an experimental prop is exactly the thing you find out about there.
 *   - Folding it into the speaker's label costs one hidden `Text` and one prop,
 *     works on shipped API, and puts the time back where it was BEFORE the
 *     gutter existed — attached to the name, which is where the app said it all
 *     along ("COACH 07:41"). The gutter keeps the drawing; the label keeps the
 *     reading order.
 *
 * Spoken and visible stay in agreement: the same `clock` and `date` values feed
 * both, and a turn with no usable time prints nothing and says nothing.
 *
 * ## The date hangs BELOW the clock, and only on turns that are not today's
 *
 * The owner asked for dates on the thread: "10:21" and "10:29" read identically
 * whether they were yesterday or this morning (2026-08-11). The date is a second
 * mono line in this same gutter — see {@link turnDate} for why it is not a
 * separator row between days, and why today's turns still carry no date at all.
 *
 * **Below, never above.** Put the date first and a dated turn's clock sits a line
 * lower than an undated turn's, so the one column in the thread that exists to
 * line up with itself stops doing that, and the clock stops sitting level with
 * the speaker eyebrow beside it. Below, the clock keeps its baseline on every
 * turn in the thread and the date hangs off it as the qualifier it is.
 *
 * **The column does not get wider.** 36pt is the sheet's `.cf-turn` geometry and
 * is fixed. Menlo's advance is 0.6021 em, so at the clock's 10px a six-character
 * "10 AUG" measures 36.1pt and would wrap mid-date; at 9px it measures 32.5pt and
 * fits with room to spare. The step down is not only a fitting trick — the clock
 * is the stamp and the date qualifies it — but the fit is why 9px and not 10.
 * `numberOfLines={1}` is the backstop: a stamp must never reflow the gutter.
 */
function Turn({
  clock,
  date,
  children,
}: {
  clock: string | null;
  date: TurnDate | null;
  children: ReactNode;
}) {
  return (
    <View className="flex-row gap-2.5">
      <View className="w-9 pt-0.5">
        {clock ? <GutterStamp text={clock} size="clock" /> : null}
        {date ? <GutterStamp text={date.printed} size="date" /> : null}
        {date?.year ? <GutterStamp text={date.year} size="date" /> : null}
      </View>
      <View className="flex-1">{children}</View>
    </View>
  );
}

/** Whole literals, never a built fragment — Tailwind only scans source text. */
const GUTTER_SIZE = {
  clock: 'font-mono text-[10px] text-ink-muted',
  date: 'font-mono text-[9px] text-ink-muted',
} as const;

/**
 * One line of the clock gutter. Hidden from assistive tech, every one of them:
 * the gutter is drawn first and therefore READ first, so an unhidden stamp
 * announces a bare "10:21" — or now "10:21, 3 AUG" — ahead of its own speaker.
 * {@link Speaker} re-says the whole thing as part of the speaker's label.
 */
function GutterStamp({ text, size }: { text: string; size: keyof typeof GUTTER_SIZE }) {
  return (
    <Text
      accessibilityElementsHidden
      importantForAccessibility="no"
      numberOfLines={1}
      className={GUTTER_SIZE[size]}>
      {text}
    </Text>
  );
}

/**
 * The speaker eyebrow: who said it. Just the name, in the label voice — the
 * clock left for the gutter (see {@link Turn}), which is where the sheet puts it
 * and where a column of measurements can line up with itself. The "serif speaks,
 * mono measures" split still holds across the turn; it is now drawn across two
 * columns instead of crammed into one line.
 *
 * **`clock` and `date` are spoken here and printed nowhere here.** The eyebrow
 * renders the name alone, exactly as drawn; the label it hands assistive tech is
 * "You, 07:41" — or "Coach, 3 August, 07:41" on a turn that is not today's,
 * which is exactly when the gutter grows its second line. That is the first
 * thing a listener reaches in the turn, and it now says who before it says when.
 * The gutter's copies are hidden to keep the stamp from being announced twice —
 * the reasoning, and the two alternatives that were rejected, are on
 * {@link Turn}.
 *
 * Spoken and printed agree on WHICH day and disagree only on how a month is
 * spelled: the gutter prints "3 AUG" and the label says "3 August", because
 * "AUG" is read aloud inconsistently. Same split home/date-eyebrow.tsx makes on
 * the folio line, and the same one ./../home/signal.tsx makes on the em-dash.
 *
 * Both tone and alignment are whole class strings picked from a map, never a
 * built prefix: Tailwind's scanner only sees literal class names.
 */
const SPEAKER_TONE = {
  accent: 'text-pine-deep',
  muted: 'text-ink-muted',
} as const;

const SPEAKER_ALIGN = {
  left: 'mb-1 flex-row items-baseline gap-1.5',
  right: 'mb-1 flex-row items-baseline justify-end gap-1.5',
} as const;

function Speaker({
  who,
  clock,
  date,
  tone,
  align,
}: {
  who: string;
  /** The turn's time, spoken with the name. Drawn in the gutter, not here. */
  clock: string | null;
  /** The turn's day, when it is not today's. Also drawn in the gutter, not here. */
  date: TurnDate | null;
  tone: keyof typeof SPEAKER_TONE;
  align: keyof typeof SPEAKER_ALIGN;
}) {
  return (
    <View className={SPEAKER_ALIGN[align]}>
      <Text
        accessibilityLabel={speakerLabel(who, clock, date)}
        className={`font-label text-[10px] font-semibold uppercase tracking-[1.2px] ${SPEAKER_TONE[tone]}`}>
        {who}
      </Text>
    </View>
  );
}

/**
 * "Coach", "Coach, 07:41", or "Coach, 3 August, 07:41" — day before time, the
 * order the gutter reads in and the order the parts were added in. Anything the
 * gutter does not draw is not said, so an unparseable stamp announces the name
 * alone rather than a plausible-looking wrong one.
 */
function speakerLabel(who: string, clock: string | null, date: TurnDate | null): string {
  return [who, date?.spoken, clock].filter(Boolean).join(', ');
}

/**
 * A workflow-state chip — squared, bordered, neutral. Never signal-*: "cut off"
 * and "superseded" are facts about a network turn, not about the owner's body.
 */
function StateChip({ label }: { label: string }) {
  return (
    <View className="border border-hairline bg-paper-hi px-2 py-0.5">
      <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-secondary">
        {label}
      </Text>
    </View>
  );
}
