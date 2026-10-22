import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { useExperiment } from '@/hooks/use-experiments';
import { shortDate, STATUS_LABELS, windowLabel } from '@/lib/experiments/format';
import type { ExperimentReadout, MetricReadout } from '@/lib/experiments/readout';

/**
 * One n-of-1 experiment in full: the hypothesis, the single intervention, the
 * metrics being watched, its window, and — once concluded — the verdict and
 * readout (migration 0027; docs/ai-coach.md §6).
 *
 * Conformed Set treatment — the **margin annotation** device throughout: every
 * passage here is prose about the experiment (hypothesis, intervention, success
 * criteria, conclusion, readout), and prose is annotated in the margin, not
 * boxed. Only the watched metrics are a list, and they sit as neutral mono
 * chips because a metric key is vendor vocabulary, not a sentence.
 *
 * **Zero accent**, and READ-ONLY: concluding an experiment is the Coach's job
 * (complete_experiment, which reads the watched metrics first and records a
 * verdict). A "Conclude" button here would invite a verdict with no numbers
 * behind it, which is exactly what the Coach doctrine forbids. The status chip
 * is workflow, not biology, so it stays neutral ink.
 *
 * **The readout** (2026-10-21, src/lib/experiments/readout.ts) is the one
 * record on the screen, so it is the one plate: a ruled row per watched metric
 * — baseline mean → intervention mean, the difference, n a side, and whether
 * the engine's two bars were cleared — every figure in mono. It states facts,
 * never a verdict word, and it carries NO signal colour: a gate cleared is a
 * fact about two windows, not a judgment about the body, and whether it
 * answers the hypothesis is the Coach's call. While the experiment runs the
 * numbers are live ("so far"); once concluded they are the snapshot stored
 * with the verdict, never recomputed.
 */

const num = (v: number | null): string => (v === null ? '—' : String(v));
const signed = (v: number | null, suffix = ''): string =>
  v === null ? '—' : `${v > 0 ? '+' : ''}${v}${suffix}`;

/** Nonzero parts only, in ledger order — they sum to `days`. */
function adherenceParts(a: ExperimentReadout['adherence']): string {
  const parts: [number, string][] = [
    [a.done, 'done'],
    [a.partial, 'partial'],
    [a.skipped, 'skipped'],
    [a.untouched, 'untouched'],
    [a.removed, 'removed'],
    [a.noRow, 'not on the day'],
    [a.excused, 'excused'],
    [a.open, 'today, open'],
  ];
  return parts
    .filter(([n]) => n > 0)
    .map(([n, w]) => `${n} ${w}`)
    .join(' · ');
}

const SOURCE_WORDS: Record<string, string> = {
  status: 'status',
  'timezone-change': 'timezone change',
  away: 'away',
};

function gateWords(m: Extract<MetricReadout, { readable: true }>): string {
  if (m.gateMet === null) return 'Too few readings';
  return m.gateMet ? 'Gate met' : 'Gate not met';
}

/** The second measured line: difference, n a side, the test, the bar. */
function statLine(m: Extract<MetricReadout, { readable: true }>): string {
  const change = m.changePct === null ? '' : ` (${signed(m.changePct, '%')})`;
  const test = m.welch ? ` · t ${m.welch.t} vs ${m.welch.critical}` : '';
  return `Δ ${signed(m.diff)}${change} · n ${m.baseline.n} / ${m.intervention.n}${test} · bar ${m.bar.pct}%`;
}

/** One ruled row of the readout plate. */
function MetricRow({ metric, first }: { metric: MetricReadout; first: boolean }) {
  return (
    <View>
      <Divider first={first} />
      <View className="min-h-[44px] py-3">
        {metric.readable ? (
          <>
            <View className="flex-row items-baseline justify-between gap-3">
              <Text className="flex-1 font-serif text-[14px] leading-5 text-ink">
                {metric.label}
              </Text>
              <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-secondary">
                {gateWords(metric)}
              </Text>
            </View>
            <Text className="mt-1 font-mono text-[13px] leading-5 text-ink">
              {`${num(metric.baseline.mean)} → ${num(metric.intervention.mean)} ${metric.unit}`.trim()}
            </Text>
            <Text className="mt-0.5 font-mono text-[11px] leading-4 text-ink-muted">
              {statLine(metric)}
            </Text>
          </>
        ) : (
          <>
            <Text className="font-mono text-[13px] leading-5 text-ink">{metric.metric}</Text>
            <Text className="mt-0.5 font-serif text-[12px] leading-4 text-ink-muted">
              Not a series ARC records — read qualitatively.
            </Text>
          </>
        )}
      </View>
    </View>
  );
}

/** The readout: windows, the per-metric plate, adherence, excluded days, readiness. */
function Readout({ readout, concluded }: { readout: ExperimentReadout; concluded: boolean }) {
  const a = readout.adherence;
  const excludedSources = Object.entries(readout.excludedBy)
    .map(([source, n]) => `${n} ${SOURCE_WORDS[source] ?? source}`)
    .join(' · ');
  return (
    <>
      <View className="mt-7">
        <SectionLabel
          label="Readout"
          note={`${concluded ? 'at conclusion' : 'so far'} · ${shortDate(readout.asOf)}`}
        />
        <Text className="mt-2 font-mono text-[11px] leading-4 text-ink-muted">
          {`Baseline ${windowLabel(readout.baseline.from, readout.baseline.to)} · ${readout.baseline.days} d`}
        </Text>
        <Text className="font-mono text-[11px] leading-4 text-ink-muted">
          {readout.intervention.days === 0
            ? 'Intervention not started'
            : `Intervention ${windowLabel(readout.intervention.from, readout.intervention.to)} · ${readout.intervention.days} d`}
        </Text>
        <View className="mt-3">
          <Block device="plate">
            {readout.metrics.map((metric, index) => (
              <MetricRow key={`${index}-${metric.metric}`} metric={metric} first={index === 0} />
            ))}
          </Block>
        </View>
      </View>

      <View className="mt-7">
        <SectionLabel
          label="Adherence"
          note={
            a.rate === null ? '—' : `${a.done} of ${a.owed} owed · ${Math.round(a.rate * 100)}%`
          }
        />
        <Text className="mt-2 font-mono text-[12px] leading-5 text-ink-secondary">
          {a.days === 0 ? 'No day counted yet.' : `${a.days} d: ${adherenceParts(a)}`}
        </Text>
      </View>

      <View className="mt-7">
        <SectionLabel label="Excluded days" note={String(readout.excludedDates.length)} />
        <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
          {readout.excludedDates.length === 0
            ? 'None — every day in both windows counts.'
            : `Left out of both windows: ${excludedSources}.`}
        </Text>
      </View>

      <View className="mt-7">
        <SectionLabel label={readout.verdictReady ? 'Ready to judge' : 'Before a verdict'} />
        <View className="mt-2">
          <Block device="margin">
            {readout.verdictReady ? (
              <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                The window has closed and the inputs are complete enough to judge. What they mean is
                the Coach’s call.
              </Text>
            ) : (
              readout.notReady.map((reason, index) => (
                <Text
                  key={`${index}-${reason}`}
                  className="font-serif text-[13px] leading-5 text-ink-secondary">
                  {reason}
                </Text>
              ))
            )}
          </Block>
        </View>
      </View>
    </>
  );
}

/** A labelled passage of prose — the margin annotation device. */
function Passage({ label, children }: { label: string; children: string }) {
  return (
    <View className="mt-7">
      <SectionLabel label={label} />
      <View className="mt-2">
        <Block device="margin">
          <Text className="font-serif text-[15px] leading-6 text-ink-secondary">{children}</Text>
        </Block>
      </View>
    </View>
  );
}

export default function ExperimentDetailScreen() {
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;
  const { experiment, readout, notes } = useExperiment(id);

  if (!experiment) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Experiment" />
        </View>
        <Text className="mt-4 font-serif text-[13px] leading-5 text-ink-muted">
          This experiment no longer exists.
        </Text>
      </Screen>
    );
  }

  const concluded = experiment.status !== 'active';

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Experiment" />
      </View>

      <Text className="mt-1 font-serif text-[22px] font-semibold leading-7 text-ink">
        {experiment.title}
      </Text>
      {/* Status and window on one line, unboxed. The status was a bordered
          badge in well stock; a recess says "type into me", and a border around
          one word is decoration. The word beside a mono date is legible as
          status without a stroke around it. */}
      <View className="mt-2 flex-row items-center gap-2">
        <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
          {STATUS_LABELS[experiment.status]}
        </Text>
        {/* A window is a measured value — mono. */}
        <Text className="font-mono text-[11px] text-ink-muted">
          {windowLabel(experiment.start_date, experiment.end_date)}
        </Text>
      </View>

      <Passage label="Hypothesis">{experiment.hypothesis}</Passage>
      <Passage label="Intervention">{experiment.intervention}</Passage>

      <View className="mt-7">
        <SectionLabel
          label="Metrics watched"
          note={experiment.metrics.length > 0 ? String(experiment.metrics.length) : undefined}
        />
        {experiment.metrics.length === 0 ? (
          <Text className="mt-2 font-serif text-[13px] text-ink-muted">None recorded.</Text>
        ) : (
          /* One mono run, middot-separated, rather than a bordered box per
             metric. A metric key is a measured name and reads as one in mono;
             boxing each of six of them drew six little enclosures around single
             words. Joined into a single Text so it wraps as prose does — which
             also sidesteps React keys entirely, and the model is not forced to
             emit unique metric names. */
          <Text className="mt-2 font-mono text-[12px] leading-5 text-ink-secondary">
            {experiment.metrics.join(' · ')}
          </Text>
        )}
      </View>

      {experiment.success_criteria ? (
        <Passage label="Success criteria">{experiment.success_criteria}</Passage>
      ) : null}

      {concluded && experiment.conclusion ? (
        <Passage label="Conclusion">{experiment.conclusion}</Passage>
      ) : null}
      {concluded && notes ? <Passage label="Notes">{notes}</Passage> : null}

      {readout ? <Readout readout={readout} concluded={concluded} /> : null}
      {experiment.status === 'completed' && !readout ? (
        <Text className="mt-7 font-serif text-[13px] leading-5 text-ink-muted">
          No numbers were stored with this verdict.
        </Text>
      ) : null}

      {!concluded ? (
        <View className="mt-8">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              The verdict is recorded when the window closes.
            </Text>
          </Block>
        </View>
      ) : null}
    </Screen>
  );
}
