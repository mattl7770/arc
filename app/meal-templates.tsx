import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import {
  deleteTemplate,
  listTemplateItems,
  listTemplates,
  logMealFromTemplate,
} from '@/lib/db/repositories/meal-templates';
import { fmtInt, fmtQty, macroLine } from '@/lib/nutrition/format';
import type { MealTemplateItemRow, MealTemplateSummary } from '@/lib/nutrition/types';

/**
 * Meal templates (0015) — reusable named meals, logged in one tap.
 *
 * Templates are captured retroactively: "Save as template" on a meal's detail
 * screen. Here they're browsed, expanded to see what's inside, and logged onto
 * today. Logging a template stamps out fresh meal_items (snapshots, not links),
 * so editing or deleting a template never touches meals already logged from it.
 * The one pine action per screen is "Log now" on the expanded template.
 */

/** "150 g" / "1.5 ×" — a template item's portion, best-effort without the
 * catalog serving name (template_items snapshot the food, not its serving). */
function itemPortion(item: MealTemplateItemRow): string | null {
  if (item.grams != null) return `${fmtQty(item.grams)} g`;
  if (item.serving_qty != null) return `${fmtQty(item.serving_qty)} ×`;
  return null;
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

export default function MealTemplatesScreen() {
  const router = useRouter();
  const [templates, setTemplates] = useState<MealTemplateSummary[]>(() => listTemplates(getDb()));
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [items, setItems] = useState<MealTemplateItemRow[]>([]);
  const [deleteArmed, setDeleteArmed] = useState(false);

  const reload = useCallback(() => {
    setTemplates(listTemplates(getDb()));
    setDeleteArmed(false);
  }, []);
  useFocusEffect(reload);

  const toggle = (id: string) => {
    setDeleteArmed(false);
    if (expandedId === id) {
      setExpandedId(null);
      return;
    }
    setItems(listTemplateItems(getDb(), id));
    setExpandedId(id);
  };

  const logNow = (id: string) => {
    const now = new Date();
    logMealFromTemplate(getDb(), id, todayISODate(), clockFromISO(now.toISOString()));
    router.back();
  };

  const remove = (id: string) => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    deleteTemplate(getDb(), id);
    setExpandedId(null);
    reload();
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Meal templates" />
      </View>

      {templates.length === 0 ? (
        <View className="mt-2">
          <Text className="text-[13px] leading-5 text-ink-secondary">No templates yet.</Text>
          <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
            Build a meal you eat often — add its foods, then open the meal and choose “Save as
            template.” It’ll show up here to log again in one tap.
          </Text>
        </View>
      ) : (
        <View className="mt-2">
          <SectionLabel>Your templates</SectionLabel>
          <View className="mt-2">
            {templates.map((t) => {
              const expanded = expandedId === t.template.id;
              return (
                <View
                  key={t.template.id}
                  className="mb-2 rounded-card border border-hairline bg-porcelain">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={t.template.name}
                    accessibilityState={{ expanded }}
                    onPress={() => toggle(t.template.id)}
                    className="flex-row items-center gap-3 px-4 py-3 active:opacity-60">
                    <View className="flex-1">
                      <Text className="text-[15px] text-ink">{t.template.name}</Text>
                      <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                        {t.kcal != null ? `${fmtInt(t.kcal)} kcal · ` : ''}
                        {t.itemCount} item{t.itemCount === 1 ? '' : 's'}
                      </Text>
                    </View>
                    <Ionicons
                      name={expanded ? 'chevron-up' : 'chevron-down'}
                      size={18}
                      color={palette.inkMuted}
                    />
                  </Pressable>

                  {expanded ? (
                    <View className="border-t border-hairline-soft px-4 pb-4 pt-3">
                      {items.map((item, index) => {
                        const portion = itemPortion(item);
                        const line = macroLine(item);
                        return (
                          <View
                            key={item.id}
                            className={`flex-row items-baseline gap-3 py-2 ${
                              index === 0 ? '' : 'border-t border-hairline-soft'
                            }`}>
                            <View className="flex-1">
                              <Text className="text-[14px] leading-5 text-ink">{item.name}</Text>
                              {portion || line ? (
                                <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                                  {[portion, line].filter(Boolean).join(' · ')}
                                </Text>
                              ) : null}
                            </View>
                            <Text className="font-mono text-[12px] text-ink-secondary">
                              {item.kcal != null ? fmtInt(item.kcal) : '—'}
                            </Text>
                          </View>
                        );
                      })}

                      <View className="mt-3 flex-row items-center gap-2">
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={`Log ${t.template.name} now`}
                          onPress={() => logNow(t.template.id)}
                          className="flex-1 items-center justify-center rounded-btn bg-pine py-2.5 active:opacity-70">
                          <Text className="text-[13px] font-semibold text-pine-on">Log now</Text>
                        </Pressable>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityLabel={
                            deleteArmed ? 'Tap again to delete template' : 'Delete template'
                          }
                          onPress={() => remove(t.template.id)}
                          className="rounded-btn border border-hairline-strong px-3.5 py-2.5 active:bg-paper-deep">
                          <Text
                            className={`text-[13px] ${deleteArmed ? 'font-semibold text-ink' : 'text-ink-muted'}`}>
                            {deleteArmed ? 'Confirm' : 'Delete'}
                          </Text>
                        </Pressable>
                      </View>
                    </View>
                  ) : null}
                </View>
              );
            })}
          </View>
        </View>
      )}
    </Screen>
  );
}
