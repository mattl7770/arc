import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { type Edge, SafeAreaView } from 'react-native-safe-area-context';

type ScreenProps = {
  children: ReactNode;
  /**
   * Wrap the content in a ScrollView. Leave off for screens that own their own
   * virtualised list — nesting a FlatList inside a ScrollView breaks recycling.
   */
  scroll?: boolean;
  /**
   * Safe-area edges to inset. Defaults to top only — tab screens let the tab bar
   * own the bottom. Stack-pushed screens with a bottom action (e.g. the metric
   * keypad) have no tab bar, so they pass `['top', 'bottom']` to keep the action
   * clear of the home indicator.
   */
  edges?: readonly Edge[];
};

/**
 * The one container every screen sits in: safe-area aware, bone-paper
 * background, consistent horizontal gutter.
 */
export function Screen({ children, scroll = false, edges = ['top'] }: ScreenProps) {
  return (
    <SafeAreaView edges={edges} className="flex-1 bg-paper">
      {scroll ? (
        <ScrollView
          className="flex-1"
          contentContainerClassName="grow px-5 pb-10"
          keyboardShouldPersistTaps="handled">
          {children}
        </ScrollView>
      ) : (
        <View className="flex-1 px-5">{children}</View>
      )}
    </SafeAreaView>
  );
}
