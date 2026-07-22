import { Text, View } from 'react-native';

type PlaceholderProps = {
  title: string;
  /** One line on what this screen is for. */
  purpose: string;
  /** The doc that specifies it, e.g. `docs/home-screen.md`. */
  spec?: string;
};

/**
 * Stand-in body for a screen that exists in the route tree but has no
 * implementation yet. Every placeholder names the doc that specifies it so the
 * next person to open the file knows where the requirements live.
 *
 * Delete this component once the last placeholder screen is built.
 */
export function Placeholder({ title, purpose, spec }: PlaceholderProps) {
  return (
    <View className="flex-1 justify-center">
      <Text className="text-3xl font-semibold tracking-tight text-ink-900 dark:text-ink-50">
        {title}
      </Text>
      <Text className="mt-2 text-base leading-6 text-ink-500 dark:text-ink-400">{purpose}</Text>
      {spec ? (
        <Text className="mt-6 text-xs uppercase tracking-widest text-ink-400 dark:text-ink-600">
          Spec · {spec}
        </Text>
      ) : null}
    </View>
  );
}
