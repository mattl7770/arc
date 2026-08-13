import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { Sparkline } from '@/components/ui/sparkline';
import { palette } from '@/constants/theme';
import { useDataOverview, type TrendKey } from '@/hooks/use-data-overview';

/**
 * Data — the standing record (docs/information-architecture.md).
 *
 * The exploratory surface: never directive — that is Home's job — just a calm,
 * drafted record. Top to bottom: today's folio line and title; **Trends**
 * (Weight, Nutrition, Training, Symptoms, each with a live sparkline and
 * headline, or an honest first-run invite); **The full file**, the manage/browse
 * index into everything; and the row into **Settings**.
 *
 * ## Bloodwork lives on the Labs screen — all of it (owner call, 2026-08-11)
 *
 * Off hardware: *"The big 'bring in your bloodwork' on the top of the data page
 * should be within the labs & reports section. Furthermore, the 'biomarkers'
 * should also be within the labs & reports only."*
 *
 * What that names is a **duplication**, not a layout preference. app/labs.tsx —
 * pushed from the "Labs" row of The full file below — already drew an import
 * action, and already drew the whole biomarker catalogue grouped by category
 * with a measured tally per group. This screen drew a second copy of both: the
 * accent import stamp at the top of the sheet, and a flat 65-row `Biomarkers`
 * fold beneath the index. Two screens, the same rows, different treatments, and
 * nothing on either to tell the reader which one was the real file.
 *
 * Neither was deleted; both consolidated one level down. The stamp is now the
 * head of app/labs.tsx, moved verbatim (cap and all), and the marker rows were
 * already there in a better form than this screen ever gave them — grouped by
 * category, tallied per group, and beside the reports they came out of. The
 * index row is the single route in, which is what an index is for.
 *
 * **The instruction line went at the same time**, on the same call: *"In the
 * data tab, there is 'Tap a section heading to fold it away.' get rid of this."*
 * The chevron on every section header states that affordance already, and a
 * sheet that opens by explaining its own controls is not a calm one. Nothing
 * replaced it — the title stands alone.
 *
 * ## Folding (owner call on hardware, 2026-08-09)
 *
 * The list sections fold, from the first device review: *"sections should be
 * foldable in the data tab, and biomarkers should be below 'the full file'."*
 *
 * Both halves of that were about one number — **the biomarker catalogue is 65
 * markers** (`BIOMARKER_SEED` in src/lib/labs/catalog.ts), every one of them
 * drawn, which before an import was 65 rows of "No reading yet" burying the
 * index and Settings under a long scroll. That section has now left the screen
 * entirely (above), so what remains is Trends (4 rows) and The full file (8
 * rows), **both open**: together they are about a screen and a half, which is
 * the tab as it should first read. The fold survives as a way to put a section
 * aside, no longer as the thing that made this screen navigable.
 *
 * **A folded section still states what it holds.** Each section header carries a
 * mono tally that is true in both states — `2 of 4 tracked`, `5 of 8 built` — so
 * folding hides rows, never facts (00-design-spec.md §5). Each tally is derived
 * from the same array it renders, so the two can never drift.
 *
 * **Folds go both ways.** The header is one toggle, `!open`, with
 * `accessibilityState.expanded` on it — an earlier one-way fold on Home was a
 * real bug, and the shape that caused it (separate "expand" affordance, no
 * inverse) is the shape avoided here.
 *
 * **Fold state is NOT persisted, deliberately.** `users.preferences` (the
 * pattern behind unit choices, the app lock, Apple Health) holds things the
 * user *sets* — durable statements about how the app should behave. A fold is a
 * momentary "not now" about one screen. Persisting it means a tap from three
 * weeks ago silently hides this tab's headline with nothing on screen to
 * explain why, and it means a database write on every chevron. The state that
 * actually matters — fold, drill into a trend, come back — already survives,
 * because tab screens stay mounted for the life of the session. Reopening the
 * app resets to the defaults above, which are the defaults *because* they are
 * the right first read.
 *
 * ## The surface system
 *
 * Everything here is a **ruled plate** — a record is a table, and this whole
 * screen is records (src/components/ui/block.tsx).
 *
 * **The accent budget on this screen is now zero, and that is the right
 * number.** It was exactly one — the import stamp — on the reasoning that a
 * reference surface highlighting six things highlights nothing, and that the
 * moment Data starts competing with Home for attention the home screen stops
 * being the answer to "what now?". The stamp was the one directive thing here;
 * it left with the bloodwork, and nothing was promoted to fill the hole. Data is
 * a surface you read and navigate, so every emphasis on it is ink weight and
 * rule — including the Settings row at the bottom, neutral like every other row
 * on this sheet.
 *
 * **Signal colours do not appear on this screen's chrome at any point.** The
 * "Set up"/"Later" tags are interface state, not biology, so they are drawn as
 * outlined neutral chips — the firewall rule (00-design-spec.md §2).
 *
 * ## No data, no number — and empty is authored
 *
 * No absent value is ever a plausible-looking zero or estimate. A **trend** row
 * has somewhere to put the sentence: its descriptor line carries the authored
 * empty ("No entries yet") and its value slot stays a value slot, so an em-dash
 * sits there. Both rules of §5 are satisfied — the row prints no figure, and the
 * empty is written out — because the slot that can hold words sits directly
 * under the one that cannot. (A **biomarker** row has no such second slot, its
 * sub-line being the reference range, so it says "No reading yet" in the value
 * slot itself; those rows are on app/labs.tsx now and that is where the rule is
 * recorded.)
 *
 * Everything here reads real on-device data (src/hooks/use-data-overview.ts).
 */

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

/** One row of "The full file" index. Non-tappable rows omit `onPress`. */
type FileRow = {
  key: string;
  label: string;
  icon: keyof typeof Ionicons.glyphMap;
  chip: 'setup' | 'later';
  onPress?: () => void;
};

/** Which list sections fold. The Settings row does not — it is one row. */
type SectionKey = 'trends' | 'file';

/**
 * A foldable section: a plate whose header row is the toggle.
 *
 * The header stays inside the plate rather than above it, so a collapsed
 * section is still a drawn object on the sheet — a closed drawer, not a
 * disappeared one. The chevron is `palette.inkMuted`: this screen carries no
 * accent at all, and a fold control is chrome even where one exists.
 *
 * `children` is a **function**, not an element. A collapsed section then costs
 * nothing to render — which mattered most for the 65-row biomarker list that
 * has since moved to app/labs.tsx, and still holds for the two that remain.
 */
function FoldSection({
  label,
  note,
  open,
  onToggle,
  children,
}: {
  label: string;
  /** The tally. Must be true whether the section is open or closed. */
  note: string;
  open: boolean;
  onToggle: () => void;
  children: () => ReactNode;
}) {
  return (
    <Block device="plate">
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: open }}
        accessibilityLabel={`${label}. ${note}. ${open ? 'Collapse' : 'Expand'}.`}
        onPress={onToggle}
        className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
        <View className="flex-1">
          <SectionLabel label={label} note={note} />
        </View>
        <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={palette.inkMuted} />
      </Pressable>
      {open ? children() : null}
    </Block>
  );
}

export default function DataScreen() {
  const router = useRouter();
  const { trends } = useDataOverview();

  // Session-scoped, not persisted — see the header comment. Both sections open:
  // the only one that ever started folded was Biomarkers, and it now lives on
  // app/labs.tsx.
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    trends: true,
    file: true,
  });
  const toggle = useCallback(
    (key: SectionKey) => setOpen((prev) => ({ ...prev, [key]: !prev[key] })),
    []
  );

  // Hand-rolled: Hermes ships without Intl, so toLocaleDateString silently
  // ignores its options object on device (src/components/home/date-eyebrow.tsx).
  const now = new Date();
  const eyebrow = `${WEEKDAYS[now.getDay()] ?? ''} · ${MONTHS[now.getMonth()] ?? ''} ${now.getDate()}`;

  const openTrend = (key: TrendKey) => {
    switch (key) {
      case 'mission':
        // The mission IS Home's, so the row goes to the tab that owns it rather
        // than to a second copy of it. `navigate`, not `push`: Home is already
        // mounted in the bar, and pushing would stack a duplicate on top of it.
        router.navigate('/');
        return;
      case 'weight':
        // `from` names this screen on the keypad's back control. That screen is
        // reached from the Log tab twice and from here once, and the sheet's
        // `‹ Log` is its default — so the one caller that is NOT the Log tab has
        // to say so, or the control names a destination it will not go to.
        router.push({ pathname: '/metric-entry', params: { from: 'Data' } });
        return;
      case 'nutrition':
        router.push('/nutrition');
        return;
      case 'training':
        router.push('/exercise');
        return;
      case 'symptoms':
        router.push('/symptom');
        return;
    }
  };

  const fileRows: FileRow[] = [
    {
      key: 'labs',
      // "Labs", not "Labs & reports": the row and the screen it pushes have to
      // agree, app/labs.tsx titles itself Labs, and "Labs" is what the route,
      // the file and docs/information-architecture.md all call this domain. The
      // "& reports" half named only the imported-PDF list, which since
      // 2026-08-11 is one of three things on that sheet — so the compound was
      // both redundant with "Labs" and no longer a complete description.
      label: 'Labs',
      icon: 'flask-outline',
      chip: 'setup',
      onPress: () => router.push('/labs'),
    },
    {
      key: 'protocols',
      label: 'Protocols',
      icon: 'git-branch-outline',
      chip: 'setup',
      onPress: () => router.push('/protocols'),
    },
    {
      key: 'screenings',
      label: 'Screenings & calendar',
      icon: 'calendar-outline',
      chip: 'setup',
      onPress: () => router.push('/screenings'),
    },
    {
      key: 'wearables',
      label: 'Wearables & recovery',
      icon: 'watch-outline',
      chip: 'setup',
      onPress: () => router.push('/wearables'),
    },
    {
      key: 'experiments',
      label: 'Experiments',
      icon: 'beaker-outline',
      chip: 'setup',
      onPress: () => router.push('/experiments'),
    },
    { key: 'photos', label: 'Progress photos', icon: 'images-outline', chip: 'later' },
    {
      key: 'knowledge',
      label: 'Knowledge base',
      icon: 'library-outline',
      chip: 'setup',
      onPress: () => router.push('/knowledge'),
    },
    { key: 'export', label: 'Reports & export', icon: 'download-outline', chip: 'later' },
  ];

  // Both tallies. Each counts the very array its section renders, so a folded
  // header can never claim something the open rows would contradict.
  const tracked = trends.filter((t) => !t.empty).length;
  const trendsNote = `${tracked} of ${trends.length} tracked`;
  const built = fileRows.filter((r) => r.onPress != null).length;
  const fileNote = `${built} of ${fileRows.length} built`;

  return (
    <Screen scroll>
      {/* a. The folio line — this tab owns its own header (not StackHeader).
          Unruled: a hairline under one short line closes a box around it, and
          in this design rules enclose objects, never pages. */}
      <View className="pt-2">
        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
          {eyebrow}
        </Text>
        <Text className="mt-1 font-serif text-[26px] font-semibold text-ink">Data</Text>
      </View>

      {/* b. Trends — four domains, live sparklines or honest invites. First
          object on the sheet as of 2026-08-11: the import stamp that used to
          open the screen is on app/labs.tsx now (see the header), and a
          reference surface is right to open on a reading rather than on an
          action performed a few times a year. */}
      <View className="mt-7">
        <FoldSection
          label="Trends"
          note={trendsNote}
          open={open.trends}
          onToggle={() => toggle('trends')}>
          {() => (
            <View className="mt-1">
              {trends.map((t, index) => (
                <View key={t.key}>
                  <Divider first={index === 0} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={
                      t.empty
                        ? `${t.name}. ${t.emptyLabel}. Open.`
                        : `${t.name}. ${t.value} ${t.unit}${t.qualifier ? ', ' + t.qualifier : ''}. Open.`
                    }
                    onPress={() => openTrend(t.key)}
                    className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
                    <View className="flex-1">
                      {/* LABEL voice, not serif. The sheet's `.cf-trendrow-t` is
                        `font-label` / 700, and its `.cf-trendrow-s` beneath it is
                        serif — the reading face on the sub-line, the label face
                        on the name. That inversion is deliberate: "Weight" is not
                        speech, it is the name of an instrument channel, and the
                        sentence about it ("Last 30 days", "No entries yet") is
                        the thing being read. The port had them the other way
                        round, which made a domain name look like prose.

                        Size stays at the app's row-name scale rather than the
                        sheet's 11px. Every size on that mockup was drawn for a
                        browser phone and this app has upscaled all of them
                        (`.cf-brow-name` 11 → 15, `.cf-card-title` 14.5 → 19); at
                        a literal 11px the name would land smaller than the
                        sub-line it heads. The voice was the bug, not the scale. */}
                      <Text className="font-label text-[15px] font-semibold text-ink">
                        {t.name}
                      </Text>
                      {/* The descriptor slot carries the authored empty when there
                        is nothing to describe — it has room to read as a sentence
                        there, and the value slot stays a value slot. */}
                      <Text className="mt-0.5 font-serif text-[11px] leading-4 text-ink-muted">
                        {t.empty ? t.emptyLabel : t.sub}
                      </Text>
                    </View>

                    {t.empty ? null : <Sparkline data={t.spark} baseline={t.sparkBaseline} />}

                    <View className="items-end">
                      <View className="flex-row items-baseline gap-1">
                        {/* No data, no number: an em-dash, never a stand-in zero. */}
                        <Text
                          className={
                            t.empty
                              ? 'font-mono text-[17px] text-ink-muted'
                              : 'font-mono text-[17px] text-ink'
                          }>
                          {t.empty ? '—' : t.value}
                        </Text>
                        {!t.empty && t.unit ? (
                          <Text className="font-mono text-[11px] text-ink-muted">{t.unit}</Text>
                        ) : null}
                      </View>
                      {!t.empty && t.qualifier ? (
                        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                          {t.qualifier}
                        </Text>
                      ) : null}
                    </View>

                    <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
                  </Pressable>
                </View>
              ))}
            </View>
          )}
        </FoldSection>
      </View>

      {/* c. The full file — the manage/browse index, most of it still to come.
          The last section on the sheet before Settings: the 65 marker rows that
          once sat under it are on app/labs.tsx, one tap down the "Labs" row
          below (owner call, 2026-08-11 — see the header). */}
      <View className="mt-7">
        <FoldSection
          label="The full file"
          note={fileNote}
          open={open.file}
          onToggle={() => toggle('file')}>
          {() => (
            <View className="mt-1">
              {fileRows.map((row, index) => {
                const tappable = row.onPress != null;
                const rowClass = 'min-h-[44px] flex-row items-center gap-3 py-3';
                const iconColor = tappable ? palette.inkSecondary : palette.inkMuted;

                // BOXED, as the sheet draws them: `.cf-lrow-tag` is
                // `1px solid var(--paper-line)` with `3px 7px` of padding.
                //
                // The outline was stripped on 2026-08-10 with the reasoning "a
                // border around one word encloses nothing". That reasoning is
                // WITHDRAWN. It was invented during a de-plating sweep whose
                // governing rule the owner rejected outright ("All the wrong
                // boxes were removed, bring them back!"), and the noise that
                // sweep was chasing turned out to be a rendering fault, not a
                // design one — one-sided border widths paired with a border
                // colour, which React Native paints as a full rectangle (see the
                // header of src/components/ui/block.tsx). These tags never had
                // that shape. A UNIFORM four-sided border is the case that always
                // drew correctly, and it is what the design asked for: the box is
                // what makes "Set up" read as a status stamped on the row rather
                // than as a second, quieter label competing with the first.
                //
                // Both tags stay neutral chrome. Signal colours mark biological
                // state only, and "Set up" / "Later" are interface state — the
                // firewall was a finding in all six hostile reviews. "Set up"
                // sits a shade stronger than "Later" via ink weight alone, no
                // hue, and both wear the same rule so the column reads as one
                // kind of mark.
                const chip =
                  row.chip === 'setup' ? (
                    <Text className="border border-hairline px-[7px] py-[3px] font-mono text-[10px] tracking-[0.3px] text-ink-secondary">
                      Set up
                    </Text>
                  ) : (
                    <Text className="border border-hairline px-[7px] py-[3px] font-mono text-[10px] tracking-[0.3px] text-ink-muted">
                      Later
                    </Text>
                  );

                const inner = (
                  <>
                    <Ionicons name={row.icon} size={18} color={iconColor} />
                    <Text
                      className={
                        tappable
                          ? 'flex-1 font-serif text-[15px] text-ink'
                          : 'flex-1 font-serif text-[15px] text-ink-muted'
                      }>
                      {row.label}
                    </Text>
                    {chip}
                    {tappable ? (
                      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
                    ) : null}
                  </>
                );

                return (
                  <View key={row.key}>
                    <Divider first={index === 0} />
                    {tappable ? (
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={row.label}
                        onPress={row.onPress}
                        className={`${rowClass} active:opacity-60`}>
                        {inner}
                      </Pressable>
                    ) : (
                      <View className={rowClass} accessibilityElementsHidden={false}>
                        {inner}
                      </View>
                    )}
                  </View>
                );
              })}
            </View>
          )}
        </FoldSection>
      </View>

      {/* d. Settings — off the tab bar as of 2026-08-09 and living here, at the
          foot of the record (owner call; see app/(tabs)/_layout.tsx).
          Deliberately NOT foldable and deliberately not inside another section:
          it is one row, always drawn, always the last thing on the sheet, so it
          is exactly as findable as "scroll to the bottom of Data". Neutral ink
          like every other row here — Data carries no accent at all since the
          import stamp left, and settings never carries one anywhere in the
          app. */}
      {/* Plated, like every other row on this sheet. It was stripped in the
          de-plating sweep of 2026-08-10 on the rule "one row is not a record";
          the owner rejected that rule outright, and the boxes it removed are
          back. A plate encloses a record, and a destination into the whole of
          Settings is a record entry like Labs or Protocols above it. */}
      <View className="mt-7">
        <Block device="plate">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Settings"
            onPress={() => router.push('/settings')}
            className="min-h-[44px] flex-row items-center gap-3 active:opacity-60">
            <Ionicons name="settings-outline" size={18} color={palette.inkSecondary} />
            <View className="flex-1">
              <Text className="font-serif text-[15px] text-ink">Settings</Text>
              <Text className="mt-0.5 font-serif text-[12px] leading-4 text-ink-muted">
                Profile, units, Coach model, Apple Health, app lock and export
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
          </Pressable>
        </Block>
      </View>
    </Screen>
  );
}
