import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
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
 *
 * Conformed Set treatment — one **ruled plate**: a list of records is a table,
 * so the templates are ruled rows of a single plate rather than a stack of
 * cards, and an expanded template opens *inside* its own row (devices never
 * nest, so the expansion carries no device of its own).
 *
 * **The ledger rule.** A template's summary kcal is `sum(ti.kcal)` over its
 * items (`listTemplates`), and expanding shows exactly those items with exactly
 * those numbers — so the row header is the sum of what the expansion reveals.
 *
 * **Accent budget: one.** "Log now" on the expanded template — and only one
 * template is ever expanded, so only one accent is ever on screen.
 */

/** "150 g" / "1.5 ×" — a template item's portion, best-effort without the
 * catalog serving name (template_items snapshot the food, not its serving). */
function itemPortion(item: MealTemplateItemRow): string | null {
  if (item.grams != null) return `${fmtQty(item.grams)} g`;
  if (item.serving_qty != null) return `${fmtQty(item.serving_qty)} ×`;
  return null;
}

/** "1,240 kcal · 4 items" — the row's measured summary. */
function summaryLine(t: MealTemplateSummary): string {
  const count = `${t.itemCount} item${t.itemCount === 1 ? '' : 's'}`;
  return t.kcal != null ? `${fmtInt(t.kcal)} kcal · ${count}` : count;
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
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[15px] leading-6 text-ink">No templates yet.</Text>
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Build a meal you eat often — add its foods, then open the meal and choose “Save as
              template.” It’ll show up here to log again in one tap.
            </Text>
          </Block>
        </View>
      ) : (
        <View className="mt-4">
          <Block device="plate">
            <SectionLabel label="Your templates" note={`${templates.length} saved`} />
            <View className="mt-1">
              {templates.map((t, index) => {
                const expanded = expandedId === t.template.id;
                return (
                  <View
                    key={t.template.id}
                    className={index === 0 ? '' : 'border-t border-hairline'}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={t.template.name}
                      accessibilityState={{ expanded }}
                      onPress={() => toggle(t.template.id)}
                      className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
                      <View className="flex-1">
                        <Text className="font-serif text-[15px] leading-5 text-ink">
                          {t.template.name}
                        </Text>
                        <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                          {summaryLine(t)}
                        </Text>
                      </View>
                      <Ionicons
                        name={expanded ? 'chevron-up' : 'chevron-down'}
                        size={16}
                        color={palette.inkMuted}
                      />
                    </Pressable>

                    {/* The expansion sits inside the plate row and draws no
                        device of its own — devices never nest. Its items are
                        the arithmetic behind the summary line above. */}
                    {expanded ? (
                      <View className="pb-3 pl-3">
                        {items.map((item, itemIndex) => {
                          const portion = itemPortion(item);
                          const line = macroLine(item);
                          return (
                            <View
                              key={item.id}
                              className={
                                itemIndex === 0
                                  ? 'flex-row items-baseline gap-3 py-2'
                                  : 'flex-row items-baseline gap-3 border-t border-hairline py-2'
                              }>
                              <View className="flex-1">
                                <Text className="font-serif text-[14px] leading-5 text-ink">
                                  {item.name}
                                </Text>
                                {portion || line ? (
                                  <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
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
                            className="min-h-[44px] flex-1 items-center justify-center rounded-btn bg-pine active:opacity-70">
                            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on">
                              Log now
                            </Text>
                          </Pressable>
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={
                              deleteArmed ? 'Tap again to delete template' : 'Delete template'
                            }
                            onPress={() => remove(t.template.id)}
                            className="min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 active:opacity-60">
                            <Text
                              className={
                                deleteArmed
                                  ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                                  : 'font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted'
                              }>
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
          </Block>
        </View>
      )}
    </Screen>
  );
}
