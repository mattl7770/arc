import { Component, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

type Props = { children: ReactNode };
type State = { error: Error | null };

/**
 * App-wide error boundary. The data layer opens SQLite synchronously and
 * *throws* on failure (src/lib/db/client.ts), and those opens happen in render /
 * useState initializers — so without a boundary a failed open is a blank white
 * crash. This catches it and shows a calm, on-brand message with a retry, which
 * re-mounts the tree (recovering if the failure was transient).
 *
 * Error boundaries must be class components; this is the one class in the app.
 */
export class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error) {
    console.error('[arc] uncaught render error', error);
  }

  reset = () => this.setState({ error: null });

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <View className="flex-1 items-center justify-center bg-paper px-8">
        <Text className="font-serif text-xl font-semibold text-ink">Something went wrong</Text>
        <Text className="mt-2 text-center text-sm leading-5 text-ink-secondary">
          ARC hit an unexpected error and stopped. Your data is safe on this device — try again, or
          reopen the app.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try again"
          onPress={this.reset}
          className="mt-6 rounded-btn border border-hairline-strong px-5 py-2.5 active:opacity-60">
          <Text className="text-sm font-medium text-ink-secondary">Try again</Text>
        </Pressable>
      </View>
    );
  }
}
