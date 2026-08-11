import { Component, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { PaperGrid } from '@/components/ui/screen';
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
 * Conformed Set treatment — **no device**, matching MissionEmpty and
 * `app/+not-found.tsx`, the other two authored message screens. This argued the
 * opposite until 2026-08-10 — *"a failure is still a record of something that
 * happened, and a plate is what states a record"* — and it is recorded here
 * rather than deleted, because the reasoning is exactly the one docs/decisions.md
 * §1a overrules. A plate closes a **multi-row** record; a crash message is one
 * label, one headline, one paragraph and one escape, and a border around that is
 * the box-around-a-single-thing the owner has reported three times. What made
 * the argument feel right was the fear underneath it — that unplated copy is
 * "loose text floating on the sheet" — that unplated, this reads as a blank
 * gate rather than as the app. That fear is answered by the paper grid this
 * screen prints itself (below), by the section label, and by the type voices,
 * not by an edge. **No accent:** the budget is a ceiling, not a quota, and there is
 * nothing directive to stamp here — "Try again" is an escape, not a next
 * action, so it is drawn in neutral ink on a hairline. It is still a button, so
 * it still takes the Label voice (§3): the outline and the neutral ink carry
 * its weight — the face is not what demotes it.
 *
 * It replaces the whole tree when it fires, so it builds its own root and cannot
 * use `<Screen>` — which means it has to print the paper grid itself. A failure
 * screen on blank stock is the exact blank gate described above, and with the
 * plate gone the grid is now the whole of what says "this is still ARC" — which
 * is the one thing this screen most needs to say.
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
      // No padding on the grid's parent — Yoga insets absolute children by it.
      <View className="flex-1 bg-paper">
        <PaperGrid />
        <View className="flex-1 justify-center px-6">
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
        </View>
      </View>
    );
  }
}
