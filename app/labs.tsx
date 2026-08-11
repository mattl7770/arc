import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
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
 *
 * ## The surface system
 *
 * Every block here is a **ruled plate** — this screen is nothing but records,
 * and a record is a table (src/components/ui/block.tsx). Each plate carries its
 * own section label, so sections are separated by whitespace rather than by
 * page-wide rules.
 *
 * **The accent budget is one:** the import action, which is the only thing on
 * the screen that writes anything. The reference rows are a reading surface and
 * stay in ink.
 *
 * ## Tallies that reconcile
 *
 * Each section note states what its plate is responsible for and nothing else:
 * the Imported note sums the `results` counts of the report rows beneath it,
 * and each category note counts the measured markers among the rows drawn
 * directly below. Every row of every group is rendered — nothing is folded —
 * so neither number can drift from what is visible. A marker with no reading is
 * an em-dash, never a stand-in figure.
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

/** "2026-07-14" → "14 Jul 2026", without pulling in a date library (and without
 * Intl, which Hermes does not ship). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDate(iso: string): string {
  const [y, m, d] = iso.split('-');
  const month = MONTHS[Number(m) - 1];
  return month ? `${Number(d)} ${month} ${y}` : iso;
}

/** The measured-marker tally a category plate is responsible for. */
function measuredNote(items: BiomarkerRange[]): string {
  const measured = items.filter((b) => b.latestValue != null).length;
  return measured === 0 ? 'No readings yet' : `${measured} of ${items.length} measured`;
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

  // Sums the visible rows — a ledger has to add up to its own total.
  const totalResults = reports.reduce((sum, r) => sum + r.resultCount, 0);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Labs" />
      </View>

      {/* The one accent on the screen: the only action here that writes. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Import a lab report"
        onPress={() => router.push('/lab-import')}
        className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine px-4 py-3 active:opacity-70">
        <Ionicons name="document-text-outline" size={18} color={palette.pineOn} />
        <Text className="font-label text-[15px] font-semibold text-pine-on">Import a report</Text>
      </Pressable>

      {reports.length > 0 ? (
        <View className="mt-7">
          <Block device="plate">
            <SectionLabel label="Imported" note={`${totalResults} results`} />
            <View className="mt-1">
              {reports.map((report, index) => (
                <View key={report.id}>
                  <Divider first={index === 0} />
                  <View className="flex-row items-center gap-3 py-3">
                    <View className="flex-1">
                      <Text className="font-mono text-[13px] text-ink">
                        {fmtDate(report.collectedAt)}
                      </Text>
                      {report.labName ? (
                        <Text className="mt-0.5 font-serif text-[11px] text-ink-muted">
                          {report.labName}
                        </Text>
                      ) : null}
                    </View>
                    <Text className="font-mono text-[11px] text-ink-muted">
                      {report.resultCount} results
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          </Block>
        </View>
      ) : null}

      {groups.map((group, groupIndex) => (
        <View key={group.category} className={groupIndex === 0 ? 'mt-5' : 'mt-7'}>
          <Block device="plate">
            <SectionLabel
              label={CATEGORY_LABELS[group.category] ?? group.category}
              note={measuredNote(group.items)}
            />
            <View className="mt-1">
              {group.items.map((b, index) => (
                <View key={b.slug}>
                  <Divider first={index === 0} />
                  <View
                    accessible
                    accessibilityLabel={`${b.name}. Optimal ${rangeText(b)}. ${
                      b.latestValue != null
                        ? `${fmtNum(b.latestValue)} ${b.unit ?? ''}`
                        : 'No reading yet'
                    }.`}
                    className="flex-row items-center gap-3 py-3">
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
                      // No data, no number.
                      <Text className="font-mono text-[15px] text-ink-muted">—</Text>
                    )}
                  </View>
                </View>
              ))}
            </View>
          </Block>
        </View>
      ))}
    </Screen>
  );
}
