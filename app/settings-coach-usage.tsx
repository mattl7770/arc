import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Text, View } from 'react-native';

import { Block, Divider, GridCell } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { MODEL_CALL_LABELS } from '@/lib/ai/call-types';
import {
  formatUsd,
  KEEP_DAYS,
  summarizeLedger,
  type SpendSummary,
  type SpendTotals,
} from '@/lib/ai/spend-ledger';
import { readSpendLedger } from '@/lib/ai/spend-store';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';

/**
 * Settings › Coach › Coach usage — what the Coach costs (2026-10-21, Track 0
 * item 2; docs/ai-coach.md "The spend ledger").
 *
 * Named for the COACH'S USAGE rather than "Spend", because it is the screen
 * that will also hold how much the Coach is allowed to do: the owner asked
 * (2026-10-21) for the usage-level setting — Lean / Standard / Generous, from
 * the usage policy (docs/spikes/chief-of-staff-release.md, Track 1) — to live
 * HERE, above the figures it moves.
 *
 * ## The seam the usage policy drops into
 *
 * {@link UsageLevelSection} is the first section on the screen and renders
 * nothing today. The usage-policy branch replaces its body with its own plate
 * (a SectionLabel "Usage level" and a ruled plate of levels, like the model
 * picker in Settings › Coach) and nothing else here moves: the spend figures
 * below are their own section with their own top margin, already separated
 * from whatever sits above them. Its soft daily budget reads the same ledger
 * this screen does (`spentToday`, src/lib/ai/spend-ledger.ts).
 *
 * ## What the figures are
 *
 * ESTIMATES, and labelled so everywhere: the app's own price table
 * (src/lib/ai/cost.ts) applied to the usage Anthropic reported for each call.
 * Not the invoice. Today, the last seven days and this month, then this month
 * by call type. A call whose model has no price is counted and said to be
 * unpriced, never given a guessed figure.
 *
 * Conformed Set: the three totals are a metric GRID (rules between cells, no
 * box), the by-type breakdown is a ruled PLATE (it is a ledger), the caveat is
 * MARGIN prose. Zero accent — Settings spends none.
 */

/** The usage-level picker's place — empty until the usage policy lands (see above). */
function UsageLevelSection() {
  return null;
}

function read(): SpendSummary {
  return summarizeLedger(readSpendLedger(getDb()), todayISODate());
}

/** "3 calls", "1 call" — the count beside a figure, so $0.00 is legible as "nothing ran". */
function callsLine(totals: SpendTotals): string {
  return `${totals.calls} call${totals.calls === 1 ? '' : 's'}`;
}

/** "12.4k tokens" — every token kind together, for scale only. */
function tokensLine(totals: SpendTotals): string {
  const sum =
    totals.inputTokens + totals.outputTokens + totals.cacheReadTokens + totals.cacheWriteTokens;
  return sum >= 1_000_000
    ? `${(sum / 1_000_000).toFixed(1)}M tokens`
    : sum >= 1000
      ? `${(sum / 1000).toFixed(1)}k tokens`
      : `${sum} tokens`;
}

function TotalCell({ label, totals }: { label: string; totals: SpendTotals }) {
  return (
    <>
      <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        {label}
      </Text>
      <Text className="mt-1 font-mono text-lg font-semibold text-ink">{formatUsd(totals.usd)}</Text>
      <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">{callsLine(totals)}</Text>
    </>
  );
}

/** "21 Oct" from `2026-10-21` — componentwise, never `new Date('YYYY-MM-DD')`. */
function shortDay(day: string): string {
  const [, m, d] = day.split('-').map(Number) as [number, number, number];
  const MONTHS = [
    'Jan',
    'Feb',
    'Mar',
    'Apr',
    'May',
    'Jun',
    'Jul',
    'Aug',
    'Sep',
    'Oct',
    'Nov',
    'Dec',
  ];
  return `${d} ${MONTHS[m - 1] ?? ''}`.trim();
}

export default function SettingsCoachUsageScreen() {
  const [summary, setSummary] = useState<SpendSummary>(read);
  // Re-read on focus: a turn finished elsewhere has spent since this was drawn.
  useFocusEffect(useCallback(() => setSummary(read()), []));

  const totals: { label: string; totals: SpendTotals }[] = [
    { label: 'Today', totals: summary.today },
    { label: 'Last 7 days', totals: summary.last7 },
    { label: 'This month', totals: summary.month },
  ];
  const unpriced = summary.month.unpriced;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Coach usage" />
      </View>

      <UsageLevelSection />

      {/* Spend — what the calls have cost, estimated. Its own section with its
          own top margin, so a section above it changes nothing here. */}
      <View className="mt-6">
        <SectionLabel label="Spend" note="est." />
        <View className="mt-2 flex-row flex-wrap">
          {totals.map((cell, index) => (
            <GridCell key={cell.label} index={index} count={totals.length} columns={3}>
              <TotalCell label={cell.label} totals={cell.totals} />
            </GridCell>
          ))}
        </View>
      </View>

      <View className="mt-8">
        <SectionLabel label="This month, by call type" note="est." />
        <View className="mt-3">
          <Block device="plate">
            {summary.monthByType.length === 0 ? (
              <Text className="py-3 font-serif text-[14px] leading-6 text-ink-secondary">
                No model calls recorded this month yet.
              </Text>
            ) : (
              summary.monthByType.map(({ type, totals: t }, index) => (
                <View key={type}>
                  <Divider first={index === 0} />
                  <View
                    accessible
                    accessibilityLabel={`${MODEL_CALL_LABELS[type]}: ${formatUsd(t.usd)} estimated, ${callsLine(t)}`}
                    className="min-h-[44px] flex-row items-center gap-3 py-3">
                    <View className="flex-1">
                      <Text className="font-serif text-[15px] text-ink">
                        {MODEL_CALL_LABELS[type]}
                      </Text>
                      <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                        {[
                          callsLine(t),
                          tokensLine(t),
                          t.webSearches > 0
                            ? `${t.webSearches} search${t.webSearches === 1 ? '' : 'es'}`
                            : null,
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </Text>
                    </View>
                    <Text className="font-mono text-[15px] text-ink">{formatUsd(t.usd)}</Text>
                  </View>
                </View>
              ))
            )}
          </Block>
        </View>
      </View>

      <View className="mt-4">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            {`Estimates: ARC’s own price table applied to the usage Anthropic reported for each call — not your invoice. ${
              summary.firstDay
                ? `Recorded since ${shortDay(summary.firstDay)}; the last ${KEEP_DAYS} days are kept.`
                : `Recording starts with the next call; the last ${KEEP_DAYS} days are kept.`
            }${
              unpriced > 0
                ? ` ${unpriced} call${unpriced === 1 ? '' : 's'} this month ran on a model with no price in the table, and ${unpriced === 1 ? 'is' : 'are'} in no figure.`
                : ''
            }`}
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
