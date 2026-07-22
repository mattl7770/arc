import { Placeholder } from '@/components/ui/placeholder';
import { Screen } from '@/components/ui/screen';

export default function LogScreen() {
  return (
    <Screen>
      <Placeholder
        title="Log"
        purpose="Fast capture: habits, meals, training, supplements, therapies, notes."
        spec="docs/data-model.md"
      />
    </Screen>
  );
}
