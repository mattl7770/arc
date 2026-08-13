import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useReportsHistory } from '@/hooks/use-reports';
import {
  lastCalendarMonth,
  lastCompleteWeek,
  validateCustomRange,
  MAX_CUSTOM_RANGE_DAYS,
} from '@/lib/reports/period';
import type { Period } from '@/lib/reports/types';

/**
 * Reports — the self-review and the doctor-visit pack (docs/reports-subapp.md §6).
 *
 * Pushed from the Data tab's `Reports` row, which is where the standing record
 * lives. **The raw JSON export is deliberately NOT here** (⚑ MATT #4, decided
 * 2026-08-12): the IA already places it in Settings › Security & data, and a
 * row on this screen promising both would either duplicate the action or lie
 * about where it lives. What this screen carries instead is a margin annotation
 * pointing at its real home — a pointer, not a duplicate.
 *
 * ## The distinction this screen exists to hold
 *
 * A **report** is a document assembled for a reader (you, or a physician). An
 * **export** is the entire database as one machine-shaped JSON file. They are
 * not two settings of one feature, and putting them on one row was the thing
 * that made the old "Reports & export" label unreadable.
 *
 * ## Surface system
 *
 * Two ruled plates — Generate, and the history — because both are records, and
 * a record is a table. **The accent budget on this screen is ZERO.** The one
 * accent in the whole flow belongs to "Save & share" on `app/report-view.tsx`,
 * the single action that puts a file on disk and offers it to the world;
 * spending one here on "generate a preview" would compete with it for the
 * meaning the accent is supposed to carry.
 *
 * Every period choice prints its ACTUAL dates before you pick it, so "Last
 * week" is never a guess about which week is meant.
 */

type Mode = 'idle' | 'period';

/** Which report type's flow is open, if any. */
function GenerateRow({
  label,
  description,
  first,
  expanded,
  onPress,
}: {
  label: string;
  description: string;
  first: boolean;
  expanded?: boolean;
  onPress: () => void;
}) {
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${label}. ${description}.`}
        accessibilityState={expanded === undefined ? undefined : { expanded }}
        onPress={onPress}
        className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
        <View className="flex-1">
          <Text className="font-serif text-[15px] text-ink">{label}</Text>
          <Text className="mt-0.5 font-serif text-[12px] leading-4 text-ink-muted">
            {description}
          </Text>
        </View>
        <Ionicons
          name={expanded ? 'chevron-up' : 'chevron-forward'}
          size={16}
          color={palette.inkMuted}
        />
      </Pressable>
    </View>
  );
}

/** One period choice, printing the dates it actually means. */
function PeriodChoice({ period, onPress }: { period: Period; onPress: () => void }) {
  return (
    <View>
      <Divider />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${period.label}, ${period.rangeLabel}`}
        onPress={onPress}
        className="min-h-[44px] flex-row items-center gap-3 py-3 pl-4 active:opacity-60">
        <View className="flex-1">
          <Text className="font-serif text-[14px] text-ink">{period.label}</Text>
          <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">{period.rangeLabel}</Text>
        </View>
        <Ionicons name="chevron-forward" size={15} color={palette.inkMuted} />
      </Pressable>
    </View>
  );
}

export default function ReportsScreen() {
  const router = useRouter();
  const { rows, summaryLine } = useReportsHistory();

  // Frozen at mount: the two presets are derived from it, and a period that
  // silently re-derives between render and tap could push a different week
  // than the one the row printed.
  const [now] = useState(() => new Date());
  const [mode, setMode] = useState<Mode>('idle');
  const [customOpen, setCustomOpen] = useState(false);
  const [customStart, setCustomStart] = useState('');
  const [customEnd, setCustomEnd] = useState('');
  const [customError, setCustomError] = useState<string | null>(null);

  const week = lastCompleteWeek(now);
  const month = lastCalendarMonth(now);

  const openSelfReview = useCallback(() => {
    setMode((prev) => (prev === 'period' ? 'idle' : 'period'));
    setCustomOpen(false);
    setCustomError(null);
  }, []);

  const generate = useCallback(
    (period: Period) => {
      router.push({
        pathname: '/report-view',
        params: {
          kind: 'self_review',
          periodKind: period.kind,
          start: period.start,
          end: period.end,
        },
      });
    },
    [router]
  );

  const generateCustom = useCallback(() => {
    const result = validateCustomRange(customStart.trim(), customEnd.trim(), now);
    if (!result.ok) {
      setCustomError(result.message);
      return;
    }
    setCustomError(null);
    generate(result.period);
  }, [customStart, customEnd, now, generate]);

  return (
    <Screen scroll edges={['top', 'bottom']}>
      <StackHeader title="Reports" parent="Data" />

      {/* a. Generate. Neutral ink throughout — the accent is spent inside the
          flow, on the one action that writes a file. */}
      <View className="mt-6">
        <Block device="plate">
          <SectionLabel label="Generate" />
          <View className="mt-1">
            <GenerateRow
              label="Self-review"
              description="Adherence, training, nutrition and trends over a period"
              first
              expanded={mode === 'period'}
              onPress={openSelfReview}
            />
            {mode === 'period' ? (
              <>
                <PeriodChoice period={week} onPress={() => generate(week)} />
                <PeriodChoice period={month} onPress={() => generate(month)} />
                <View>
                  <Divider />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Custom range"
                    accessibilityState={{ expanded: customOpen }}
                    onPress={() => setCustomOpen((prev) => !prev)}
                    className="min-h-[44px] flex-row items-center gap-3 py-3 pl-4 active:opacity-60">
                    <View className="flex-1">
                      <Text className="font-serif text-[14px] text-ink">Custom range</Text>
                      <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                        up to {MAX_CUSTOM_RANGE_DAYS} days, ending on or before today
                      </Text>
                    </View>
                    <Ionicons
                      name={customOpen ? 'chevron-up' : 'chevron-down'}
                      size={15}
                      color={palette.inkMuted}
                    />
                  </Pressable>
                  {customOpen ? (
                    <View className="pb-3 pl-4">
                      <View className="flex-row gap-3">
                        {/* The field IS the well — a bare input inside a
                            `device="well"` block would be a device nested in a
                            device (src/components/ui/block.tsx). */}
                        <View className="flex-1">
                          <Text className="font-label text-[9.5px] font-semibold uppercase tracking-[1px] text-ink-muted">
                            From
                          </Text>
                          <TextInput
                            value={customStart}
                            onChangeText={setCustomStart}
                            placeholder="2026-07-01"
                            placeholderTextColor={palette.inkMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            accessibilityLabel="Range start date"
                            className="mt-1 min-h-[40px] border border-paper-deep bg-paper-dim px-2.5 py-2 font-mono text-[13px] text-ink"
                          />
                        </View>
                        <View className="flex-1">
                          <Text className="font-label text-[9.5px] font-semibold uppercase tracking-[1px] text-ink-muted">
                            To
                          </Text>
                          <TextInput
                            value={customEnd}
                            onChangeText={setCustomEnd}
                            placeholder="2026-07-31"
                            placeholderTextColor={palette.inkMuted}
                            autoCapitalize="none"
                            autoCorrect={false}
                            accessibilityLabel="Range end date"
                            className="mt-1 min-h-[40px] border border-paper-deep bg-paper-dim px-2.5 py-2 font-mono text-[13px] text-ink"
                          />
                        </View>
                      </View>
                      {customError ? (
                        <Text className="mt-2 font-serif text-[12px] leading-[17px] text-ink-secondary">
                          {customError}
                        </Text>
                      ) : null}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel="Build report for the custom range"
                        onPress={generateCustom}
                        className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 border border-hairline px-4 py-2.5 active:opacity-60">
                        <Text className="font-label text-[13px] font-semibold text-ink">
                          Build this range
                        </Text>
                      </Pressable>
                    </View>
                  ) : null}
                </View>
              </>
            ) : null}
            <GenerateRow
              label="Doctor visit pack"
              description="Labs, current regimen, vitals and screenings, as of today"
              first={false}
              onPress={() => router.push({ pathname: '/report-view', params: { kind: 'doctor_pack' } })}
            />
          </View>
        </Block>
      </View>

      {/* b. The history. A persisted report IS a reading — which is why this row
          earns a place on the Data tab where a second export button would not. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="Generated reports" note={summaryLine} />
          <View className="mt-1">
            {rows.length === 0 ? (
              <View>
                <Divider />
                <Text className="py-3 font-serif text-[13.5px] leading-5 text-ink-secondary">
                  Nothing generated yet. A report is a document — assembled from your data,
                  previewed here, shared as a file.
                </Text>
              </View>
            ) : (
              rows.map((row, index) => (
                <View key={row.id}>
                  <Divider first={index === 0} />
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={`${row.typeLabel}, ${row.subtitle}. Open.`}
                    onPress={() =>
                      router.push({ pathname: '/report-view', params: { id: row.id } })
                    }
                    className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
                    <View className="flex-1">
                      <Text className="font-serif text-[15px] text-ink">{row.typeLabel}</Text>
                      <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                        {row.subtitle}
                      </Text>
                    </View>
                    {row.hasNarrative ? (
                      <Text className="font-label text-[9.5px] uppercase tracking-[1px] text-ink-muted">
                        Coach&apos;s read
                      </Text>
                    ) : null}
                    <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
                  </Pressable>
                </View>
              ))
            )}
          </View>
        </Block>
      </View>

      {/* c. The pointer to export's real home. A margin annotation, not a
          button: this screen does not do that, it says where it is done. */}
      <View className="mt-7">
        <Block device="margin">
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Raw data export lives in Settings, Security and data"
            onPress={() => router.push('/settings')}
            className="min-h-[44px] justify-center active:opacity-60">
            <Text className="font-serif text-[12.5px] leading-[18px] text-ink-secondary">
              Raw data export — everything, as one JSON file — lives in Settings › Security &amp;
              data. A report is a document for a reader; the export is the data itself.
            </Text>
          </Pressable>
        </Block>
      </View>
    </Screen>
  );
}
