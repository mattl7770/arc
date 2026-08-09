import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
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
 * on the sheet, an invite to import bloodwork; Trends (Weight, Nutrition,
 * Training, Symptoms, each with a live sparkline and headline, or an honest
 * first-run invite); the biomarker reference ranges waiting to be filled by a
 * lab import; and "The full file", the manage/browse index into everything.
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
 * answer to "what now?". Every other emphasis here is ink weight and rule.
 *
 * **Signal colours do not appear on this screen's chrome at any point.** The
 * "Set up"/"Later" tags are interface state, not biology, so they are drawn as
 * outlined neutral chips — the firewall rule (00-design-spec.md §2).
 *
 * ## No data, no number
 *
 * Every absent value renders as an em-dash in the mono voice, never as a
 * plausible-looking zero or estimate, and the authored empty text sits in the
 * row's descriptor slot where it has room to read as a sentence. The
 * Biomarkers section note carries the tally it is responsible for
 * (`measured of catalogued`), which reconciles against the rows below it: every
 * catalogued marker is drawn, so the two numbers can never drift.
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

export default function DataScreen() {
  const router = useRouter();
  const { trends, biomarkers } = useDataOverview();

  // Hand-rolled: Hermes ships without Intl, so toLocaleDateString silently
  // ignores its options object on device (src/components/home/date-eyebrow.tsx).
  const now = new Date();
  const eyebrow = `${WEEKDAYS[now.getDay()] ?? ''} · ${MONTHS[now.getMonth()] ?? ''} ${now.getDate()}`;

  // The Biomarkers tally. Every catalogued marker is rendered below, so
  // `measured` + the unmeasured rows sum to `biomarkers.length` by construction.
  const measured = biomarkers.filter((b) => b.latestValue != null).length;

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
        <Text className="mt-1 font-serif text-[13px] leading-5 text-ink-secondary">
          Your standing record — trends first, the full file below.
        </Text>
      </View>

      {/* b. THE ONE ACCENT — the stamped plate. Nothing else on this screen is
          drawn in the accent, and nothing else on it is directive. */}
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

      {/* c. Trends — one plate, four domains, live sparklines or honest invites. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="Trends" />
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
        </Block>
      </View>

      {/* d. Biomarkers — the reference ranges, awaiting a lab import to fill in.
          Values are biology, so this is the one place a signal colour would
          belong; until a reading is graded, ink and an em-dash carry it. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel
            label="Biomarkers"
            note={
              measured === 0 ? 'No readings yet' : `${measured} of ${biomarkers.length} measured`
            }
          />
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
                    <Text className="font-mono text-[15px] text-ink">{fmtNum(b.latestValue)}</Text>
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
        </Block>
      </View>

      {/* e. The full file — the manage/browse index, most of it still to come. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="The full file" />
          <View className="mt-1">
            {fileRows.map((row, index) => {
              const tappable = row.onPress != null;
              const rowClass = `min-h-[44px] flex-row items-center gap-3 py-3 ${
                index === 0 ? '' : 'border-t border-hairline'
              }`;
              const iconColor = tappable ? palette.inkSecondary : palette.inkMuted;

              // Both tags are neutral chrome. Signal colours mark biological
              // state only, and "Set up" / "Later" are interface state — the
              // firewall was a finding in all six hostile reviews. Outlined
              // rather than filled, so the tag reads as an annotation on the
              // record instead of a second surface inside the plate. Both carry
              // the same rule weight (`hairline`, the one rule the sheet uses);
              // "Set up" sits a shade stronger than "Later" via ink weight
              // alone, no hue. Do not reach for `hairline-soft` here — at
              // 1.62:1 on paper-hi it does not draw.
              const chip =
                row.chip === 'setup' ? (
                  <View className="border border-hairline px-1.5 py-0.5">
                    <Text className="font-mono text-[10px] tracking-[0.3px] text-ink-secondary">
                      Set up
                    </Text>
                  </View>
                ) : (
                  <View className="border border-hairline px-1.5 py-0.5">
                    <Text className="font-mono text-[10px] tracking-[0.3px] text-ink-muted">
                      Later
                    </Text>
                  </View>
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
        </Block>
      </View>
    </Screen>
  );
}
