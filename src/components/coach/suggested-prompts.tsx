import { Pressable, ScrollView, Text } from 'react-native';

/**
 * Starter prompts, shown only before the user has said anything. Bordered
 * paper tags — they make the empty thread feel alive and hint at what the
 * Coach is for; each is a real question the Coach will answer once it is
 * wired to data.
 */
const PROMPTS = [
  'How’s my recovery today?',
  'What should I prioritize?',
  'Adjust today’s plan',
  'Explain my HRV trend',
];

export function SuggestedPrompts({ onPick }: { onPick: (text: string) => void }) {
  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      className="-mx-5"
      contentContainerClassName="gap-2 px-5">
      {PROMPTS.map((prompt) => (
        <Pressable
          key={prompt}
          accessibilityRole="button"
          onPress={() => onPick(prompt)}
          className="rounded-[14px] border border-hairline-strong px-3.5 py-2 active:opacity-60">
          <Text className="text-[13px] text-ink-secondary">{prompt}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
