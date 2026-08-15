import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { listFolders, listRecipes, unfiledRecipeCount } from '@/lib/db/repositories/recipes';
import { fmtInt } from '@/lib/nutrition/format';
import type { RecipeFolderSummary, RecipeSummary } from '@/lib/recipes/types';

/**
 * The recipe book (docs/recipes-grocery.md §5): search + list, favorites and
 * recently-cooked surfaced first by the repository's ranking.
 *
 * ## Conformed Set surface system (00-design-spec.md §1)
 *
 *   Actions   → no device. Two controls are controls, not content.
 *   Search    → **recessed well**, wrapping a BARE TextInput: a capture surface
 *               is stock you write on, so the block IS the field. The input
 *               carries no border and no fill of its own — an input is never
 *               `paper-hi` (src/components/ui/block.tsx).
 *   The book  → **ruled plate**: a list of records is a table, ruled between
 *               rows by `Divider` and never by a `border-t` (which React Native
 *               draws as a full rectangle — the owner's "weird boxes").
 *
 * **Accent budget: one.** "Import a recipe" is it — the headline path this
 * sub-app exists for, moved here off the Eat tab (owner, 2026-08-11). "New"
 * sits beside it outlined; the favorite star, the provenance badge and the
 * chevrons are all neutral ink.
 *
 * **Honesty.** Per-serving kcal appears ONLY when the recipe's nutrition gate
 * passes (`perServingKcal !== null`); an incomplete recipe shows its ingredient
 * count and no number, never an invented one. The section's tally counts the
 * rows actually drawn — nothing here folds.
 *
 * ## Folders (0035, owner: *"Make functionality for creating folders in the
 * recipe book"*)
 *
 * The strip above the book is a **filter, not an editor**. Tapping a drawer
 * scopes the list; nothing here can rename or delete one, because a filter and
 * a destructive control must never be the same row under the same finger —
 * managing lives on app/recipe-folders.tsx, one quiet chip away.
 *
 * **`All` is the default and stays the default.** A recipe in no folder is
 * never harder to reach than one in a folder, so the book opens on everything
 * and `Unfiled` is a filter beside the drawers rather than a quarantine. The
 * strip appears only once a folder exists; before that it is one chip offering
 * to start.
 *
 * Chips are **controls, not content**, so they take no device — named by a
 * `SectionLabel` and set apart by air, exactly as the grocery screen's staples
 * are. The selected chip is marked in ink; the accent stays on `Import`.
 *
 * ## The title's weight (owner, 2026-08-15)
 *
 * *"Make the names of recipes a bit bolder on the recipe book screen so they
 * stand out a bit more."* A row's SUBJECT is the title, and it was set at the
 * same weight as the folder chips and the empty-state prose around it. It is
 * now `font-semibold` at the same 16px — weight inside the existing scale,
 * never a size invented for this screen, and nothing else on the row shrank to
 * make room (the 10px floor is a standing open item; going near it to buy
 * contrast would trade one defect for a worse one).
 *
 * **The sibling surfaces did not move, and that is deliberate.** This is the
 * only list of recipe titles in the app: `app/recipe-detail.tsx` renders its
 * title through `StackHeader`, which has always been serif **semibold** — so
 * the row and the screen it opens now agree rather than diverge, which is the
 * consistency argument pointing the same way as the request.
 * `app/recipe-folders.tsx` lists FOLDERS, not recipes, and the Coach's recipe
 * references are text in a turn with no row treatment at all.
 */

/** What the book is scoped to. `all` is the default and the only state in
 *  which every recipe is reachable in one list — see the docblock. */
type Scope = { kind: 'all' } | { kind: 'unfiled' } | { kind: 'folder'; id: string };

/** The repository's tri-state filter for a scope: `undefined` = everything,
 *  `null` = unfiled only, an id = that drawer (listRecipes' `opts.folder`). */
function scopeFilter(scope: Scope): string | null | undefined {
  if (scope.kind === 'all') return undefined;
  if (scope.kind === 'unfiled') return null;
  return scope.id;
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

/**
 * The whole book, not a page of it. The Eat tab's Kitchen row counts recipes
 * with an uncapped COUNT(*), so a repository default of 100 would let the hub
 * promise 118 and this screen show 100 — the ledger rule broken across two
 * screens. 500 is a ceiling no personal recipe book reaches, and the query is
 * one statement either way.
 */
const BOOK_LIMIT = 500;

export default function RecipesScreen() {
  const router = useRouter();
  // A drawer tapped on app/recipe-folders.tsx opens the book already scoped to
  // it — the folders screen is a way INTO the book, not a dead end.
  const { folder } = useLocalSearchParams<{ folder?: string }>();
  const [scope, setScope] = useState<Scope>(() =>
    typeof folder === 'string' && folder !== '' ? { kind: 'folder', id: folder } : { kind: 'all' }
  );
  const [query, setQuery] = useState('');
  const [recipes, setRecipes] = useState<RecipeSummary[]>(() =>
    listRecipes(getDb(), '', { limit: BOOK_LIMIT, folder: scopeFilter(scope) })
  );
  const [folders, setFolders] = useState<RecipeFolderSummary[]>(() => listFolders(getDb()));
  const [unfiled, setUnfiled] = useState(() => unfiledRecipeCount(getDb()));

  const reload = useCallback(() => {
    const db = getDb();
    const live = listFolders(db);
    setFolders(live);
    setUnfiled(unfiledRecipeCount(db));
    // A SCOPE CAN OUTLIVE ITS FOLDER. Manage → delete the drawer you were
    // looking at → come back, and the book would keep querying a folder id
    // that no longer exists: an empty list under a heading reading "Folder",
    // and — if it was the last drawer — no `All` chip to escape with, because
    // the strip collapses to its single "Organise into folders" state. So the
    // scope is reconciled against the folders that actually exist, on every
    // focus, and falls back to the one view that is always correct.
    const gone = scope.kind === 'folder' && !live.some((f) => f.folder.id === scope.id);
    const effective: Scope = gone ? { kind: 'all' } : scope;
    if (gone) setScope(effective);
    setRecipes(listRecipes(db, query, { limit: BOOK_LIMIT, folder: scopeFilter(effective) }));
  }, [query, scope]);
  useFocusEffect(reload);

  const search = (text: string) => {
    setQuery(text);
    setRecipes(listRecipes(getDb(), text, { limit: BOOK_LIMIT, folder: scopeFilter(scope) }));
  };

  const rescope = (next: Scope) => {
    setScope(next);
    setRecipes(listRecipes(getDb(), query, { limit: BOOK_LIMIT, folder: scopeFilter(next) }));
  };

  const searching = query.trim() !== '';
  const scopeName =
    scope.kind === 'all'
      ? null
      : scope.kind === 'unfiled'
        ? 'Unfiled'
        : (folders.find((f) => f.folder.id === scope.id)?.folder.name ?? 'Folder');

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Recipes" />
      </View>

      {/* The one pine action: import. Manual create sits beside it, outlined. */}
      <View className="mt-5 flex-row items-stretch gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Import a recipe"
          onPress={() => router.push('/recipe-import')}
          className="min-h-[52px] flex-1 flex-row items-center justify-center gap-2 rounded-btn bg-pine px-4 active:opacity-70">
          <Ionicons name="download-outline" size={18} color={palette.pineOn} />
          <Text className="font-label text-[15px] font-semibold text-pine-on">Import a recipe</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="New recipe"
          onPress={() => router.push('/recipe-edit')}
          className="min-h-[52px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline px-4 active:bg-paper-dim">
          <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
            New
          </Text>
        </Pressable>
      </View>

      {/* The capture surface: the well IS the field, so the input is bare.
          The TEXT FIELD carries the 44pt, not the well around it — a 50pt well
          holding a 24pt input looks like a tap target and behaves like a third
          of one, which is the trap the conformance pass caught here. */}
      <View className="mt-3">
        <Block device="well">
          <View className="flex-row items-center gap-2">
            <Ionicons name="search-outline" size={16} color={palette.inkMuted} />
            <TextInput
              accessibilityLabel="Search recipes"
              value={query}
              onChangeText={search}
              placeholder="Search the book"
              placeholderTextColor={palette.inkMuted}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-[44px] flex-1 font-serif text-[15px] text-ink"
            />
          </View>
        </Block>
      </View>

      {/* FOLDERS — a filter strip, never an editor (see the docblock). Chips
          are controls, so no device; the selected one is marked in ink. */}
      <View className="mt-6">
        <SectionLabel label="Folders" />
        <View className="mt-2 flex-row flex-wrap gap-2">
          {folders.length === 0 ? (
            <FolderChip
              label="Organise into folders"
              icon="folder-outline"
              selected={false}
              onPress={() => router.push('/recipe-folders')}
            />
          ) : (
            <>
              <FolderChip
                label="All"
                selected={scope.kind === 'all'}
                onPress={() => rescope({ kind: 'all' })}
              />
              {folders.map((f) => (
                <FolderChip
                  key={f.folder.id}
                  label={f.folder.name}
                  count={f.recipeCount}
                  selected={scope.kind === 'folder' && scope.id === f.folder.id}
                  onPress={() => rescope({ kind: 'folder', id: f.folder.id })}
                />
              ))}
              {unfiled > 0 ? (
                <FolderChip
                  label="Unfiled"
                  count={unfiled}
                  selected={scope.kind === 'unfiled'}
                  onPress={() => rescope({ kind: 'unfiled' })}
                />
              ) : null}
              <FolderChip
                label="Manage"
                icon="create-outline"
                selected={false}
                onPress={() => router.push('/recipe-folders')}
              />
            </>
          )}
        </View>
      </View>

      {/* THE BOOK. The plate goes round the rows, never round the empty
          sentence: a plate closes a record, and an empty book is a sentence on
          the bare sheet under its label. */}
      <View className="mt-6">
        <SectionLabel
          label={searching ? 'Matches' : (scopeName ?? 'Your book')}
          note={recipes.length > 0 ? String(recipes.length) : undefined}
        />
        {recipes.length === 0 ? (
          <View className="mt-2">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {searching
                ? 'Nothing matches.'
                : scopeName !== null
                  ? `Nothing is filed in ${scopeName} yet.`
                  : 'No recipes yet.'}
            </Text>
            {searching || scopeName !== null ? null : (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Share an Instagram reel or TikTok to ARC, paste a link, or save a logged meal as a
                recipe — the book builds itself from what you actually cook.
              </Text>
            )}
            {!searching && scopeName !== null ? (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Open a recipe and tap its folder to file it here.
              </Text>
            ) : null}
          </View>
        ) : (
          <View className="mt-2">
            <Block device="plate">
              {recipes.map((r, index) => {
                const badge = sourceBadge(r);
                const detail = detailLine(r);
                return (
                  <View key={r.recipe.id}>
                    <Divider first={index === 0} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${r.recipe.title}. ${detail}.`}
                      onPress={() =>
                        router.push({ pathname: '/recipe-detail', params: { id: r.recipe.id } })
                      }
                      className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                      {/* A favorite mark is workflow, not biology — neutral ink. */}
                      {r.recipe.is_favorite === 1 ? (
                        <Ionicons name="star" size={14} color={palette.inkSecondary} />
                      ) : null}
                      <View className="flex-1">
                        {/* WEIGHT, not size (owner, 2026-08-15: *"make the
                            names of recipes a bit bolder on the recipe book
                            screen so they stand out a bit more"*). 16px is
                            already the largest thing on the row and the same
                            step every list title in the app sits at, so a
                            bespoke size here would only make the book disagree
                            with the rest of the sheet. Semibold is the step the
                            type scale already has, and it is what `StackHeader`
                            sets a recipe's title in when you open it — so the
                            row and the screen it leads to now speak in the same
                            weight. Nothing else on the row moved: the 10px
                            floor is the standing open item and the detail line
                            stays where it is (00-design-spec.md §4). */}
                        <Text className="font-serif text-[16px] font-semibold leading-5 text-ink">
                          {r.recipe.title}
                        </Text>
                        {/* Every value on this line is measured — kcal, counts,
                            cook tallies — so the whole line is mono. */}
                        <Text className="mt-0.5 font-mono text-[12px] text-ink-secondary">
                          {detail}
                        </Text>
                      </View>
                      {/* A provenance word, not a boxed badge (the protocols
                          call): a border around one word is a mark the reader
                          has to interpret. */}
                      {badge ? (
                        <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                          {badge}
                        </Text>
                      ) : null}
                      <Ionicons name="chevron-forward" size={16} color={palette.inkSecondary} />
                    </Pressable>
                  </View>
                );
              })}
            </Block>
          </View>
        )}
      </View>
    </Screen>
  );
}

/**
 * One chip of the folders strip. A count is a measured value, so it stays mono
 * inside the label (§3's one exception); the selected mark is ink, never the
 * accent, because a filter is not the screen's next action.
 */
function FolderChip({
  label,
  count,
  icon,
  selected,
  onPress,
}: {
  label: string;
  count?: number;
  icon?: 'folder-outline' | 'create-outline';
  selected: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={count === undefined ? label : `${label}, ${count} recipes`}
      accessibilityState={{ selected }}
      onPress={onPress}
      className={
        selected
          ? 'min-h-[44px] flex-row items-center gap-2 rounded-btn border border-ink bg-paper-dim px-3 py-2'
          : 'min-h-[44px] flex-row items-center gap-2 rounded-btn border border-hairline px-3 py-2 active:bg-paper-dim'
      }>
      {icon ? <Ionicons name={icon} size={14} color={palette.inkSecondary} /> : null}
      <Text
        className={
          selected
            ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
            : 'font-label text-[12px] uppercase tracking-[1.2px] text-ink-secondary'
        }>
        {label}
      </Text>
      {count === undefined ? null : (
        <Text className="font-mono text-[11px] text-ink-muted">{count}</Text>
      )}
    </Pressable>
  );
}
