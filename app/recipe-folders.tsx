import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  createFolder,
  deleteFolder,
  listFolders,
  renameFolder,
  unfiledRecipeCount,
} from '@/lib/db/repositories/recipes';
import type { RecipeFolderSummary } from '@/lib/recipes/types';

/**
 * The recipe book's filing cabinet (0035) — create a drawer, relabel one,
 * remove one.
 *
 * Owner request, 2026-08-12: *"Make functionality for creating folders in the
 * recipe book."*
 *
 * ## Why management is its own screen
 *
 * The book BROWSES and this screen ADMINISTERS, and the two want opposite
 * things on screen. Browsing wants folders as a quiet one-tap filter above the
 * list; administering wants a rename field and an armed delete on every row.
 * Putting both in app/recipes.tsx would have meant an edit mode toggling the
 * meaning of every folder row — which is how a filter turns into a destructive
 * control under the same finger.
 *
 * So the book carries the filter and one quiet way in here, and this screen
 * owns the three verbs. It is reached from the book and from a recipe's own
 * folder picker.
 *
 * ## Deleting a folder never deletes a recipe
 *
 * The FK is `ON DELETE SET NULL` (0035), so removing a drawer UNFILES what was
 * in it — every recipe survives whole and lands in Unfiled, which the book
 * shows by default. The armed state says that in words before the second tap,
 * because "delete the folder with my 12 dinners in it" is a sentence a user
 * will read as a threat unless told otherwise.
 *
 * ## Conformed Set surface system
 *
 *   New folder → **recessed well** wrapping a BARE input (form (a)) with the
 *                add action docked in it as a stamp — the
 *                log/command-field.tsx precedent, and this screen's one accent.
 *   The list   → **ruled plate**: the drawers are a record, and a record is a
 *                table. Rows ruled by `Divider`, never `border-t`.
 *   Consequence→ **margin annotation** for the armed delete's sentence.
 */

type Loaded = {
  folders: RecipeFolderSummary[];
  unfiled: number;
};

function load(): Loaded {
  const db = getDb();
  return { folders: listFolders(db), unfiled: unfiledRecipeCount(db) };
}

export default function RecipeFoldersScreen() {
  const router = useRouter();
  const [data, setData] = useState<Loaded>(load);
  const [entry, setEntry] = useState('');
  /** The folder whose row is open for renaming. */
  const [editingId, setEditingId] = useState<string | null>(null);
  /** The folder armed for deletion — two taps, like every destructive control
   *  in this set. */
  const [deleteArmed, setDeleteArmed] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = useCallback(() => {
    setData(load());
    setDeleteArmed(null);
  }, []);
  useFocusEffect(reload);

  const add = () => {
    const name = entry.trim();
    if (name === '') return;
    try {
      createFolder(getDb(), name);
      setEntry('');
      setError(null);
      reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Couldn’t create that folder.');
    }
  };

  const canAdd = entry.trim() !== '';

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Folders" parent="Recipes" />
      </View>

      {/* NEW FOLDER — the capture surface, and this screen's one accent. The
          input is bare: the well is its stock. */}
      <View className="mt-5">
        <Block device="well">
          <View className="flex-row items-end gap-2.5">
            <View className="min-h-[44px] flex-1 justify-center">
              <TextInput
                accessibilityLabel="New folder name"
                value={entry}
                onChangeText={setEntry}
                onSubmitEditing={add}
                placeholder="New folder"
                placeholderTextColor={palette.inkMuted}
                autoCorrect={false}
                returnKeyType="done"
                className="py-2 font-serif text-[15px] leading-5 text-ink"
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Create folder"
              accessibilityState={{ disabled: !canAdd }}
              disabled={!canAdd}
              onPress={add}
              className={
                canAdd
                  ? 'h-11 w-11 items-center justify-center rounded-btn bg-pine active:opacity-70'
                  : 'h-11 w-11 items-center justify-center rounded-btn border border-paper-deep'
              }>
              <Ionicons name="add" size={22} color={palette.pineOn} />
            </Pressable>
          </View>
        </Block>
      </View>

      {error ? (
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">{error}</Text>
      ) : null}

      <View className="mt-6">
        <SectionLabel
          label="Drawers"
          note={data.folders.length > 0 ? String(data.folders.length) : undefined}
        />
        {data.folders.length === 0 ? (
          <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
            No folders yet. Every recipe sits in the book unfiled, which is a perfectly good place
            for it until there are enough of them to sort.
          </Text>
        ) : (
          <View className="mt-2">
            <Block device="plate">
              {data.folders.map((summary, index) => (
                <FolderRow
                  // The key carries the name and the open/closed state, not
                  // just the id: `FolderRow` seeds its rename field from the
                  // prop once, and without this a name typed and then abandoned
                  // by collapsing the row would still be sitting there — and
                  // committed — the next time it was opened.
                  key={`${summary.folder.id}:${summary.folder.name}:${
                    editingId === summary.folder.id
                  }`}
                  summary={summary}
                  first={index === 0}
                  editing={editingId === summary.folder.id}
                  armed={deleteArmed === summary.folder.id}
                  onToggleEdit={() => {
                    setEditingId(editingId === summary.folder.id ? null : summary.folder.id);
                    // Collapsing a row disarms its pending delete: the row is
                    // remounted on the next expand (the key embeds editingId),
                    // and a surviving deleteArmed would bring it back already
                    // reading "Confirm delete" — one tap from deleting, past the
                    // two-tap safety this screen documents.
                    setDeleteArmed(null);
                  }}
                  onArm={() =>
                    setDeleteArmed(deleteArmed === summary.folder.id ? null : summary.folder.id)
                  }
                  onDelete={() => {
                    deleteFolder(getDb(), summary.folder.id);
                    setEditingId(null);
                    reload();
                  }}
                  onRenamed={() => {
                    setEditingId(null);
                    setError(null);
                    reload();
                  }}
                  onError={setError}
                  // REPLACE, not push: this screen has done its job the moment
                  // a drawer is chosen, so it steps out of the way and the
                  // scoped book takes its place. Back therefore returns to the
                  // UNSCOPED book — one step, and not back through the cabinet.
                  // (It is a replace and not a `back()` because the scope lives
                  // in the book's own state, and only a fresh mount reads the
                  // `folder` param.)
                  onOpen={() =>
                    router.replace({ pathname: '/recipes', params: { folder: summary.folder.id } })
                  }
                />
              ))}
            </Block>
          </View>
        )}
      </View>

      {/* Unfiled is a place, so it is listed like one — and it is the reason a
          folder can be deleted without fear. */}
      <View className="mt-4">
        <Block device="margin">
          <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
            {data.unfiled === 0
              ? 'Every recipe is filed.'
              : `${data.unfiled} recipe${data.unfiled === 1 ? '' : 's'} ${
                  data.unfiled === 1 ? 'is' : 'are'
                } unfiled. Unfiled is a place, not a backlog — the book shows every recipe by default.`}
          </Text>
        </Block>
      </View>
    </Screen>
  );
}

/** One drawer: name · count, opening to a rename field and an armed delete. */
function FolderRow({
  summary,
  first,
  editing,
  armed,
  onToggleEdit,
  onArm,
  onDelete,
  onRenamed,
  onError,
  onOpen,
}: {
  summary: RecipeFolderSummary;
  first: boolean;
  editing: boolean;
  armed: boolean;
  onToggleEdit: () => void;
  onArm: () => void;
  onDelete: () => void;
  onRenamed: () => void;
  onError: (message: string) => void;
  onOpen: () => void;
}) {
  const [name, setName] = useState(summary.folder.name);

  const rename = () => {
    const trimmed = name.trim();
    if (trimmed === '' || trimmed === summary.folder.name) {
      onRenamed();
      return;
    }
    try {
      renameFolder(getDb(), summary.folder.id, trimmed);
      onRenamed();
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Couldn’t rename that folder.');
    }
  };

  return (
    <View>
      <Divider first={first} />
      <View className="min-h-[46px] flex-row items-center gap-3 py-3">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open ${summary.folder.name}`}
          onPress={onOpen}
          className="flex-1 active:opacity-60">
          <Text className="font-serif text-[16px] leading-5 text-ink">{summary.folder.name}</Text>
          <Text className="mt-0.5 font-mono text-[12px] text-ink-secondary">
            {summary.recipeCount} recipe{summary.recipeCount === 1 ? '' : 's'}
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Rename or delete ${summary.folder.name}`}
          accessibilityState={{ expanded: editing }}
          onPress={onToggleEdit}
          hitSlop={8}
          className="h-11 w-11 items-center justify-center active:opacity-60">
          <Ionicons
            name={editing ? 'chevron-up' : 'ellipsis-horizontal'}
            size={16}
            color={palette.inkSecondary}
          />
        </Pressable>
      </View>
      {editing ? (
        <View>
          <Divider />
          <View className="pb-4 pt-3">
            <View className="flex-row items-center gap-2">
              <TextInput
                accessibilityLabel={`Name for ${summary.folder.name}`}
                value={name}
                onChangeText={setName}
                onSubmitEditing={rename}
                autoCorrect={false}
                returnKeyType="done"
                className="min-h-[44px] flex-1 border border-paper-deep bg-paper-dim px-3 py-2 font-serif text-[15px] text-ink"
              />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Save the folder name"
                onPress={rename}
                className="min-h-[44px] items-center justify-center rounded-btn border border-ink px-4 active:opacity-70">
                <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
                  Rename
                </Text>
              </Pressable>
            </View>
            {armed ? (
              <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">
                {summary.recipeCount === 0
                  ? 'Removes the folder. It holds nothing.'
                  : `Removes the folder. Its ${summary.recipeCount} recipe${
                      summary.recipeCount === 1 ? '' : 's'
                    } ${summary.recipeCount === 1 ? 'stays' : 'stay'} in the book, unfiled.`}
              </Text>
            ) : null}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={
                armed
                  ? `Tap again to delete ${summary.folder.name}`
                  : `Delete ${summary.folder.name}`
              }
              onPress={armed ? onDelete : onArm}
              className="mt-3 min-h-[44px] items-center justify-center active:opacity-60">
              <Text
                className={
                  armed
                    ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
                    : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                }>
                {armed ? 'Confirm delete' : 'Delete folder'}
              </Text>
            </Pressable>
          </View>
        </View>
      ) : null}
    </View>
  );
}
