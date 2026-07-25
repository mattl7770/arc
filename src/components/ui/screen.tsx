import type { ReactNode } from 'react';
import { ScrollView, View } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

type ScreenProps = {
  children: ReactNode;
  /**
   * Wrap the content in a ScrollView. Leave off for screens that own their own
   * virtualised list — nesting a FlatList inside a ScrollView breaks recycling.
   */
  scroll?: boolean;
};

/**
 * The one container every screen sits in: safe-area aware, bone-paper
 * background, consistent horizontal gutter. The bottom edge is owned by the
 * tab bar.
 */
export function Screen({ children, scroll = false }: ScreenProps) {
  return (
    <SafeAreaView edges={['top']} className="flex-1 bg-paper">
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
