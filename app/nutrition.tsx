import { View } from 'react-native';

import { Placeholder } from '@/components/ui/placeholder';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';

/**
 * Nutrition sub-app, pushed from the Log tab's Meal tile. Placeholder for now;
 * grows into food logging (photo / text / manual), meal templates, macros,
 * grocery, pantry, recipes, and CAL-AI-style photo analysis
 * (docs/information-architecture.md).
 */
export default function NutritionScreen() {
  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Nutrition" />
      </View>
      <Placeholder
        title="Nutrition"
        purpose="Log food by photo, text, or manual entry — plus meal templates, macros, grocery, pantry, and recipes."
        spec="docs/information-architecture.md"
      />
    </Screen>
  );
}
