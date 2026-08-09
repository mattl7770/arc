import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { listRecipes } from '@/lib/db/repositories/recipes';
import { fmtInt } from '@/lib/nutrition/format';
import type { RecipeSummary } from '@/lib/recipes/types';

/**
 * The recipe book (docs/recipes-grocery.md §5): search + list, favorites and
 * recently-cooked surfaced first by the repository's ranking. The one pine
 * action is "Import a recipe" — the headline path this sub-app exists for.
 * Per-serving kcal appears ONLY when the recipe's nutrition gate passes; an
 * incomplete recipe shows its ingredient count and no number.
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

/** "469 kcal/serving · 8 ingredients · cooked 3×" — the mono detail line. */
function detailLine(r: RecipeSummary): string {
  const parts: string[] = [];
  if (r.perServingKcal !== null) parts.push(`${fmtInt(r.perServingKcal)} kcal/serving`);
  parts.push(`${r.ingredientCount} ingredient${r.ingredientCount === 1 ? '' : 's'}`);
  if (r.timesCooked > 0) parts.push(`cooked ${r.timesCooked}×`);
  return parts.join(' · ');
}

/** Quiet provenance badge for imported / Coach-designed recipes. */
function sourceBadge(r: RecipeSummary): string | null {
  if (r.recipe.source === 'import') return r.recipe.source_platform ?? 'imported';
  if (r.recipe.source === 'ai') return 'coach';
  return null;
}

export default function RecipesScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [recipes, setRecipes] = useState<RecipeSummary[]>(() => listRecipes(getDb()));

  const reload = useCallback(() => setRecipes(listRecipes(getDb(), query)), [query]);
  useFocusEffect(reload);

  const search = (text: string) => {
    setQuery(text);
    setRecipes(listRecipes(getDb(), text));
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Recipes" />
      </View>

      {/* The one pine action: import. Manual create sits beside it, quiet. */}
      <View className="mt-2 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Import a recipe"
          onPress={() => router.push('/recipe-import')}
          className="flex-1 flex-row items-center justify-center gap-2 rounded-card bg-pine px-3.5 py-3 active:opacity-70">
          <Ionicons name="download-outline" size={17} color={palette.pineOn} />
          <Text className="text-[13px] font-semibold text-pine-on">Import a recipe</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New recipe"
          onPress={() => router.push('/recipe-edit')}
          className="flex-row items-center gap-2 rounded-card border border-hairline bg-porcelain px-3.5 py-3 active:bg-paper-deep">
          <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
          <Text className="text-[13px] text-ink">New</Text>
        </Pressable>
      </View>

      <TextInput
        accessibilityLabel="Search recipes"
        value={query}
        onChangeText={search}
        placeholder="Search the book"
        placeholderTextColor={palette.inkMuted}
        autoCapitalize="none"
        autoCorrect={false}
        className="mt-3 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink"
      />

      <View className="mt-6">
        <SectionLabel>{query.trim() === '' ? 'Your book' : 'Matches'}</SectionLabel>
        {recipes.length === 0 ? (
          <View className="mt-2">
            <Text className="text-[13px] leading-5 text-ink-secondary">
              {query.trim() === '' ? 'No recipes yet.' : 'Nothing matches.'}
            </Text>
            {query.trim() === '' ? (
              <Text className="mt-2 text-[13px] leading-5 text-ink-muted">
                Share an Instagram reel or TikTok to ARC, paste a link, or save a logged meal as a
                recipe — the book builds itself from what you actually cook.
              </Text>
            ) : null}
          </View>
        ) : (
          <View className="mt-2 rounded-card border border-hairline bg-porcelain">
            {recipes.map((r, index) => {
              const badge = sourceBadge(r);
              return (
                <Pressable
                  key={r.recipe.id}
                  accessibilityRole="button"
                  accessibilityLabel={r.recipe.title}
                  onPress={() =>
                    router.push({ pathname: '/recipe-detail', params: { id: r.recipe.id } })
                  }
                  className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
                    index === 0 ? '' : 'border-t border-hairline-soft'
                  }`}>
                  {r.recipe.is_favorite === 1 ? (
                    <Ionicons name="star" size={14} color={palette.inkSecondary} />
                  ) : null}
                  <View className="flex-1">
                    <Text className="font-serif text-[15px] font-semibold text-ink">
                      {r.recipe.title}
                    </Text>
                    <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                      {detailLine(r)}
                    </Text>
                  </View>
                  {badge ? (
                    <Text className="text-[10px] uppercase tracking-[1px] text-ink-muted">
                      {badge}
                    </Text>
                  ) : null}
                  <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
                </Pressable>
              );
            })}
          </View>
        )}
      </View>
    </Screen>
  );
}
