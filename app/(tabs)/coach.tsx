import { Placeholder } from '@/components/ui/placeholder';
import { Screen } from '@/components/ui/screen';

export default function CoachScreen() {
  return (
    <Screen>
      <Placeholder
        title="Coach"
        purpose="Full-context chat and the daily brief. Calm, precise, evidence-seeking."
        spec="docs/ai-coach.md"
      />
    </Screen>
  );
}
