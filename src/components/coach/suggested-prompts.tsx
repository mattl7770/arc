import { Pressable, ScrollView, Text } from 'react-native';

/**
 * Starter prompts, shown only before the user has said anything. They make the
 * empty thread feel alive and hint at what the Coach is for — each is a real
 * question the Coach will answer once it is wired to data.
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
          className="rounded-full border border-ink-200 px-3.5 py-2 active:opacity-60 dark:border-ink-700">
          <Text className="text-[13px] text-ink-600 dark:text-ink-300">{prompt}</Text>
        </Pressable>
      ))}
    </ScrollView>
  );
}
