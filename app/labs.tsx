import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { fmtNum, optimalRangeText } from '@/lib/biomarkers/format';
import { getDb } from '@/lib/db/client';
import type { BiomarkerRange } from '@/lib/db/repositories/biomarkers';
import { listBiomarkerRanges } from '@/lib/db/repositories/biomarkers';
import { listLabReports } from '@/lib/db/repositories/labs';
import type { LabReportSummary } from '@/lib/labs/types';

/**
 * Labs — the whole bloodwork file, pushed from the Data tab.
 *
 * The import stamp, then the reports that have been imported, then the
 * biomarker catalogue grouped by category (the longevity-optimal ranges ARC
 * ships with, seeded on first run — src/lib/labs/catalog.ts), each marker
 * showing its optimal range and its latest reading. "Import a report" runs the
 * PDF pipeline (docs/labs-subapp.md); imported reports are listed beneath it,
 * newest draw first.
 *
 * Both reads run on focus rather than once: an import performed on the pushed
 * screen must be visible the moment the user comes back here.
 *
 * ## This is the only place bloodwork lives (owner call, 2026-08-11)
 *
 * Off hardware: *"The big 'bring in your bloodwork' on the top of the data page
 * should be within the labs & reports section. Furthermore, the 'biomarkers'
 * should also be within the labs & reports only."*
 *
 * app/(tabs)/data.tsx had been drawing its own accent import card AND its own
 * flat 65-row `Biomarkers` fold — a second copy of everything on this screen, in
 * a different treatment, with nothing on either sheet to tell the reader which
 * one was the real file. Both came off the tab. The marker rows were already
 * here, and in better shape than that flat list ever gave them: grouped by
 * category, tallied per group, and sitting beside the reports they came out of.
 * The stamp moved here verbatim — cap and all — and now heads the screen.
 *
 * **The header names its parent.** `parent="Data"` — this screen is pushed from
 * exactly one place, the "Labs" row of Data's "The full file", so the back
 * control can say where it goes rather than only that it goes back
 * (src/components/ui/stack-header.tsx). That row and this title now read the
 * same word: the row said "Labs & reports" against a screen titled "Labs", and
 * "& reports" named only the imported-PDF list, which is one of the three things
 * on this sheet. "Labs" is also what the route, the filename and
 * docs/information-architecture.md have always called this domain.
 *
 * ## The surface system
 *
 * The import card is a **stamped plate** — the one thing on the sheet asking to
 * be acted on. Everything under it is a **ruled plate**: this screen is records,
 * and a record is a table (src/components/ui/block.tsx). Each plate carries its
 * own section label, so sections are separated by whitespace rather than by
 * page-wide rules.
 *
 * The single exception is the `Biomarkers` heading, which is a label on bare
 * sheet with no device under it — because the object it names is the *run* of
 * category plates, and giving a heading a device of its own would wrap a block
 * around blocks.
 *
 * **The accent budget is one, and the stamp spends it** — it is the only thing
 * here that writes anything. Nothing else on this screen is drawn in the accent
 * and nothing else on it is directive; the reference rows are a reading surface
 * and stay in ink.
 *
 * ## Tallies that reconcile
 *
 * Each section note states what its plate is responsible for and nothing else:
 * the Imported note sums the `results` counts of the report rows beneath it,
 * and each category note counts the measured markers among the rows drawn
 * directly below. Every row of every group is rendered — nothing is folded —
 * so neither number can drift from what is visible.
 *
 * Over the top of them sits **one** roll-up, the `Biomarkers` heading's note,
 * which is the catalogue's grand total and the figure that came closest to being
 * lost when the marker list moved here from the Data tab: spread across ten
 * category headers, nothing on the sheet said the catalogue holds 65 markers
 * waiting on an import. It sums the same `groups` the plates render, so it and
 * they add up to each other by construction. See {@link catalogueNote}.
 *
 * ## The two copy rules, applied here too
 *
 * Both landed on app/(tabs)/data.tsx first and this screen was left as the
 * untouched twin, which is exactly the drift that produced the duplication the
 * owner called out above. They are now the same in both places — or rather, in
 * the one place that is left.
 *
 * A marker with no reading says **"No reading yet"** in the mono voice, never an
 * em-dash: "empty is authored, never blank" (00-design-spec.md §5), and the
 * sheet names that exact string (`.cf-brow-val`). §5's other rule — no data, no
 * number — is kept either way, since the row prints no figure in either version;
 * the em-dash simply made the reader decode a mark where four words say the same
 * thing and also say that nothing is broken.
 *
 * The range reads **"optimal < 80 mg/dL"** via `optimalRangeText`, not a bare
 * bound: ARC's bounds are longevity-optimal rather than the lab's reference
 * interval — usually the tighter figure — and an unqualified `< 80` reads as a
 * flag where there is none. The spoken label is handed the SAME string rather
 * than a hand-built "Optimal …", which is why that word disappeared from the
 * template below; leaving it in place would have made VoiceOver say "Optimal
 * optimal < 80 mg/dL".
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

/**
 * The catalogue's grand total — the one roll-up over every category plate.
 *
 * The Data tab's flat `Biomarkers` fold carried `0 of 65 measured`, and its own
 * comment argued the point that survives the move: a section has to say how much
 * it is holding, and "no readings yet" hides that there are 65 rows in there.
 * Split across ten category headers, the figure vanished — nothing on this
 * screen told a reader with no imports that the catalogue holds anything at all.
 *
 * **Always the full ratio**, never the `No readings yet` its per-category
 * counterpart falls back to. At category scale that fallback costs nothing,
 * because every row of every group is rendered and the count is right there to
 * be seen; the whole-catalogue figure is the one number on the sheet that no
 * amount of scrolling adds up for you, so it is stated as a ratio in both
 * states.
 *
 * Summed from the same `groups` the plates below render, so the roll-up and the
 * per-plate notes cannot drift — a ledger has to add up to its own total
 * (00-design-spec.md §5).
 */
function catalogueNote(groups: Group[]): string {
  let measured = 0;
  let total = 0;
  for (const group of groups) {
    total += group.items.length;
    measured += group.items.filter((b) => b.latestValue != null).length;
  }
  return `${measured} of ${total} measured`;
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
        <StackHeader title="Labs" parent="Data" />
      </View>

      {/* THE ONE ACCENT — the stamped plate, moved here from the Data tab on
          2026-08-11 (see the header). Nothing else on this screen is drawn in
          the accent, and nothing else on it is directive: everything below is a
          ruled plate of readings, in ink.

          `cap` draws the hatched band over the stamp's top edge — the sheet's
          `.cf-card--accent::before`, and the loudest drafting mark in the whole
          set. It is opt-in on `Block` because the sheet is opt-in about it
          (`.cf-hero` carries the same 1.5px accent border and no cap at all),
          and this card is one of the three the sheet caps. Without it the one
          accent surface on this screen is a card with a coloured edge; with it,
          the sheet has been stamped.

          The eyebrow is "New report", not the "Labs" it carried on the Data tab.
          There it named the domain, which was the one thing that screen did not
          otherwise say; here the sheet is titled Labs, so the same word would
          have been the title read twice. The house eyebrow is a kind-tag rather
          than a domain name anyway — "Do this next", "Proposed change · needs
          your OK" — and "New report" is what this card produces, true whether
          the file below is empty or full. */}
      <View className="mt-5">
        <Block device="stamp" cap>
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
            New report
          </Text>
          <Text className="mt-2 font-serif text-[19px] font-semibold leading-6 text-ink">
            Bring in your bloodwork
          </Text>
          {/* The number came off (2026-08-11). This line read "→ 160+
              biomarkers, parsed on-device", which conflated two different
              counts and matched neither source in the repo: 160+ is a claim
              about the size of a Function Health panel (CLAUDE.md §7 says 160+,
              src/lib/labs/catalog.ts says ~100-135 — the repo does not agree
              with itself), while what ARC actually ships is 65 markers with
              longevity-optimal ranges. Printed on the import card the figure
              read as a promise about the parse.

              So the panel figure is dropped rather than picked — an unverifiable
              number stated in the app is worse than no number — and the count
              ARC can stand behind is now the catalogue roll-up below, stated
              once, as a measurement. What is left here is true of every import
              regardless of panel size. */}
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            Function Health PDF, parsed on-device. Review every row before anything is saved; the
            markers ARC carries an optimal range for are graded against it.
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

      {/* The catalogue's own heading, and the only place its grand total is
          stated. It sits on the sheet rather than inside a device: the ten
          category plates below ARE the block it names, and a plate wrapped round
          a heading for other plates would nest devices, which this design
          forbids outright (src/components/ui/block.tsx). A bare label on the
          sheet is the established way to head a run that is not itself one
          object — app/capture.tsx does the same over its field stack.

          It also gives the run a name. Before this the reader went from
          "Imported" straight to "Cardiovascular", with nothing saying the ten
          plates are one catalogue. */}
      {groups.length > 0 ? (
        <View className="mt-7">
          <SectionLabel label="Biomarkers" note={catalogueNote(groups)} />
        </View>
      ) : null}

      {/* The first plate sits tight under that heading — it belongs to it. The
          rest keep the full section gap from each other. */}
      {groups.map((group, groupIndex) => (
        <View key={group.category} className={groupIndex === 0 ? 'mt-3' : 'mt-7'}>
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
                    accessibilityLabel={`${b.name}. ${optimalRangeText(b)}. ${
                      b.latestValue != null
                        ? `${fmtNum(b.latestValue)} ${b.unit ?? ''}`
                        : 'No reading yet'
                    }.`}
                    className="flex-row items-center gap-3 py-3">
                    <View className="flex-1">
                      <Text className="font-serif text-[15px] text-ink">{b.name}</Text>
                      {/* "optimal < 80 mg/dL", the way the sheet prints it
                          (`.cf-brow-range`) — and the identical string is handed
                          to the spoken label above, which is why the hand-written
                          "Optimal " came off it. See the header. */}
                      <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                        {optimalRangeText(b)}
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
                      // AUTHORED, not an em-dash — see the header. Smaller and
                      // muted, per the sheet: a sentence sitting where a figure
                      // goes must not be mistaken for the figure, and at the
                      // reading's own 15px it would outrun the row on a narrow
                      // phone.
                      <Text className="font-mono text-[11px] text-ink-muted">No reading yet</Text>
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
