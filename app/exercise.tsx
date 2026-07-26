import { View } from 'react-native';

import { Placeholder } from '@/components/ui/placeholder';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';

/**
 * Exercise sub-app, pushed from the Log tab's Workout tile. Placeholder for now;
 * grows into a workout builder, set/rep logging, and Zone 2 / VO2max / mobility
 * / progressive-overload metrics (docs/information-architecture.md).
 */
export default function ExerciseScreen() {
  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Exercise" />
      </View>
      <Placeholder
        title="Exercise"
        purpose="Build workouts, log sets and reps, and track Zone 2, VO2max, mobility, and progressive overload."
        spec="docs/information-architecture.md"
      />
    </Screen>
  );
}
