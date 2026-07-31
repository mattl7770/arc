import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { fmtNum, rangeText } from '@/lib/biomarkers/format';
import { getDb } from '@/lib/db/client';
import type { BiomarkerRange } from '@/lib/db/repositories/biomarkers';
import { listBiomarkerRanges } from '@/lib/db/repositories/biomarkers';
import { listLabReports } from '@/lib/db/repositories/labs';
import type { LabReportSummary } from '@/lib/labs/types';

/**
 * Labs — the full reference file, pushed from the Data tab.
 *
 * Lists the biomarker catalogue grouped by category (the longevity-optimal
 * ranges ARC ships with, seeded on first run — src/lib/labs/catalog.ts), each
 * marker showing its optimal range and its latest reading. "Import a report"
 * runs the PDF pipeline (docs/labs-subapp.md); imported reports are listed
 * beneath it, newest draw first.
 *
 * Both reads run on focus rather than once: an import performed on the pushed
 * screen must be visible the moment the user comes back here.
 */

const CATEGORY_LABELS: Record<string, string> = {
  cardiovascular: 'Cardiovascular',
  metabolic: 'Metabolic',
  inflammation: 'Inflammation',
  nutrient: 'Nutrients',
  hematology: 'Hematology',
  hormone: 'Hormones',
  organ: 'Organ function',
  immune: 'Immune',
  cancer: 'Cancer signals',
  toxin: 'Toxins',
  microbiome: 'Microbiome',
  biological_age: 'Biological age',
  other: 'Other',
};

type Group = { category: string; items: BiomarkerRange[] };

/**
 * Fold the already-category-ordered list into contiguous groups. Rows arrive
 * grouped by category priority then name (listBiomarkerRanges), so consecutive
 * rows of one category are always adjacent — no re-sorting needed.
 */
function groupByCategory(ranges: BiomarkerRange[]): Group[] {
  const groups: Group[] = [];
  for (const b of ranges) {
    const last = groups[groups.length - 1];
    if (last && last.category === b.category) last.items.push(b);
    else groups.push({ category: b.category, items: [b] });
  }
  return groups;
}

/** "2026-07-14" → "14 Jul 2026", without pulling in a date library. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const month = MONTHS[Number(m) - 1];
  return month ? `${Number(d)} ${month} ${y}` : iso;
}

export default function LabsScreen() {
  const router = useRouter();
  const [groups, setGroups] = useState<Group[]>([]);
  const [reports, setReports] = useState<LabReportSummary[]>([]);

  useFocusEffect(
    useCallback(() => {
      const db = getDb();
      setGroups(groupByCategory(listBiomarkerRanges(db)));
      setReports(listLabReports(db));
    }, [])
  );

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Labs" />
      </View>

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Import a lab report"
        onPress={() => router.push('/lab-import')}
        className="mt-4 h-12 flex-row items-center justify-center gap-2 rounded-btn bg-pine active:opacity-70">
        <Ionicons name="document-text-outline" size={18} color={palette.pineOn} />
        <Text className="text-[15px] font-semibold text-pine-on">Import a report</Text>
      </Pressable>

      {reports.length > 0 ? (
        <View className="mt-6">
          <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
            Imported
          </Text>
          <View className="mt-3 rounded-card border border-hairline bg-porcelain">
            {reports.map((report, index) => (
              <View
                key={report.id}
                className={`flex-row items-center gap-3 px-4 py-3 ${
                  index === 0 ? '' : 'border-t border-hairline-soft'
                }`}>
                <View className="flex-1">
                  <Text className="font-mono text-[13px] text-ink">
                    {fmtDate(report.collectedAt)}
                  </Text>
                  {report.labName ? (
                    <Text className="mt-0.5 text-[11px] text-ink-muted">{report.labName}</Text>
                  ) : null}
                </View>
                <Text className="font-mono text-[11px] text-ink-muted">
                  {report.resultCount} results
                </Text>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {groups.map((group, groupIndex) => (
        <View key={group.category} className={groupIndex === 0 ? 'mt-4' : 'mt-8'}>
          <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
            {CATEGORY_LABELS[group.category] ?? group.category}
          </Text>
          <View className="mt-3 rounded-card border border-hairline bg-porcelain">
            {group.items.map((b, index) => (
              <View
                key={b.slug}
                className={`flex-row items-center gap-3 px-4 py-3 ${
                  index === 0 ? '' : 'border-t border-hairline-soft'
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
                  <Text className="text-[12px] text-ink-muted">No reading yet</Text>
                )}
              </View>
            ))}
          </View>
        </View>
      ))}
    </Screen>
  );
}
