import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
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
 * Conformed Set treatment — **ruled plates**: running, concluded and abandoned
 * are three ledgers of records, so each is one plate with its rows ruled and
 * its own tally in the label's mono note slot. The separate card per running
 * experiment is gone; a record is a table.
 *
 * **Zero accent**, and no signal colour either. The COACH designs and concludes
 * experiments (create_experiment / complete_experiment), so there is no primary
 * action on this screen to own an accent — same posture as app/wearables.tsx.
 * "Read out" is workflow state, not biology, so it is a neutral chip in the
 * label voice; windows and day counts are measured values and stay in mono.
 */

/** A neutral workflow chip — a status word, so the label voice, never mono. */
function Chip({ children }: { children: string }) {
  return (
    <View className="border border-paper-deep bg-paper-dim px-2 py-0.5">
      <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
        {children}
      </Text>
    </View>
  );
}

function RunningRow({
  experiment,
  first,
  onPress,
}: {
  experiment: ActiveExperiment;
  first: boolean;
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
      className={`min-h-[44px] py-3 active:opacity-60 ${first ? '' : 'border-t border-hairline'}`}>
      <View className="flex-row items-center gap-3">
        <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">
          {experiment.title}
        </Text>
        {experiment.ready ? <Chip>Read out</Chip> : null}
        <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
      </View>
      <Text className="mt-1 font-serif text-[13px] leading-5 text-ink-secondary" numberOfLines={2}>
        {experiment.intervention}
      </Text>
      <View className="mt-1.5 flex-row items-center gap-2">
        <Text className="font-mono text-[11px] text-ink-muted">
          {windowLabel(experiment.start_date, experiment.end_date)}
        </Text>
        <Text className="font-mono text-[11px] text-ink-muted">·</Text>
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
      className={`min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60 ${
        first ? '' : 'border-t border-hairline'
      }`}>
      <View className="flex-1">
        <Text className="font-serif text-[15px] text-ink">{experiment.title}</Text>
        <Text className="mt-0.5 font-serif text-[12px] leading-4 text-ink-muted" numberOfLines={2}>
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
      <Text className="mt-1 font-serif text-[13px] leading-5 text-ink-secondary">
        n-of-1: change one thing, watch the metrics, decide if it held. Ask the Coach to start one.
      </Text>

      {isEmpty ? (
        // Empty is authored, never blank.
        <View className="mt-8">
          <Block device="plate">
            <Text className="font-serif text-[16px] font-semibold text-ink">
              No experiments yet
            </Text>
            <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
              An experiment is one deliberate change tested against your own data — &ldquo;does 400
              mg magnesium at night lift my HRV?&rdquo; Ask the Coach to design one; it picks the
              metrics, sets the window, and reads out the verdict when the window closes.
            </Text>
          </Block>
        </View>
      ) : null}

      {running.length > 0 ? (
        <View className="mt-8">
          <SectionLabel label="Running" note={String(running.length)} />
          <View className="mt-3">
            <Block device="plate">
              {running.map((e, i) => (
                <RunningRow key={e.id} experiment={e} first={i === 0} onPress={() => open(e.id)} />
              ))}
            </Block>
          </View>
        </View>
      ) : null}

      {concluded.length > 0 ? (
        <View className="mt-8">
          <SectionLabel label="Concluded" note={String(concluded.length)} />
          <View className="mt-3">
            <Block device="plate">
              {concluded.map((e, i) => (
                <ConcludedRow
                  key={e.id}
                  experiment={e}
                  first={i === 0}
                  onPress={() => open(e.id)}
                />
              ))}
            </Block>
          </View>
        </View>
      ) : null}

      {abandoned.length > 0 ? (
        <View className="mt-8">
          <SectionLabel label="Abandoned" note={String(abandoned.length)} />
          <View className="mt-3">
            <Block device="plate">
              {abandoned.map((e, i) => (
                <ConcludedRow
                  key={e.id}
                  experiment={e}
                  first={i === 0}
                  onPress={() => open(e.id)}
                />
              ))}
            </Block>
          </View>
        </View>
      ) : null}
    </Screen>
  );
}
