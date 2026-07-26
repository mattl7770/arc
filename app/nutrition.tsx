import Ionicons from '@expo/vector-icons/Ionicons';
import { Text, View } from 'react-native';

import { MockupNote } from '@/components/ui/mockup-note';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';

/**
 * Nutrition sub-app, pushed from the Log tab's Nutrition tile.
 *
 * DESIGN MOCKUP — real layout, mock content, nothing persists yet. It sketches
 * the direction so it can be judged on-device before wiring: today's intake,
 * three ways to log a meal (photo / describe / manual), and the day's meals.
 * Full spec (templates, macros/micros, grocery, pantry, recipes, CAL-AI photo
 * analysis) in docs/information-architecture.md.
 */
type Macro = { label: string; grams: number; target: number };
const MACROS: Macro[] = [
  { label: 'Protein', grams: 100, target: 180 },
  { label: 'Carbs', grams: 96, target: 160 },
  { label: 'Fat', grams: 58, target: 70 },
];

type Meal = { time: string; name: string; detail: string; kcal: number };
const MEALS: Meal[] = [
  {
    time: '08:05',
    name: 'Breakfast · Protein Forward',
    detail: '3 eggs · Greek yogurt · berries',
    kcal: 640,
  },
  { time: '12:30', name: 'Lunch · Template B', detail: 'Salmon · lentils · olive oil', kcal: 720 },
];

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

export default function NutritionScreen() {
  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Nutrition" />
      </View>

      {/* Today's intake */}
      <View className="mt-2">
        <SectionLabel>Today</SectionLabel>
        <View className="mt-2 rounded-card border border-hairline bg-porcelain p-4">
          <View className="flex-row items-baseline justify-between">
            <View className="flex-row items-baseline gap-1.5">
              <Text className="font-mono text-4xl text-ink">1,840</Text>
              <Text className="font-mono text-sm text-ink-muted">kcal</Text>
            </View>
            <Text className="text-xs text-ink-muted">of 2,200 target</Text>
          </View>

          <View className="mt-4 border-t border-hairline-soft pt-4">
            <View className="flex-row gap-4">
              {MACROS.map((m) => (
                <View key={m.label} className="flex-1">
                  <Text className="text-[11px] uppercase tracking-[1px] text-ink-muted">
                    {m.label}
                  </Text>
                  <View className="mt-1 flex-row items-baseline gap-1">
                    <Text className="font-mono text-lg text-ink">{m.grams}</Text>
                    <Text className="font-mono text-[11px] text-ink-muted">/ {m.target}g</Text>
                  </View>
                  <View className="mt-1.5 h-1 overflow-hidden rounded-full bg-hairline">
                    <View
                      className="h-1 rounded-full bg-ink-secondary"
                      style={{ width: `${Math.min(100, (m.grams / m.target) * 100)}%` }}
                    />
                  </View>
                </View>
              ))}
            </View>
          </View>
        </View>
      </View>

      {/* Log a meal */}
      <View className="mt-8">
        <SectionLabel>Log a meal</SectionLabel>
        {/* The one pine action on this screen. */}
        <View className="mt-2 flex-row items-center gap-3 rounded-card bg-pine px-4 py-3.5">
          <Ionicons name="camera-outline" size={20} color={palette.pineOn} />
          <View className="flex-1">
            <Text className="text-[15px] font-semibold text-pine-on">Describe or snap a meal</Text>
            <Text className="mt-0.5 text-xs text-pine-tint">
              Type it, speak it, or photograph the plate
            </Text>
          </View>
        </View>
        <View className="mt-2 flex-row gap-2">
          {[
            { icon: 'create-outline', label: 'Manual entry' },
            { icon: 'albums-outline', label: 'From a template' },
          ].map((o) => (
            <View
              key={o.label}
              className="flex-1 flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3">
              <Ionicons
                name={o.icon as keyof typeof Ionicons.glyphMap}
                size={17}
                color={palette.inkSecondary}
              />
              <Text className="text-[13px] text-ink">{o.label}</Text>
            </View>
          ))}
        </View>
      </View>

      {/* Eaten today */}
      <View className="mt-8">
        <SectionLabel>Eaten today</SectionLabel>
        <View className="mt-1">
          {MEALS.map((meal, index) => (
            <View
              key={meal.time}
              className={`flex-row gap-3 py-3 ${index === 0 ? '' : 'border-t border-hairline-soft'}`}>
              <Text className="w-11 pt-0.5 font-mono text-[11px] text-ink-muted">{meal.time}</Text>
              <View className="flex-1">
                <Text className="text-[15px] leading-5 text-ink">{meal.name}</Text>
                <Text className="mt-0.5 text-xs leading-5 text-ink-muted">{meal.detail}</Text>
              </View>
              <Text className="pt-0.5 font-mono text-[13px] text-ink-secondary">{meal.kcal}</Text>
            </View>
          ))}
        </View>
      </View>

      <MockupNote>
        Design mockup — food logging (photo / text / manual), templates, macros, grocery, pantry,
        and recipes wire up next. Nothing here saves yet. Spec · docs/information-architecture.md
      </MockupNote>
    </Screen>
  );
}
