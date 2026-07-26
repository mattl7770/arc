import { Placeholder } from '@/components/ui/placeholder';
import { Screen } from '@/components/ui/screen';

export default function DataScreen() {
  return (
    <Screen>
      <Placeholder
        title="Data"
        purpose="Biomarker trends, wearable history, body composition. The dashboards live here, not on Home."
        spec="docs/data-model.md"
      />
    </Screen>
  );
}
