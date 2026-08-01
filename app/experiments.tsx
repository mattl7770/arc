import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useExperiments, type ActiveExperiment } from '@/hooks/use-experiments';
import type { Experiment } from '@/lib/db/repositories/experiments';
import { progressPhrase, windowLabel } from '@/lib/experiments/format';

/**
 * Experiments — the n-of-1 loop, pushed from the Data tab. Change one thing,
 * watch specific metrics for N days, read out whether the hypothesis held
 * (docs/ai-coach.md §6; table + repository ship in migration 0027).
 *
 * ZERO pine on this screen: the COACH designs and concludes experiments
 * (create_experiment / complete_experiment), so there is no primary action to
 * own the accent — same posture as app/wearables.tsx. "Ready to read out" is
 * workflow, not biology, so it stays neutral ink; signal colours are reserved
 * for biological states.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

function RunningRow({
  experiment,
  onPress,
}: {
  experiment: ActiveExperiment;
  onPress: () => void;
}) {
  const phrase = progressPhrase(experiment);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${experiment.title}. ${phrase}. ${windowLabel(
        experiment.start_date,
        experiment.end_date
      )}. Open.`}
      onPress={onPress}
      className="rounded-card border border-hairline bg-porcelain p-4 active:bg-paper-deep">
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">
          {experiment.title}
        </Text>
        {experiment.ready ? (
          <View className="rounded-btn bg-paper-deep px-2 py-0.5">
            <Text className="font-mono text-[9.5px] uppercase tracking-[1px] text-ink-muted">
              Read out
            </Text>
          </View>
        ) : null}
        <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
      </View>
      <Text className="mt-1 text-[13px] leading-5 text-ink-secondary" numberOfLines={2}>
        {experiment.intervention}
      </Text>
      <View className="mt-2 flex-row items-center gap-2">
        <Text className="font-mono text-[11px] text-ink-muted">
          {windowLabel(experiment.start_date, experiment.end_date)}
        </Text>
        <Text className="text-[11px] text-ink-muted">·</Text>
        <Text className="font-mono text-[11px] text-ink-muted">{phrase}</Text>
      </View>
    </Pressable>
  );
}

function ConcludedRow({
  experiment,
  onPress,
  first,
}: {
  experiment: Experiment;
  onPress: () => void;
  first: boolean;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={`${experiment.title}. ${experiment.conclusion ?? 'No conclusion recorded'}. Open.`}
      onPress={onPress}
      className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
        first ? '' : 'border-t border-hairline-soft'
      }`}>
      <View className="flex-1">
        <Text className="text-[15px] text-ink">{experiment.title}</Text>
        <Text className="mt-0.5 text-[12px] leading-4 text-ink-muted" numberOfLines={2}>
          {experiment.conclusion ?? experiment.outcome_notes ?? 'No readout recorded'}
        </Text>
      </View>
      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
    </Pressable>
  );
}

export default function ExperimentsScreen() {
  const router = useRouter();
  const { active, concluded, abandoned, isEmpty } = useExperiments();
  const open = (id: string) => router.push({ pathname: '/experiment-detail', params: { id } });

  // Ready-to-read-out first: they're the ones asking for a decision.
  const running = [...active].sort((a, b) => Number(b.ready) - Number(a.ready));

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Experiments" />
      </View>
      <Text className="mt-1 text-[13px] leading-5 text-ink-secondary">
        n-of-1: change one thing, watch the metrics, decide if it held. Ask the Coach to start one.
      </Text>

      {isEmpty ? (
        <View className="mt-8 rounded-card border border-hairline bg-porcelain p-5">
          <Text className="font-serif text-[16px] font-semibold text-ink">No experiments yet</Text>
          <Text className="mt-1.5 text-[13px] leading-5 text-ink-secondary">
            An experiment is one deliberate change tested against your own data — &ldquo;does 400 mg
            magnesium at night lift my HRV?&rdquo; Ask the Coach to design one; it picks the
            metrics, sets the window, and reads out the verdict when the window closes.
          </Text>
        </View>
      ) : null}

      {running.length > 0 ? (
        <View className="mt-8">
          <View className="flex-row items-baseline justify-between">
            <SectionLabel>Running</SectionLabel>
            <Text className="font-mono text-[11px] text-ink-muted">{running.length}</Text>
          </View>
          <View className="mt-3 gap-2">
            {running.map((e) => (
              <RunningRow key={e.id} experiment={e} onPress={() => open(e.id)} />
            ))}
          </View>
        </View>
      ) : null}

      {concluded.length > 0 ? (
        <View className="mt-8">
          <View className="flex-row items-baseline justify-between">
            <SectionLabel>Concluded</SectionLabel>
            <Text className="font-mono text-[11px] text-ink-muted">{concluded.length}</Text>
          </View>
          <View className="mt-3 rounded-card border border-hairline bg-porcelain">
            {concluded.map((e, i) => (
              <ConcludedRow key={e.id} experiment={e} first={i === 0} onPress={() => open(e.id)} />
            ))}
          </View>
        </View>
      ) : null}

      {abandoned.length > 0 ? (
        <View className="mt-8">
          <SectionLabel>Abandoned</SectionLabel>
          <View className="mt-3 rounded-card border border-hairline bg-porcelain">
            {abandoned.map((e, i) => (
              <ConcludedRow key={e.id} experiment={e} first={i === 0} onPress={() => open(e.id)} />
            ))}
          </View>
        </View>
      ) : null}
    </Screen>
  );
}
