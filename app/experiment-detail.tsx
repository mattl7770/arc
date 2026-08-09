import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { useExperiment } from '@/hooks/use-experiments';
import { STATUS_LABELS, windowLabel } from '@/lib/experiments/format';

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
 */

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
  const { experiment } = useExperiment(id);

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
      <View className="mt-2 flex-row items-center gap-2">
        <View className="border border-paper-deep bg-paper-dim px-2 py-0.5">
          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            {STATUS_LABELS[experiment.status]}
          </Text>
        </View>
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
          <View className="mt-2 flex-row flex-wrap gap-2">
            {/* Keyed by index too: the model isn't forced to emit unique metric
                names, and duplicate React keys would warn/misrender. */}
            {experiment.metrics.map((m, i) => (
              <View key={`${m}-${i}`} className="border border-paper-deep bg-paper-dim px-2 py-1">
                <Text className="font-mono text-[11px] text-ink-secondary">{m}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {experiment.success_criteria ? (
        <Passage label="Success criteria">{experiment.success_criteria}</Passage>
      ) : null}

      {concluded && experiment.conclusion ? (
        <Passage label="Conclusion">{experiment.conclusion}</Passage>
      ) : null}
      {concluded && experiment.outcome_notes ? (
        <Passage label="Readout">{experiment.outcome_notes}</Passage>
      ) : null}

      {!concluded ? (
        <View className="mt-8">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              The Coach reads the watched metrics and records the verdict when the window closes —
              ask it for the readout.
            </Text>
          </Block>
        </View>
      ) : null}
    </Screen>
  );
}
