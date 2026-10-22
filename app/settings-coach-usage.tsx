import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider, GridCell } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { MODEL_CALL_LABELS } from '@/lib/ai/call-types';
import { COACH_MODELS } from '@/lib/ai/model-client';
import {
  formatUsd,
  KEEP_DAYS,
  summarizeLedger,
  type SpendSummary,
  type SpendTotals,
} from '@/lib/ai/spend-ledger';
import { readSpendLedger } from '@/lib/ai/spend-store';
import {
  activeUsageResolution,
  DAILY_BUDGET_CHOICES,
  passModelFor,
  USAGE_LEVEL_LABELS,
  USAGE_LEVELS,
  type UsageLevel,
  type UsageResolution,
} from '@/lib/ai/usage-policy';
import { saveDailyBudget, saveUsageLevel } from '@/lib/ai/usage-policy-store';
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
 * ## The usage level (2026-10-21, src/lib/ai/usage-policy.ts)
 *
 * {@link UsageLevelSection} is the first section on the screen: Lean /
 * Standard / Generous as a ruled plate (the model picker's shape), the chosen
 * level's soft daily budget, and one margin line saying what is running now
 * and why, with the models the level resolves to. Nothing below it moved: the
 * spend figures are their own section with their own top margin. The budget
 * reads the same ledger this screen does (`spentToday`,
 * src/lib/ai/spend-ledger.ts). The model PICKS stay in Settings › Coach (that
 * screen's header says why); this line names them and points there.
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

/** One line per level: what it changes, in the owner's terms. */
const LEVEL_NOTES: Readonly<Record<UsageLevel, string>> = {
  lean: 'Sonnet 5 · the pass on Haiku 4.5 · the limits ARC started with',
  standard: 'Sonnet 5.5 throughout · the pass reads like the chat · wider limits',
  generous: 'Opus 5.5 chat · Sonnet 5.5 one-shot calls · the widest limits',
};

function modelLabel(id: string): string {
  return COACH_MODELS.find((m) => m.id === id)?.label ?? id;
}

function budgetLabel(usd: number | null): string {
  return usd === null ? 'Off' : formatUsd(usd);
}

/** The one plain line under the levels: what is running now, and why. */
function statusLine(usage: UsageResolution): string {
  const chosen = USAGE_LEVEL_LABELS[usage.chosen];
  switch (usage.why) {
    case 'unreadable':
      return 'The usage setting could not be read, so the Coach is running Lean — the lowest level — until it can.';
    case 'budget':
      return `Today’s estimate (${formatUsd(usage.spentTodayUsd ?? 0)}) has reached the ${formatUsd(
        usage.budgetUsd ?? 0
      )} soft budget, so the rest of today runs Lean. ${chosen} again tomorrow.`;
    default: {
      const level =
        usage.why === 'default' ? `${chosen}, the default` : `${chosen}, until you switch it`;
      const budget =
        usage.budgetUsd === null
          ? usage.chosen === 'lean'
            ? ''
            : ' No soft budget.'
          : ` Today ${formatUsd(usage.spentTodayUsd ?? 0)} of a ${formatUsd(usage.budgetUsd)} soft budget.`;
      return `Running ${level}.${budget}`;
    }
  }
}

/**
 * The usage level (2026-10-21; src/lib/ai/usage-policy.ts): Lean / Standard /
 * Generous as a ruled plate, the chosen level's soft daily budget as a row of
 * choices, and one plain line saying what is running now and why — the level,
 * a budget that has tipped the day to Lean, or a setting that could not be read.
 * There is no end date: the level stays until he switches it.
 */
function UsageLevelSection({
  usage,
  onLevel,
  onBudget,
}: {
  usage: UsageResolution;
  onLevel: (level: UsageLevel) => void;
  onBudget: (usd: number | null) => void;
}) {
  const chatPick = apiKeyStore.getChatPick();
  const utilityPick = apiKeyStore.getUtilityPick();
  const chat = chatPick ?? usage.policy.chatModel;
  const utility = utilityPick ?? usage.policy.utilityModel ?? chat;
  const pass = passModelFor(usage.policy, chat);
  return (
    <View className="mt-6">
      <SectionLabel label="Usage level" />
      <View className="mt-3">
        <Block device="plate">
          {USAGE_LEVELS.map((level, index) => {
            const on = level === usage.chosen;
            return (
              <View key={level}>
                <Divider first={index === 0} />
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${USAGE_LEVEL_LABELS[level]}. ${LEVEL_NOTES[level]}.`}
                  onPress={() => onLevel(level)}
                  className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
                  {/* Square, ink, no accent — the model picker's mark. */}
                  <View
                    className={`h-4 w-4 items-center justify-center border ${
                      on ? 'border-ink' : 'border-hairline'
                    }`}>
                    {on ? <View className="h-2 w-2 bg-ink" /> : null}
                  </View>
                  <View className="flex-1">
                    <Text
                      className={`font-serif text-[15px] ${on ? 'text-ink' : 'text-ink-secondary'}`}>
                      {USAGE_LEVEL_LABELS[level]}
                    </Text>
                    <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                      {LEVEL_NOTES[level]}
                    </Text>
                  </View>
                </Pressable>
              </View>
            );
          })}
          {usage.chosen !== 'lean' && usage.why !== 'unreadable' ? (
            <>
              <Divider />
              <View className="py-3">
                <Text className="font-serif text-[15px] text-ink">Soft daily budget</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  Past it, the rest of the day runs Lean
                </Text>
                <View className="mt-2 flex-row flex-wrap gap-2">
                  {DAILY_BUDGET_CHOICES.map((usd) => {
                    const on = usd === usage.budgetUsd;
                    return (
                      <Pressable
                        key={usd ?? 'off'}
                        accessibilityRole="button"
                        accessibilityState={{ selected: on }}
                        accessibilityLabel={`Soft daily budget: ${budgetLabel(usd)}`}
                        onPress={() => onBudget(usd)}
                        className={`min-h-[32px] items-center justify-center rounded-btn border px-3 ${
                          on ? 'border-ink bg-ink' : 'border-hairline active:bg-paper-dim'
                        }`}>
                        <Text
                          className={`font-mono text-[12px] ${on ? 'text-paper-hi' : 'text-ink'}`}>
                          {budgetLabel(usd)}
                        </Text>
                      </Pressable>
                    );
                  })}
                </View>
              </View>
            </>
          ) : null}
        </Block>
      </View>
      <View className="mt-4">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            {`${statusLine(usage)} Chat ${modelLabel(chat)}${chatPick ? ' (your pick)' : ''}, one-shot calls ${modelLabel(utility)}${utilityPick ? ' (your pick)' : ''}, the daily pass ${modelLabel(pass)}. A model you pick in Settings › Coach always wins over the level.`}
          </Text>
        </Block>
      </View>
    </View>
  );
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
  // What runs now — the same read every module makes (activeUsagePolicy), so
  // this screen can never say one level while the Coach runs another.
  const [usage, setUsage] = useState<UsageResolution>(activeUsageResolution);
  // Re-read on focus: a turn finished elsewhere has spent since this was drawn,
  // and may have carried today past the soft budget.
  useFocusEffect(
    useCallback(() => {
      setSummary(read());
      setUsage(activeUsageResolution());
    }, [])
  );
  const chooseLevel = useCallback((level: UsageLevel) => {
    try {
      saveUsageLevel(getDb(), level);
    } catch (error) {
      console.warn('[usage] could not save the level', error);
    }
    setUsage(activeUsageResolution());
  }, []);
  const chooseBudget = useCallback(
    (usd: number | null) => {
      try {
        saveDailyBudget(getDb(), usage.chosen, usd);
      } catch (error) {
        console.warn('[usage] could not save the budget', error);
      }
      setUsage(activeUsageResolution());
    },
    [usage.chosen]
  );

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

      <UsageLevelSection usage={usage} onLevel={chooseLevel} onBudget={chooseBudget} />

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
