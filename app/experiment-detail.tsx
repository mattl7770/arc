import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { useExperiment } from '@/hooks/use-experiments';
import { STATUS_LABELS, windowLabel } from '@/lib/experiments/format';

/**
 * One n-of-1 experiment in full: the hypothesis, the single intervention, the
 * metrics being watched, its window, and — once concluded — the verdict and
 * readout (migration 0027; docs/ai-coach.md §6).
 *
 * READ-ONLY, so zero pine: concluding an experiment is the Coach's job
 * (complete_experiment, which reads the watched metrics first and records a
 * verdict). A "Conclude" button here would invite a verdict with no numbers
 * behind it, which is exactly what the Coach doctrine forbids.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

function Block({ label, children }: { label: string; children: string }) {
  return (
    <View className="mt-6">
      <SectionLabel>{label}</SectionLabel>
      <Text className="mt-2 text-[15px] leading-6 text-ink-secondary">{children}</Text>
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
        <Text className="mt-4 text-[13px] leading-5 text-ink-muted">
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
        <View className="rounded-btn bg-paper-deep px-2 py-0.5">
          <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
            {STATUS_LABELS[experiment.status]}
          </Text>
        </View>
        <Text className="font-mono text-[11px] text-ink-muted">
          {windowLabel(experiment.start_date, experiment.end_date)}
        </Text>
      </View>

      <Block label="Hypothesis">{experiment.hypothesis}</Block>
      <Block label="Intervention">{experiment.intervention}</Block>

      <View className="mt-6">
        <SectionLabel>Metrics watched</SectionLabel>
        {experiment.metrics.length === 0 ? (
          <Text className="mt-2 text-[13px] text-ink-muted">None recorded.</Text>
        ) : (
          <View className="mt-2 flex-row flex-wrap gap-2">
            {experiment.metrics.map((m) => (
              <View key={m} className="rounded-btn bg-paper-deep px-2 py-1">
                <Text className="font-mono text-[11px] text-ink-secondary">{m}</Text>
              </View>
            ))}
          </View>
        )}
      </View>

      {experiment.success_criteria ? (
        <Block label="Success criteria">{experiment.success_criteria}</Block>
      ) : null}

      {concluded && experiment.conclusion ? (
        <Block label="Conclusion">{experiment.conclusion}</Block>
      ) : null}
      {concluded && experiment.outcome_notes ? (
        <Block label="Readout">{experiment.outcome_notes}</Block>
      ) : null}

      {!concluded ? (
        <Text className="mt-8 text-[11px] leading-4 text-ink-muted">
          The Coach reads the watched metrics and records the verdict when the window closes — ask
          it for the readout.
        </Text>
      ) : null}
    </Screen>
  );
}
