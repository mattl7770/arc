import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { createRecipe } from '@/lib/db/repositories/recipes';
import {
  importRecipe,
  isRecipeImportAvailable,
  NoRecipeFoundError,
  RecipeFetchError,
  RecipeImportUnavailableError,
  type RecipeDraft,
} from '@/lib/recipes/import';
import { consumeIncomingShare, readSharedImageBase64 } from '@/lib/recipes/incoming-share';

/**
 * Recipe import (docs/recipes-grocery.md §2c): share/paste a URL → the fetch
 * ladder → one no-tools model turn (JSON-LD sites skip the model entirely) →
 * an EDITABLE review the user must confirm — never auto-committed, and never
 * fabricated (a source with no recipe says so and routes to paste/screenshot,
 * styled as intentional next steps, not an error).
 *
 * NATIVE DEP: the screenshot rung's photo pick needs expo-image-picker, loaded
 * through a guarded require (the healthkit.ts seam) — on a binary without it
 * the button explains honestly and the paste rung covers the gap.
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'working'; label: string }
  | { kind: 'review'; draft: RecipeDraft }
  | { kind: 'failed'; message: string; suggestPaste: boolean };

type Mode = 'url' | 'text';

/** Guarded expo-image-picker seam — null until its EAS build ships. */
function loadImagePicker(): {
  launchImageLibraryAsync: (opts: Record<string, unknown>) => Promise<{
    canceled: boolean;
    assets?: { base64?: string | null }[];
  }>;
} | null {
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const mod = require('expo-image-picker') as {
      launchImageLibraryAsync?: unknown;
    };
    if (typeof mod.launchImageLibraryAsync !== 'function') return null;
    return mod as ReturnType<typeof loadImagePicker>;
  } catch {
    return null;
  }
}

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

export default function RecipeImportScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ url?: string }>();
  const paramUrl = typeof params.url === 'string' && params.url.trim() !== '' ? params.url : null;
  // A share-sheet delivery (routed here by app/+native-intent.ts) is consumed
  // once, at state init, and prefills the matching rung — the house pattern of
  // synchronous initializer reads (consumeIncomingShare replays briefly, so a
  // double-run initializer can't lose the share).
  const [incoming] = useState(() => (paramUrl ? null : consumeIncomingShare()));
  const [mode, setMode] = useState<Mode>(incoming?.kind === 'text' ? 'text' : 'url');
  const [url, setUrl] = useState(paramUrl ?? (incoming?.kind === 'url' ? incoming.url : ''));
  const [text, setText] = useState(incoming?.kind === 'text' ? incoming.text : '');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const abortRef = useRef<AbortController | null>(null);
  const keySet = isRecipeImportAvailable();

  useEffect(() => () => abortRef.current?.abort(), []);

  const fail = (e: unknown) => {
    if (e instanceof NoRecipeFoundError) {
      setPhase({ kind: 'failed', message: e.message, suggestPaste: true });
    } else if (e instanceof RecipeFetchError) {
      setPhase({
        kind: 'failed',
        message: e.message,
        suggestPaste:
          e.reason === 'blocked' || e.reason === 'unfetchable' || e.reason === 'no-content',
      });
    } else if (e instanceof RecipeImportUnavailableError) {
      setPhase({ kind: 'failed', message: e.message, suggestPaste: false });
    } else {
      setPhase({
        kind: 'failed',
        message: e instanceof Error ? e.message : 'The import failed.',
        suggestPaste: true,
      });
    }
  };

  const run = async (input: Parameters<typeof importRecipe>[0], label: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'working', label });
    try {
      const draft = await importRecipe(input, { signal: controller.signal });
      setPhase({ kind: 'review', draft });
    } catch (e) {
      if (!controller.signal.aborted) fail(e);
    }
  };

  // A URL (route param or URL share) starts the ladder immediately; a shared
  // screenshot starts the vision rung. Text shares were prefilled at init and
  // wait for the user's Import tap.
  const autoRan = useRef(false);
  useEffect(() => {
    if (autoRan.current) return;
    autoRan.current = true;
    // Deferred a microtask so the first setPhase never lands synchronously
    // inside the effect (the React Compiler cascading-render rule).
    queueMicrotask(() => {
      const startUrl = paramUrl ?? (incoming?.kind === 'url' ? incoming.url : null);
      if (startUrl) {
        void run({ kind: 'url', url: startUrl }, 'Reading the link…');
        return;
      }
      if (incoming?.kind === 'photo') {
        void (async () => {
          const base64 = await readSharedImageBase64(incoming.uri);
          if (base64) void run({ kind: 'photo', base64Jpeg: base64 }, 'Reading the screenshot…');
          else {
            setPhase({
              kind: 'failed',
              message: 'Couldn’t read the shared image — paste the recipe text instead.',
              suggestPaste: true,
            });
          }
        })();
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const pickScreenshot = async () => {
    const picker = loadImagePicker();
    if (!picker) {
      setPhase({
        kind: 'failed',
        message:
          'Photo import needs the next app build (expo-image-picker isn’t in this one yet). Paste the recipe text instead.',
        suggestPaste: true,
      });
      return;
    }
    const result = await picker.launchImageLibraryAsync({
      mediaTypes: ['images'],
      quality: 0.7,
      base64: true,
    });
    const base64 = result.assets?.[0]?.base64;
    if (result.canceled || !base64) return;
    void run({ kind: 'photo', base64Jpeg: base64 }, 'Reading the screenshot…');
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Import a recipe" />
      </View>

      {phase.kind === 'review' ? (
        <ReviewDraft
          draft={phase.draft}
          onSaved={(id) => router.replace({ pathname: '/recipe-detail', params: { id } })}
        />
      ) : (
        <>
          {/* Mode toggle: link vs pasted text. */}
          <View className="mt-2 flex-row gap-2">
            {(
              [
                ['url', 'From a link'],
                ['text', 'Paste text'],
              ] as [Mode, string][]
            ).map(([m, label]) => (
              <Pressable
                key={m}
                accessibilityRole="button"
                accessibilityLabel={label}
                accessibilityState={{ selected: mode === m }}
                onPress={() => setMode(m)}
                className={`rounded-btn border px-3.5 py-2 ${
                  mode === m
                    ? 'border-hairline-strong bg-paper-deep'
                    : 'border-hairline active:bg-paper-deep'
                }`}>
                <Text
                  className={`text-[13px] ${mode === m ? 'font-semibold text-ink' : 'text-ink-secondary'}`}>
                  {label}
                </Text>
              </Pressable>
            ))}
          </View>

          {mode === 'url' ? (
            <View className="mt-3">
              <TextInput
                accessibilityLabel="Recipe link"
                value={url}
                onChangeText={setUrl}
                placeholder="instagram.com/reel/… · tiktok.com/… · any recipe site"
                placeholderTextColor={palette.inkMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                className="rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[14px] text-ink"
              />
              <Text className="mt-2 text-[12px] leading-5 text-ink-muted">
                Or share straight from Instagram/TikTok/Safari to ARC (needs the next app build).
                Recipe sites import without any AI; social captions run through the Coach’s model.
              </Text>
            </View>
          ) : (
            <View className="mt-3">
              <TextInput
                accessibilityLabel="Recipe text"
                value={text}
                onChangeText={setText}
                placeholder="Paste the caption or recipe text (tap the caption → copy)"
                placeholderTextColor={palette.inkMuted}
                multiline
                className="min-h-36 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[14px] leading-6 text-ink"
              />
            </View>
          )}

          {phase.kind === 'working' ? (
            <View className="mt-6 flex-row items-center gap-3">
              <ActivityIndicator color={palette.pine} />
              <Text className="text-[13px] text-ink-secondary">{phase.label}</Text>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Import"
              accessibilityState={{
                disabled: mode === 'url' ? url.trim() === '' : text.trim() === '',
              }}
              disabled={mode === 'url' ? url.trim() === '' : text.trim() === ''}
              onPress={() =>
                mode === 'url'
                  ? void run({ kind: 'url', url }, 'Reading the link…')
                  : void run({ kind: 'text', text }, 'Reading the recipe…')
              }
              className={`mt-4 items-center justify-center rounded-btn py-3 ${
                (mode === 'url' ? url.trim() : text.trim()) === ''
                  ? 'bg-hairline'
                  : 'bg-pine active:opacity-70'
              }`}>
              <Text
                className={`text-[14px] font-semibold ${
                  (mode === 'url' ? url.trim() : text.trim()) === ''
                    ? 'text-ink-muted'
                    : 'text-pine-on'
                }`}>
                Import
              </Text>
            </Pressable>
          )}

          {phase.kind === 'failed' ? (
            <View className="mt-5 rounded-card border border-hairline bg-porcelain p-4">
              <Text className="text-[13px] leading-5 text-ink">{phase.message}</Text>
              {phase.suggestPaste ? (
                <View className="mt-3 flex-row gap-2">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Paste the caption instead"
                    onPress={() => {
                      setMode('text');
                      setPhase({ kind: 'input' });
                    }}
                    className="rounded-btn border border-hairline-strong px-3.5 py-2 active:bg-paper-deep">
                    <Text className="text-[13px] text-ink">Paste the caption</Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Import from a screenshot"
                    onPress={() => void pickScreenshot()}
                    className="rounded-btn border border-hairline-strong px-3.5 py-2 active:bg-paper-deep">
                    <Text className="text-[13px] text-ink">From a screenshot</Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}

          {!keySet ? (
            <Text className="mt-6 text-[12px] leading-5 text-ink-muted">
              No model key is set (Settings → Coach), so only recipe sites with structured data will
              import — captions and screenshots need the model.
            </Text>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Import from a screenshot"
              onPress={() => void pickScreenshot()}
              className="mt-6 flex-row items-center gap-2 active:opacity-60">
              <Ionicons name="image-outline" size={16} color={palette.inkSecondary} />
              <Text className="text-[13px] text-ink-secondary">Import from a screenshot</Text>
            </Pressable>
          )}
        </>
      )}
    </Screen>
  );
}

/** The editable review — nothing writes until Save. */
/** A review line: raw text + the extraction's qty/unit/name overlay. Editing
 * the text marks it touched, which drops the overlay so the repo re-parses —
 * an untouched line keeps overlays only the model could produce ("two cups"). */
type ReviewLine = {
  raw: string;
  qty: number | null | undefined;
  unit: string | null | undefined;
  name: string | null | undefined;
  touched: boolean;
};

function ReviewDraft({ draft, onSaved }: { draft: RecipeDraft; onSaved: (id: string) => void }) {
  const [title, setTitle] = useState(draft.title);
  const [servings, setServings] = useState(draft.servings !== null ? String(draft.servings) : '');
  const [lines, setLines] = useState<ReviewLine[]>(
    draft.ingredients.map((i) => ({
      raw: i.raw_text,
      qty: i.qty,
      unit: i.unit,
      name: i.name,
      touched: false,
    }))
  );
  const [stepsText, setStepsText] = useState(draft.steps.join('\n'));

  const parsedServings = Number(servings);
  const canSave =
    title.trim() !== '' &&
    Number.isFinite(parsedServings) &&
    parsedServings > 0 &&
    lines.some((l) => l.raw.trim() !== '');

  const save = () => {
    if (!canSave) return;
    const id = createRecipe(getDb(), {
      title: title.trim(),
      source: 'import',
      source_url: draft.source_url,
      source_platform: draft.source_platform,
      source_author: draft.source_author,
      source_image_url: draft.source_image_url,
      servings: parsedServings,
      prep_min: draft.prep_min,
      cook_min: draft.cook_min,
      steps: stepsText
        .split('\n')
        .map((s) => s.trim())
        .filter((s) => s !== ''),
      notes: draft.notes,
      ingredients: lines
        .filter((l) => l.raw.trim() !== '')
        .map((l) =>
          l.touched
            ? { raw_text: l.raw.trim() }
            : { raw_text: l.raw.trim(), qty: l.qty, unit: l.unit, name: l.name }
        ),
    });
    onSaved(id);
  };

  return (
    <View className="mt-2">
      <View className="flex-row items-center gap-2">
        <SectionLabel>Review before saving</SectionLabel>
        {draft.deterministic ? (
          <Text className="text-[10px] uppercase tracking-[1px] text-ink-muted">
            no AI · site data
          </Text>
        ) : (
          <Text className="text-[10px] uppercase tracking-[1px] text-ink-muted">≈ extracted</Text>
        )}
      </View>
      {draft.source_author || draft.source_platform ? (
        <Text className="mt-1 text-[12px] text-ink-muted">
          {[draft.source_author, draft.source_platform].filter(Boolean).join(' · ')}
        </Text>
      ) : null}

      <TextInput
        accessibilityLabel="Title"
        value={title}
        onChangeText={setTitle}
        className="mt-3 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink"
      />
      <View className="mt-2 w-32">
        <Text className="text-[10px] uppercase tracking-[1px] text-ink-muted">Servings</Text>
        <TextInput
          accessibilityLabel="Servings"
          value={servings}
          onChangeText={setServings}
          keyboardType="decimal-pad"
          placeholder="4"
          placeholderTextColor={palette.inkMuted}
          className="mt-1 rounded-btn border border-hairline-soft bg-paper-deep px-2.5 py-2 text-center font-mono text-[14px] text-ink"
        />
        {draft.servings === null ? (
          <Text className="mt-1 text-[11px] text-ink-muted">The source didn’t say — set it.</Text>
        ) : null}
      </View>

      <View className="mt-5">
        <SectionLabel>Ingredients</SectionLabel>
        {lines.map((line, index) => (
          <View key={index} className="mt-2 flex-row items-center gap-2">
            <TextInput
              accessibilityLabel={`Ingredient ${index + 1}`}
              value={line.raw}
              onChangeText={(t) =>
                setLines((prev) =>
                  prev.map((l, i) => (i === index ? { ...l, raw: t, touched: true } : l))
                )
              }
              autoCapitalize="none"
              className="flex-1 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-2.5 text-[14px] text-ink"
            />
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Remove ingredient ${index + 1}`}
              onPress={() => setLines((prev) => prev.filter((_, i) => i !== index))}
              hitSlop={8}
              className="active:opacity-60">
              <Ionicons name="close-circle-outline" size={20} color={palette.inkMuted} />
            </Pressable>
          </View>
        ))}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Add an ingredient line"
          onPress={() =>
            setLines((prev) => [
              ...prev,
              { raw: '', qty: undefined, unit: undefined, name: undefined, touched: true },
            ])
          }
          className="mt-2 flex-row items-center gap-2 active:opacity-60">
          <Ionicons name="add" size={16} color={palette.inkSecondary} />
          <Text className="text-[13px] text-ink-secondary">Add a line</Text>
        </Pressable>
      </View>

      <View className="mt-5">
        <SectionLabel>Steps — one per line</SectionLabel>
        <TextInput
          accessibilityLabel="Steps"
          value={stepsText}
          onChangeText={setStepsText}
          multiline
          className="mt-2 min-h-28 rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[14px] leading-6 text-ink"
        />
      </View>

      {draft.notes ? (
        <Text className="mt-4 text-[12px] leading-5 text-ink-muted">≈ {draft.notes}</Text>
      ) : null}

      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save to the recipe book"
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={`mt-6 items-center justify-center rounded-btn py-3 ${
          canSave ? 'bg-pine active:opacity-70' : 'bg-hairline'
        }`}>
        <Text
          className={`text-[14px] font-semibold ${canSave ? 'text-pine-on' : 'text-ink-muted'}`}>
          Save to the book
        </Text>
      </Pressable>
    </View>
  );
}
