import { useState } from 'react';
import { Text, View } from 'react-native';

import { MockupNote } from '@/components/ui/mockup-note';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { fmtNum, rangeText } from '@/lib/biomarkers/format';
import { getDb } from '@/lib/db/client';
import type { BiomarkerRange } from '@/lib/db/repositories/biomarkers';
import { listBiomarkerRanges } from '@/lib/db/repositories/biomarkers';

/**
 * Labs — the full reference file, pushed from the Data tab.
 *
 * Lists the biomarker catalogue grouped by category (the longevity-optimal
 * ranges ARC ships with, seeded on first run — src/lib/db/seed.ts). Each marker
 * shows its optimal range and its latest reading, or "No reading yet" until a
 * lab is imported. The Function Health PDF import and on-device parsing land
 * with the ingestion pipeline (Phase 3), so there is no pine import action here
 * yet — this screen is the reference these results will be graded against.
 *
 * Reference ranges are static app-shipped data, so a one-time read in the
 * `useState` initializer is enough — nothing on device writes them today.
 */

const CATEGORY_LABELS: Record<string, string> = {
  cardiovascular: 'Cardiovascular',
  metabolic: 'Metabolic',
  inflammation: 'Inflammation',
  nutrient: 'Nutrients',
  hematology: 'Hematology',
  hormone: 'Hormones',
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

export default function LabsScreen() {
  const [groups] = useState<Group[]>(() => groupByCategory(listBiomarkerRanges(getDb())));

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Labs" />
      </View>

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

      <MockupNote>
        Importing a Function Health PDF — parsed into these biomarkers on-device — arrives with the
        ingestion pipeline (Phase 3). These are the longevity-optimal reference ranges ARC will
        grade your results against.
      </MockupNote>
    </Screen>
  );
}
