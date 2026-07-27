import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { Sparkline } from '@/components/ui/sparkline';
import { palette } from '@/constants/theme';
import { useDataOverview, type TrendKey } from '@/hooks/use-data-overview';
import { fmtNum, rangeText } from '@/lib/biomarkers/format';

/**
 * Data — Frame A, "The Standing Ledger" (docs/information-architecture.md).
 *
 * The exploratory surface: never directive (that's Home's job), just a calm,
 * printed-looking record. Top to bottom: today's date + title; the one pine
 * accent on the screen — an invite to import bloodwork; a Trends card (Weight,
 * Nutrition, Training, Symptoms, each with a live sparkline and headline, or an
 * honest first-run invite); the reference biomarker ranges typeset ready to be
 * filled by a lab import; and "The full file" — the manage/browse index into
 * everything, most of it still to come.
 *
 * Everything here reads real on-device data (src/hooks/use-data-overview.ts) —
 * no MockupNote. The only pine on the screen is the import-labs card.
 */

const WEEKDAYS = ['SUN', 'MON', 'TUE', 'WED', 'THU', 'FRI', 'SAT'];
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

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
    { key: 'photos', label: 'Progress photos', icon: 'images-outline', chip: 'later' },
    { key: 'knowledge', label: 'Knowledge base', icon: 'library-outline', chip: 'later' },
    { key: 'export', label: 'Reports & export', icon: 'download-outline', chip: 'later' },
  ];

  return (
    <Screen scroll>
      {/* a. Header — this tab owns its own header (not StackHeader). */}
      <View className="pt-2">
        <Text className="text-[11px] uppercase tracking-[2px] text-ink-muted">{eyebrow}</Text>
        <Text className="mt-1 font-serif text-[26px] font-semibold text-ink">Data</Text>
        <Text className="mt-1 text-[13px] leading-5 text-ink-secondary">
          Your standing record — trends first, the full file below.
        </Text>
      </View>

      {/* b. THE ONE PINE — import bloodwork. Nothing else on this screen is pine. */}
      <View className="mt-6">
        <View className="rounded-card border border-t-[3px] border-pine-tint border-t-pine bg-pine-soft p-4 pb-5">
          <Text className="font-serif text-[17px] font-semibold text-ink">
            Bring in your bloodwork
          </Text>
          <Text className="mt-1 text-[12.5px] leading-5 text-ink-secondary">
            Function Health PDF → 160+ biomarkers, parsed on-device. The importer arrives with the
            pipeline — preview the ranges it&rsquo;ll grade you against.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Preview lab ranges"
            onPress={() => router.push('/labs')}
            className="mt-4 flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5 active:opacity-70">
            <Ionicons name="flask-outline" size={18} color={palette.pineOn} />
            <Text className="text-[15px] font-semibold text-pine-on">Preview lab ranges</Text>
          </Pressable>
        </View>
      </View>

      {/* c. Trends — one card, four domains, live sparklines or honest invites. */}
      <View className="mt-8">
        <SectionLabel>Trends</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
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
              className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
                index === 0 ? '' : 'border-t border-hairline-soft'
              }`}>
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">{t.name}</Text>
                <Text className="mt-0.5 text-[11px] text-ink-muted">{t.sub}</Text>
              </View>

              {t.empty ? (
                <Text className="text-[12px] text-ink-muted">{t.emptyLabel}</Text>
              ) : (
                <>
                  <Sparkline data={t.spark} baseline={t.sparkBaseline} />
                  <View className="items-end">
                    <View className="flex-row items-baseline gap-1">
                      <Text className="font-mono text-[17px] text-ink">{t.value}</Text>
                      {t.unit ? (
                        <Text className="font-mono text-[11px] text-ink-muted">{t.unit}</Text>
                      ) : null}
                    </View>
                    {t.qualifier ? (
                      <Text className="mt-0.5 text-[10px] text-ink-muted">{t.qualifier}</Text>
                    ) : null}
                  </View>
                </>
              )}

              <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
            </Pressable>
          ))}
        </View>
      </View>

      {/* d. Biomarkers — the reference ranges, awaiting a lab import to fill in. */}
      <View className="mt-8">
        <SectionLabel>{`Biomarkers · ${biomarkers.length} ranges typeset`}</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
          {biomarkers.map((b, index) => (
            <View
              key={b.slug}
              accessible
              accessibilityLabel={`${b.name}. Optimal ${rangeText(b)}. ${
                b.latestValue != null
                  ? `${fmtNum(b.latestValue)} ${b.unit ?? ''}`
                  : 'No reading yet'
              }.`}
              className={`flex-row items-center gap-3 px-4 py-3 ${
                index === 0 ? '' : 'border-t border-hairline-soft'
              }`}>
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">{b.name}</Text>
                <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">{rangeText(b)}</Text>
              </View>
              {b.latestValue != null ? (
                <View className="flex-row items-baseline gap-1">
                  <Text className="font-mono text-[15px] text-ink">{fmtNum(b.latestValue)}</Text>
                  {b.unit ? (
                    <Text className="font-mono text-[11px] text-ink-muted">{b.unit}</Text>
                  ) : null}
                </View>
              ) : (
                <Text className="text-[12px] text-ink-muted">No reading yet</Text>
              )}
            </View>
          ))}

          {/* Neutral (ink-secondary, not pine) invite into the labs screen. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="See all reference ranges"
            onPress={() => router.push('/labs')}
            className="flex-row items-center justify-between gap-3 border-t border-hairline-soft px-4 py-3 active:bg-paper-deep">
            <Text className="text-[12.5px] text-ink-secondary">See all reference ranges</Text>
            <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
          </Pressable>
        </View>
      </View>

      {/* e. The full file — the manage/browse index, most of it still to come. */}
      <View className="mt-8">
        <SectionLabel>The full file</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
          {fileRows.map((row, index) => {
            const tappable = row.onPress != null;
            const rowClass = `flex-row items-center gap-3 px-4 py-3 ${
              index === 0 ? '' : 'border-t border-hairline-soft'
            }`;
            const iconColor = tappable ? palette.inkSecondary : palette.inkMuted;

            // Both chips are neutral chrome — signal colours stay reserved for
            // biological states (docs/project-status.md). "Set up" reads a shade
            // stronger than "Later" via ink-secondary vs ink-muted, no hue.
            const chip =
              row.chip === 'setup' ? (
                <View className="rounded-btn bg-paper-deep px-2 py-0.5">
                  <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-secondary">
                    Set up
                  </Text>
                </View>
              ) : (
                <View className="rounded-btn bg-paper-deep px-2 py-0.5">
                  <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
                    Later
                  </Text>
                </View>
              );

            const inner = (
              <>
                <Ionicons name={row.icon} size={18} color={iconColor} />
                <Text className={`flex-1 text-[15px] ${tappable ? 'text-ink' : 'text-ink-muted'}`}>
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
                className={`${rowClass} active:bg-paper-deep`}>
                {inner}
              </Pressable>
            ) : (
              <View key={row.key} className={rowClass} accessibilityElementsHidden={false}>
                {inner}
              </View>
            );
          })}
        </View>
      </View>
    </Screen>
  );
}
