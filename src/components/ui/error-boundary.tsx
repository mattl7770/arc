import { Component, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';

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
 *
 * Conformed Set treatment — the **ruled plate**. A failure is still a record of
 * something that happened, and a plate is what states a record; the alternative
 * (loose text floating on the sheet) is exactly the blank-gate look this design
 * refuses. **No accent:** the budget is a ceiling, not a quota, and there is
 * nothing directive to stamp here — "Try again" is an escape, not a next
 * action, so it is drawn in neutral ink on a hairline. It is still a button, so
 * it still takes the Label voice (§3): the outline and the neutral ink carry
 * its weight — the face is not what demotes it.
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
      <View className="flex-1 justify-center bg-paper px-6">
        <Block device="plate">
          <SectionLabel label="Unexpected error" />

          <Text className="mt-2.5 font-serif text-[21px] font-semibold leading-7 text-ink">
            ARC stopped drawing this screen.
          </Text>

          <Text className="mt-2.5 font-serif text-[15px] leading-6 text-ink-secondary">
            Something threw while rendering. Your data is safe on this device — nothing is written
            when a screen fails. Try again, or reopen the app.
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Try again"
            onPress={this.reset}
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-hairline px-5 py-3 active:opacity-60">
            <Text className="font-label text-[15px] font-medium text-ink-secondary">Try again</Text>
          </Pressable>
        </Block>
      </View>
    );
  }
}
