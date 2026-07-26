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
      <Text className="font-serif text-3xl font-semibold tracking-tight text-ink">{title}</Text>
      <Text className="mt-2 text-base leading-6 text-ink-secondary">{purpose}</Text>
      {spec ? (
        <Text className="mt-6 font-mono text-[11px] uppercase tracking-[2px] text-ink-muted">
          Spec · {spec}
        </Text>
      ) : null}
    </View>
  );
}
