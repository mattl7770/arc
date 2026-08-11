import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { Sparkline } from '@/components/ui/sparkline';
import { palette } from '@/constants/theme';
import { useDataOverview, type TrendKey } from '@/hooks/use-data-overview';
import { fmtNum, rangeText } from '@/lib/biomarkers/format';

/**
 * Data — the standing record (docs/information-architecture.md).
 *
 * The exploratory surface: never directive — that is Home's job — just a calm,
 * drafted record. Top to bottom: today's folio line and title; the one accent
 * on the sheet, an invite to import bloodwork; **Trends** (Weight, Nutrition,
 * Training, Symptoms, each with a live sparkline and headline, or an honest
 * first-run invite); **The full file**, the manage/browse index into everything;
 * **Biomarkers**, the reference ranges waiting to be filled by a lab import; and
 * finally the row into **Settings**.
 *
 * ## Order and folding (owner call on hardware, 2026-08-09)
 *
 * Two changes came out of the first device review, and they are the same
 * problem: *"sections should be foldable in the data tab, and biomarkers should
 * be below 'the full file'."*
 *
 * The reason both are right is one number: **the biomarker catalogue is 65
 * markers** (`BIOMARKER_SEED` in src/lib/labs/catalog.ts — 65 entries, 65
 * distinct slugs; `grep -c 'slug:'` says 66 only because it also counts the
 * `slug: string;` line in the type declaration above the array). Every one of
 * them is drawn. Before a lab import that is 65 rows of em-dash between the two
 * sections you
 * actually navigate with, and it pushed the index — and now Settings — off the
 * bottom of a long scroll. So Biomarkers moved below the index, and the three
 * list sections fold.
 *
 * **Fold defaults are per-section, and chosen from that same number.** Trends
 * (4 rows) and The full file (8 rows) open — together they are about a screen
 * and a half, which is the tab as it should first read. Biomarkers (65 rows)
 * starts folded: until a report is imported it has nothing to say that its own
 * tally does not say better, and it is the only section long enough to bury
 * what follows it.
 *
 * **A folded section still states what it holds.** Every section header carries
 * a mono tally that is true in both states — `2 of 4 tracked`, `5 of 8 built`,
 * `0 of 65 measured` — so folding hides rows, never facts (00-design-spec.md
 * §5). Each tally is derived from the same array it renders, so the two can
 * never drift.
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
 * Almost everything here is a **ruled plate** — a record is a table, and this
 * whole screen is records (src/components/ui/block.tsx). The single exception
 * is the import card, which is the one thing on the sheet asking to be acted
 * on, so it takes the **stamped plate**.
 *
 * **The accent budget on this screen is exactly one: that stamp.** A reference
 * surface that highlights six things highlights nothing, and the moment Data
 * starts competing with Home for attention the home screen stops being the
 * answer to "what now?". Every other emphasis here is ink weight and rule —
 * including the Settings row at the bottom, which is neutral like every other
 * row on this sheet.
 *
 * **Signal colours do not appear on this screen's chrome at any point.** The
 * "Set up"/"Later" tags are interface state, not biology, so they are drawn as
 * outlined neutral chips — the firewall rule (00-design-spec.md §2).
 *
 * ## No data, no number
 *
 * Every absent value renders as an em-dash in the mono voice, never as a
 * plausible-looking zero or estimate, and the authored empty text sits in the
 * row's descriptor slot where it has room to read as a sentence.
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

/** Which list sections fold. The import stamp and the Settings row do not. */
type SectionKey = 'trends' | 'file' | 'biomarkers';

/**
 * A foldable section: a plate whose header row is the toggle.
 *
 * The header stays inside the plate rather than above it, so a collapsed
 * section is still a drawn object on the sheet — a closed drawer, not a
 * disappeared one. The chevron is `palette.inkMuted`: this screen's one accent
 * belongs to the import stamp, and a fold control is chrome.
 *
 * `children` is a **function**, not an element. A collapsed section then costs
 * nothing to render — which is the whole point when the section holds 65 rows.
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
  const { trends, biomarkers } = useDataOverview();

  // Session-scoped, not persisted — see the header comment. Biomarkers starts
  // folded because it is 65 rows and, before a lab import, 65 em-dashes.
  const [open, setOpen] = useState<Record<SectionKey, boolean>>({
    trends: true,
    file: true,
    biomarkers: false,
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
      case 'weight':
        router.push('/metric-entry');
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
      label: 'Labs & reports',
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
    { key: 'knowledge', label: 'Knowledge base', icon: 'library-outline', chip: 'later' },
    { key: 'export', label: 'Reports & export', icon: 'download-outline', chip: 'later' },
  ];

  // The three tallies. Each counts the very array its section renders, so a
  // folded header can never claim something the open rows would contradict.
  const tracked = trends.filter((t) => !t.empty).length;
  const trendsNote = `${tracked} of ${trends.length} tracked`;
  const built = fileRows.filter((r) => r.onPress != null).length;
  const fileNote = `${built} of ${fileRows.length} built`;
  const measured = biomarkers.filter((b) => b.latestValue != null).length;
  // Always the full ratio, never "No readings yet": a folded section has to say
  // how much it is holding, and "no readings" hides that there are 65 rows in
  // there waiting on an import.
  const biomarkersNote = `${measured} of ${biomarkers.length} measured`;

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
        {/* Instruction, not a tagline: the fold is this screen's one
            non-obvious interaction, and "your standing record" — which used to
            open this line — told the reader nothing the sheet below does not. */}
        <Text className="mt-1 font-serif text-[13px] leading-5 text-ink-secondary">
          Tap a section heading to fold it away.
        </Text>
      </View>

      {/* b. THE ONE ACCENT — the stamped plate. Nothing else on this screen is
          drawn in the accent, and nothing else on it is directive. It does not
          fold: it is the one action here, and an action you can hide is not
          one. */}
      <View className="mt-5">
        <Block device="stamp">
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
            Labs
          </Text>
          <Text className="mt-2 font-serif text-[19px] font-semibold leading-6 text-ink">
            Bring in your bloodwork
          </Text>
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            Function Health PDF → 160+ biomarkers, parsed on-device. Review every row before
            anything is saved, graded against ARC&rsquo;s longevity-optimal ranges.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Import a lab report"
            onPress={() => router.push('/lab-import')}
            className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine px-4 py-3 active:opacity-70">
            <Ionicons name="document-text-outline" size={18} color={palette.pineOn} />
            <Text className="font-label text-[15px] font-semibold text-pine-on">
              Import a report
            </Text>
          </Pressable>
        </Block>
      </View>

      {/* c. Trends — four domains, live sparklines or honest invites. */}
      <View className="mt-7">
        <FoldSection
          label="Trends"
          note={trendsNote}
          open={open.trends}
          onToggle={() => toggle('trends')}>
          {() => (
            <View className="mt-1">
              {trends.map((t, index) => (
                <Pressable
                  key={t.key}
                  accessibilityRole="button"
                  accessibilityLabel={
                    t.empty
                      ? `${t.name}. ${t.emptyLabel}. Open.`
                      : `${t.name}. ${t.value} ${t.unit}${t.qualifier ? ', ' + t.qualifier : ''}. Open.`
                  }
                  onPress={() => openTrend(t.key)}
                  className={`min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60 ${
                    index === 0 ? '' : 'border-t border-hairline'
                  }`}>
                  <View className="flex-1">
                    <Text className="font-serif text-[15px] text-ink">{t.name}</Text>
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
              ))}
            </View>
          )}
        </FoldSection>
      </View>

      {/* d. The full file — the manage/browse index, most of it still to come.
          Above Biomarkers now (owner call): this is the section you navigate
          with, and 65 marker rows should not sit between it and the trends. */}
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
                const rowClass = `min-h-[44px] flex-row items-center gap-3 py-3 ${
                  index === 0 ? '' : 'border-t border-hairline'
                }`;
                const iconColor = tappable ? palette.inkSecondary : palette.inkMuted;

                // Both tags are neutral chrome. Signal colours mark biological
                // state only, and "Set up" / "Later" are interface state — the
                // firewall was a finding in all six hostile reviews. "Set up"
                // sits a shade stronger than "Later" via ink weight alone, no
                // hue.
                //
                // UNBOXED. Each tag used to be outlined, on the argument that an
                // outline reads as an annotation rather than as a second surface
                // inside the plate. Eight rows means eight little rectangles
                // ruled inside a ruled plate, which on hardware is the noise the
                // owner keeps reporting — a border around one word encloses
                // nothing. The tags stay legible as a column because they are
                // right-aligned in mono against serif labels.
                const chip =
                  row.chip === 'setup' ? (
                    <Text className="font-mono text-[10px] tracking-[0.3px] text-ink-secondary">
                      Set up
                    </Text>
                  ) : (
                    <Text className="font-mono text-[10px] tracking-[0.3px] text-ink-muted">
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

                return tappable ? (
                  <Pressable
                    key={row.key}
                    accessibilityRole="button"
                    accessibilityLabel={row.label}
                    onPress={row.onPress}
                    className={`${rowClass} active:opacity-60`}>
                    {inner}
                  </Pressable>
                ) : (
                  <View key={row.key} className={rowClass} accessibilityElementsHidden={false}>
                    {inner}
                  </View>
                );
              })}
            </View>
          )}
        </FoldSection>
      </View>

      {/* e. Biomarkers — the reference ranges, awaiting a lab import to fill in.
          Values are biology, so this is the one place a signal colour would
          belong; until a reading is graded, ink and an em-dash carry it.
          Folded by default: 65 catalogued markers, and before an import every
          one of them reads as an em-dash. */}
      <View className="mt-7">
        <FoldSection
          label="Biomarkers"
          note={biomarkersNote}
          open={open.biomarkers}
          onToggle={() => toggle('biomarkers')}>
          {() => (
            <View className="mt-1">
              {biomarkers.map((b, index) => (
                <View
                  key={b.slug}
                  accessible
                  accessibilityLabel={`${b.name}. Optimal ${rangeText(b)}. ${
                    b.latestValue != null
                      ? `${fmtNum(b.latestValue)} ${b.unit ?? ''}`
                      : 'No reading yet'
                  }.`}
                  className={`flex-row items-center gap-3 py-3 ${
                    index === 0 ? '' : 'border-t border-hairline'
                  }`}>
                  <View className="flex-1">
                    <Text className="font-serif text-[15px] text-ink">{b.name}</Text>
                    <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                      {rangeText(b)}
                    </Text>
                  </View>
                  {b.latestValue != null ? (
                    <View className="flex-row items-baseline gap-1">
                      <Text className="font-mono text-[15px] text-ink">
                        {fmtNum(b.latestValue)}
                      </Text>
                      {b.unit ? (
                        <Text className="font-mono text-[11px] text-ink-muted">{b.unit}</Text>
                      ) : null}
                    </View>
                  ) : (
                    <Text className="font-mono text-[15px] text-ink-muted">—</Text>
                  )}
                </View>
              ))}

              {/* Neutral invite into the labs screen — this screen's accent is
                  already spent on the import stamp. */}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="See all reference ranges"
                onPress={() => router.push('/labs')}
                className="min-h-[44px] flex-row items-center justify-between gap-3 border-t border-hairline py-3 active:opacity-60">
                <View className="flex-1">
                  <Text className="font-serif text-[14px] text-ink-secondary">
                    See all reference ranges
                  </Text>
                  {measured === 0 ? (
                    <Text className="mt-0.5 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                      Import labs to populate
                    </Text>
                  ) : null}
                </View>
                <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
              </Pressable>
            </View>
          )}
        </FoldSection>
      </View>

      {/* f. Settings — off the tab bar as of 2026-08-09 and living here, at the
          foot of the record (owner call; see app/(tabs)/_layout.tsx).
          Deliberately NOT foldable and deliberately not inside another section:
          it is one row, always drawn, always the last thing on the sheet, so it
          is exactly as findable as "scroll to the bottom of Data". Neutral ink
          like every other row here — Data spends its one accent on the import
          stamp, and settings never carries an accent anywhere in the app. */}
      {/* Unboxed: a plate closes a record, and one row is not a record. The
          row was drawn inside its own plate, which put a rectangle around a
          single line at the foot of the sheet. */}
      <View className="mt-7">
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
      </View>
    </Screen>
  );
}
