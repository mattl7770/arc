import { Placeholder } from '@/components/ui/placeholder';
import { Screen } from '@/components/ui/screen';

export default function HomeScreen() {
  return (
    <Screen>
      <Placeholder
        title="Home"
        purpose="What to do right now, and today's non-negotiables. Stays directive — never a dashboard."
        spec="docs/home-screen.md"
      />
    </Screen>
  );
}
