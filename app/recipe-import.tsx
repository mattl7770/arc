import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { createRecipe } from '@/lib/db/repositories/recipes';
import { pickPhotoBase64 } from '@/lib/media/photo-library';
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
 * NATIVE DEP: the screenshot rung picks through `pickPhotoBase64`
 * (src/lib/media/photo-library.ts), which wraps `expo-image-picker` in the
 * healthkit.ts guarded-require seam and downscales what it returns. On a binary
 * without the module the result is `unavailable` — a sentence, never a crash —
 * and the paste rung covers the gap.
 *
 * ## Conformed Set surface system (00-design-spec.md §1)
 *
 *   Source        → a **group of labelled fields, no device**: form (b) of the
 *                   capture-surface rule in src/components/ui/block.tsx. The
 *                   field IS the well — `border-paper-deep bg-paper-dim` on the
 *                   `TextInput` itself — rather than a `well` wrapped round it,
 *                   because a well puts its padding OUTSIDE the input and the
 *                   single-line link field would then look like a 44pt target
 *                   while only its text line focused on tap (the note
 *                   app/lab-import.tsx carries, for the same reason).
 *   Failure       → **prose on the bare sheet** (margin annotation, which draws
 *                   nothing). A failure here is a set of instructions, not an
 *                   alert: the ladder has more rungs and the message names the
 *                   next one. A plate round one paragraph would say "record".
 *   Ingredients   → **ruled plate**: the draft's ingredient list is a record,
 *                   and a record is a table — rows ruled by `Divider`, with the
 *                   "Add a line" action as the plate's trailing row.
 *
 * **Accent budget: one, per phase, and always the write.** Import while there is
 * something to import, Save once there is something to save. The phases are
 * exclusive — the review replaces the whole input ladder — so exactly one pine
 * element is ever on screen. The mode chips, the recovery actions and the
 * screenshot rung are outlined or bare ink; selection is not completion.
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'working'; label: string }
  | { kind: 'review'; draft: RecipeDraft }
  | { kind: 'failed'; message: string; suggestPaste: boolean };

type Mode = 'url' | 'text';

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

  /**
   * The screenshot rung. Every branch of `PickedPhoto` is answered: a cancel is
   * not an error and says nothing, an absent module and an unreadable image both
   * become failure prose that routes to the paste rung.
   */
  const pickScreenshot = async () => {
    const picked = await pickPhotoBase64();
    if (picked.kind === 'canceled') return;
    if (picked.kind === 'unavailable') {
      setPhase({
        kind: 'failed',
        message:
          'Photo import needs the next app build (expo-image-picker isn’t in this one yet). Paste the recipe text instead.',
        suggestPaste: true,
      });
      return;
    }
    if (picked.kind === 'failed') {
      setPhase({
        kind: 'failed',
        message: 'Couldn’t read that image — paste the recipe text instead.',
        suggestPaste: true,
      });
      return;
    }
    void run({ kind: 'photo', base64Jpeg: picked.base64Jpeg }, 'Reading the screenshot…');
  };

  const ready = (mode === 'url' ? url.trim() : text.trim()) !== '';

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
          {/* SOURCE — the two rungs the user can start by hand, and the field
              for whichever is chosen. One section, because a link and a pasted
              caption are two forms of the same answer. */}
          <View className="mt-5">
            <SectionLabel label="Source" />

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
                  className={
                    mode === m
                      ? 'min-h-[44px] items-center justify-center rounded-btn border border-ink bg-paper-dim px-4'
                      : 'min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 active:opacity-60'
                  }>
                  <Text
                    className={
                      mode === m
                        ? 'font-label text-[11px] font-semibold uppercase tracking-[1.2px] text-ink'
                        : 'font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary'
                    }>
                    {label}
                  </Text>
                </Pressable>
              ))}
            </View>

            {mode === 'url' ? (
              <View>
                {/* Mono: a URL is a machine string, not speech — the same call
                    app/lab-import.tsx makes for a picked filename. */}
                <TextInput
                  accessibilityLabel="Recipe link"
                  value={url}
                  onChangeText={setUrl}
                  placeholder="instagram.com/reel/… · tiktok.com/… · any recipe site"
                  placeholderTextColor={palette.inkMuted}
                  autoCapitalize="none"
                  autoCorrect={false}
                  keyboardType="url"
                  className="mt-3 min-h-[46px] border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[13px] text-ink"
                />
                <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                  Or share straight from Instagram/TikTok/Safari to ARC (needs the next app build).
                  Recipe sites import without any AI; social captions run through the Coach’s model.
                </Text>
              </View>
            ) : (
              <TextInput
                accessibilityLabel="Recipe text"
                value={text}
                onChangeText={setText}
                placeholder="Paste the caption or recipe text (tap the caption → copy)"
                placeholderTextColor={palette.inkMuted}
                multiline
                className="mt-3 min-h-[144px] border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] leading-6 text-ink"
              />
            )}
          </View>

          {/* The one accent of this phase — replaced by the working reading
              while the ladder runs, so the accent never marks a dead control. */}
          {phase.kind === 'working' ? (
            <View className="mt-6 flex-row items-center justify-center gap-3">
              <ActivityIndicator color={palette.ink} />
              <Text className="font-serif text-[14px] text-ink-secondary">{phase.label}</Text>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Import"
              accessibilityState={{ disabled: !ready }}
              disabled={!ready}
              onPress={() =>
                mode === 'url'
                  ? void run({ kind: 'url', url }, 'Reading the link…')
                  : void run({ kind: 'text', text }, 'Reading the recipe…')
              }
              className={
                ready
                  ? 'mt-5 min-h-[48px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70'
                  : 'mt-5 min-h-[48px] items-center justify-center rounded-btn border border-paper-deep py-3'
              }>
              <Text
                className={
                  ready
                    ? 'font-label text-[15px] font-semibold text-pine-on'
                    : 'font-label text-[15px] font-semibold text-ink-muted'
                }>
                Import
              </Text>
            </Pressable>
          )}

          {/* A failure is typeset, not boxed: the sentence says what happened,
              and the two rungs that still work sit under it as controls. */}
          {phase.kind === 'failed' ? (
            <View className="mt-6">
              <Block device="margin">
                <Text className="font-serif text-[14px] leading-6 text-ink">{phase.message}</Text>
              </Block>
              {phase.suggestPaste ? (
                <View className="mt-3 flex-row gap-2">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Paste the caption instead"
                    onPress={() => {
                      setMode('text');
                      setPhase({ kind: 'input' });
                    }}
                    className="min-h-[46px] flex-1 items-center justify-center rounded-btn border border-hairline px-3 py-3 active:bg-paper-dim">
                    <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink">
                      Paste the caption
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Import from a screenshot"
                    onPress={() => void pickScreenshot()}
                    className="min-h-[46px] flex-1 items-center justify-center rounded-btn border border-hairline px-3 py-3 active:bg-paper-dim">
                    <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink">
                      From a screenshot
                    </Text>
                  </Pressable>
                </View>
              ) : null}
            </View>
          ) : null}

          {!keySet ? (
            <View className="mt-7">
              <Block device="margin">
                <Text className="font-serif text-[13px] leading-5 text-ink-muted">
                  No model key is set (Settings → Coach), so only recipe sites with structured data
                  will import — captions and screenshots need the model.
                </Text>
              </Block>
            </View>
          ) : (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Import from a screenshot"
              onPress={() => void pickScreenshot()}
              className="mt-7 min-h-[46px] flex-row items-center gap-2 active:opacity-60">
              <Ionicons name="image-outline" size={17} color={palette.inkSecondary} />
              <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-secondary">
                Import from a screenshot
              </Text>
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

/**
 * What Save will actually write. Blank lines are dropped on save, so a tally of
 * the drawn rows would overstate it; when the two differ the note says both
 * numbers rather than quietly picking one (00-design-spec.md §5).
 */
function ingredientNote(lines: ReviewLine[]): string {
  const kept = lines.filter((l) => l.raw.trim() !== '').length;
  if (kept === lines.length) return `${kept} line${kept === 1 ? '' : 's'}`;
  return `${kept} of ${lines.length} lines`;
}

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
    <View className="mt-5">
      {/* The provenance eyebrow rides the section label's own baseline — an
          eyebrow is the label voice, and it states how the draft was produced
          rather than measuring anything. */}
      <SectionLabel
        label="Review before saving"
        accessory={
          <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
            {draft.deterministic ? 'no AI · site data' : '≈ extracted'}
          </Text>
        }
      />
      {draft.source_author || draft.source_platform ? (
        <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
          {[draft.source_author, draft.source_platform].filter(Boolean).join(' · ')}
        </Text>
      ) : null}

      <View className="mt-5">
        <SectionLabel label="Title" />
        <TextInput
          accessibilityLabel="Title"
          value={title}
          onChangeText={setTitle}
          className="mt-2 min-h-[46px] border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[16px] text-ink"
        />
      </View>

      <View className="mt-5">
        <View className="w-32">
          <SectionLabel label="Servings" />
          <TextInput
            accessibilityLabel="Servings"
            value={servings}
            onChangeText={setServings}
            keyboardType="decimal-pad"
            placeholder="4"
            placeholderTextColor={palette.inkMuted}
            className="mt-2 min-h-[46px] border border-paper-deep bg-paper-dim px-2.5 py-2 text-center font-mono text-[15px] text-ink"
          />
        </View>
        {draft.servings === null ? (
          <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
            The source didn’t say — set it.
          </Text>
        ) : null}
      </View>

      {/* The draft's ingredient list is a record, so it is a plate — rows ruled
          between, and the add action as the plate's trailing row.

          EXCEPT when every line has been removed. A plate closes a record, and
          an empty draft is not one: it would be a box around a label and a
          single control, which is the shape the plate rule exists to forbid
          (docs/decisions.md, 2026-08-10 §1a). The label, the authored sentence
          and the add action then sit bare on the sheet — and with no rows, the
          unconditional Divider below would have drawn a rule under the label
          with nothing above it to separate. */}
      {lines.length === 0 ? (
        <View className="mt-7">
          <SectionLabel label="Ingredients" />
          <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
            No lines left — add one, or save the recipe without them.
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add an ingredient line"
            onPress={() =>
              setLines((prev) => [
                ...prev,
                { raw: '', qty: undefined, unit: undefined, name: undefined, touched: true },
              ])
            }
            className="mt-3 min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
            <Ionicons name="add" size={16} color={palette.inkSecondary} />
            <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
              Add a line
            </Text>
          </Pressable>
        </View>
      ) : (
        <View className="mt-7">
          <Block device="plate">
            <SectionLabel label="Ingredients" note={ingredientNote(lines)} />
            <View className="mt-1">
              {lines.map((line, index) => (
                <View key={index}>
                  <Divider first={index === 0} />
                  <View className="min-h-[46px] flex-row items-center gap-2 py-2">
                    <TextInput
                      accessibilityLabel={`Ingredient ${index + 1}`}
                      value={line.raw}
                      onChangeText={(t) =>
                        setLines((prev) =>
                          prev.map((l, i) => (i === index ? { ...l, raw: t, touched: true } : l))
                        )
                      }
                      autoCapitalize="none"
                      className="min-h-[44px] flex-1 border border-paper-deep bg-paper-dim px-3 py-2 font-serif text-[15px] leading-5 text-ink"
                    />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Remove ingredient ${index + 1}`}
                      onPress={() => setLines((prev) => prev.filter((_, i) => i !== index))}
                      hitSlop={12}
                      className="h-11 w-11 items-center justify-center active:opacity-60">
                      <Ionicons name="close-circle-outline" size={20} color={palette.inkMuted} />
                    </Pressable>
                  </View>
                </View>
              ))}
              {/* Unconditional rule: the row above always exists — either an
                ingredient row or the section label. */}
              <Divider />
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add an ingredient line"
                onPress={() =>
                  setLines((prev) => [
                    ...prev,
                    { raw: '', qty: undefined, unit: undefined, name: undefined, touched: true },
                  ])
                }
                className="min-h-[46px] flex-row items-center gap-2 py-3 active:opacity-60">
                <Ionicons name="add" size={16} color={palette.inkSecondary} />
                <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-secondary">
                  Add a line
                </Text>
              </Pressable>
            </View>
          </Block>
        </View>
      )}

      <View className="mt-7">
        <SectionLabel label="Steps — one per line" />
        <TextInput
          accessibilityLabel="Steps"
          value={stepsText}
          onChangeText={setStepsText}
          multiline
          className="mt-2 min-h-[112px] border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] leading-6 text-ink"
        />
      </View>

      {draft.notes ? (
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-muted">≈ {draft.notes}</Text>
          </Block>
        </View>
      ) : null}

      {/* The one accent of the review phase: the write. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save to the recipe book"
        accessibilityState={{ disabled: !canSave }}
        disabled={!canSave}
        onPress={save}
        className={
          canSave
            ? 'mt-7 min-h-[48px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70'
            : 'mt-7 min-h-[48px] items-center justify-center rounded-btn border border-paper-deep py-3'
        }>
        <Text
          className={
            canSave
              ? 'font-label text-[15px] font-semibold text-pine-on'
              : 'font-label text-[15px] font-semibold text-ink-muted'
          }>
          Save to the book
        </Text>
      </Pressable>
    </View>
  );
}
