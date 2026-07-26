import { useLocalSearchParams } from 'expo-router';
import { View } from 'react-native';

import { Placeholder } from '@/components/ui/placeholder';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';

/**
 * Generic quick-capture sheet reached from a quick-capture tile (Supplement,
 * Therapy…). Placeholder for now — a focused capture sheet per type lands here
 * next (Supplement folds Medication in as a type toggle, per
 * docs/information-architecture.md).
 */
const LABELS: Record<string, string> = {
  supplement: 'Supplement',
  therapy: 'Therapy',
};

export default function CaptureScreen() {
  const { type } = useLocalSearchParams<{ type?: string }>();
  const label = (type && LABELS[type]) ?? 'Capture';

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={`Log ${label}`} />
      </View>
      <Placeholder
        title={`Log ${label}`}
        purpose="A focused capture sheet for this type lands here next — for now, the command field up top captures anything."
        spec="docs/information-architecture.md"
      />
    </Screen>
  );
}
