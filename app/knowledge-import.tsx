import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { listKnowledgeTopics, saveKnowledgeEntry } from '@/lib/db/repositories/knowledge';
import {
  importKnowledge,
  isKnowledgeImportAvailable,
  KnowledgeFetchError,
  KnowledgeImportUnavailableError,
  NoKnowledgeFoundError,
  type KnowledgeDraft,
} from '@/lib/knowledge/import';
import { stashKnowledgeDraft } from '@/lib/knowledge/draft-handoff';
import { hostOf } from '@/lib/knowledge/provenance';

/**
 * Article import (docs/knowledge-subapp.md §5): paste a link or the article text
 * → one no-tools model turn compresses what the source COMMITS TO → an EDITABLE
 * review the user must confirm → one-transaction save.
 *
 * Never auto-committed, and never fabricated: a source with nothing substantive
 * in it says so and routes to paste, styled as the next step rather than as an
 * error. That is the same four-beat contract the recipe ladder ships, and the
 * same anti-fabrication rule — third application, after recipes and labs.
 *
 * ## The manual floor is always reachable
 *
 * Every dead end on this screen offers the editor. No key, no network, a
 * paywalled page, a model that returned nothing — the answer is the same and it
 * is never "come back later": write it yourself, and the pasted text (if any) is
 * carried across into the body so nothing the user already did is thrown away.
 *
 * ## Conformed Set surface system (00-design-spec.md §1)
 *
 *   Source   → a **group of labelled fields, no device** — form (b) of the
 *              capture-surface rule (src/components/ui/block.tsx). The field IS
 *              the well; a `well` wrapped round a single-line link field puts
 *              its padding outside the input, so it looks like a 44pt target and
 *              focuses only on its text line (the note app/lab-import.tsx and
 *              app/recipe-import.tsx both carry).
 *   Failure  → **prose on the bare sheet.** A failure here is instructions, not
 *              an alert: the ladder has another rung and the message names it. A
 *              plate around one paragraph would say "record".
 *   Review   → the same field group, editable. The draft is not a record until
 *              it is saved, so it is not drawn as one.
 *
 * **Accent budget: one, per phase, and always the write.** Import while there is
 * something to import; Save once there is something to save. The phases are
 * exclusive — review replaces the whole input ladder — so exactly one pine
 * element is ever on screen. The mode chips and recovery actions are outlined or
 * bare ink: selection is not completion.
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'working'; label: string }
  | { kind: 'review'; draft: KnowledgeDraft }
  | { kind: 'failed'; message: string; suggestPaste: boolean };

type Mode = 'url' | 'text';

const INPUT = 'border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';
/** Whole literals — Tailwind's scanner only sees names that appear in source. */
const INPUT_PASTE =
  'min-h-[180px] leading-6 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';
const INPUT_BODY =
  'min-h-[240px] leading-7 border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';
const CHIP = 'min-h-[44px] justify-center rounded-btn border border-hairline px-3.5';
const CHIP_ON = 'min-h-[44px] justify-center rounded-btn border border-ink bg-ink px-3.5';

export default function KnowledgeImportScreen() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>('url');
  const [url, setUrl] = useState('');
  const [text, setText] = useState('');
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });

  // Review-phase edits. Held separately from the draft so "revert" would be
  // possible and so the draft stays what the model actually said.
  const [title, setTitle] = useState('');
  const [topic, setTopic] = useState('other');
  const [body, setBody] = useState('');
  const [topics] = useState<string[]>(() => listKnowledgeTopics(getDb()));

  const abortRef = useRef<AbortController | null>(null);
  const keySet = isKnowledgeImportAvailable();

  useEffect(() => () => abortRef.current?.abort(), []);

  const fail = (e: unknown) => {
    if (e instanceof NoKnowledgeFoundError) {
      setPhase({ kind: 'failed', message: e.message, suggestPaste: true });
    } else if (e instanceof KnowledgeFetchError) {
      setPhase({
        kind: 'failed',
        message: e.message,
        // 'offline' and 'not-found' are about the link, not the page's content —
        // pasting text the user cannot reach either would not help, so those two
        // route back to the field rather than pretending paste is a fix.
        suggestPaste: e.reason === 'blocked' || e.reason === 'no-content',
      });
    } else if (e instanceof KnowledgeImportUnavailableError) {
      setPhase({ kind: 'failed', message: e.message, suggestPaste: false });
    } else {
      setPhase({
        kind: 'failed',
        message: e instanceof Error ? e.message : 'The import failed.',
        suggestPaste: true,
      });
    }
  };

  const run = async (input: Parameters<typeof importKnowledge>[0], label: string) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'working', label });
    try {
      const draft = await importKnowledge(input, { signal: controller.signal });
      setTitle(draft.title);
      setTopic(draft.topic);
      setBody(draft.body);
      setPhase({ kind: 'review', draft });
    } catch (e) {
      if (!controller.signal.aborted) fail(e);
    }
  };

  /**
   * The manual floor: whatever the user already typed becomes the draft body.
   * The text goes through an in-memory handoff, NOT a route param — a pasted
   * article is arbitrary prose that routinely contains `%`, and params
   * round-trip through URL decoding (see src/lib/knowledge/draft-handoff.ts).
   */
  const toEditor = () => {
    // The URL rides along when the user came down the URL rung, so the spec's
    // "URL into provenance" holds on the floor too (2026-08-13 review fix).
    stashKnowledgeDraft(text, mode === 'url' ? url : null);
    router.replace('/knowledge-entry-edit');
  };

  const save = () => {
    if (phase.kind !== 'review' || title.trim() === '' || body.trim() === '') return;
    const id = saveKnowledgeEntry(getDb(), {
      title,
      topic,
      body,
      source: 'import',
      sourceUrl: phase.draft.source_url,
      sourceAuthor: phase.draft.source_author,
      sourceNote: phase.draft.source_note,
    });
    router.replace({ pathname: '/knowledge-entry', params: { id, kind: 'entry' } });
  };

  const canImport = keySet && (mode === 'url' ? url.trim() !== '' : text.trim().length >= 200);
  const canSave = title.trim() !== '' && body.trim() !== '';

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Import an article" parent="Knowledge" />
      </View>

      {phase.kind === 'review' ? (
        <>
          {/* BEAT THREE. Everything here is editable before anything is stored —
              the model drafted it, the user owns it. */}
          <View className="mt-5">
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              Read it before it saves. This is what the source commits to, in ARC’s voice — edit
              anything that isn’t right.
            </Text>
          </View>

          <View className="mt-6">
            <SectionLabel label="Title" />
            <TextInput
              accessibilityLabel="Title"
              value={title}
              onChangeText={setTitle}
              className={INPUT}
              style={{ marginTop: 8 }}
            />
          </View>

          <View className="mt-6">
            <SectionLabel label="Topic" />
            <View className="mt-2 flex-row flex-wrap gap-2">
              {topics.map((t) => (
                <Pressable
                  key={t}
                  accessibilityRole="button"
                  accessibilityState={{ selected: t === topic }}
                  accessibilityLabel={t}
                  onPress={() => setTopic(t)}
                  className={t === topic ? CHIP_ON : CHIP}>
                  <Text
                    className={
                      t === topic
                        ? 'font-label text-[13px] font-semibold text-paper-hi'
                        : 'font-label text-[13px] font-semibold text-ink-secondary'
                    }>
                    {t}
                  </Text>
                </Pressable>
              ))}
            </View>
            {/* A topic the model coined isn't in the chips yet — the field shows
                it and keeps it editable rather than silently snapping to 'other'. */}
            <TextInput
              accessibilityLabel="Topic"
              value={topic}
              onChangeText={setTopic}
              autoCapitalize="none"
              autoCorrect={false}
              className={INPUT}
              style={{ marginTop: 8 }}
            />
          </View>

          <View className="mt-6">
            <SectionLabel label="The entry" />
            <TextInput
              accessibilityLabel="Entry body"
              value={body}
              onChangeText={setBody}
              multiline
              textAlignVertical="top"
              className={INPUT_BODY}
              style={{ marginTop: 8 }}
            />
          </View>

          {/* Provenance is shown, not edited: it records where the words came
              from, and a hand-edited source URL would be a claim the app can no
              longer stand behind. */}
          <View className="mt-6">
            <SectionLabel label="Provenance" />
            <View className="mt-2">
              <Text className="font-mono text-[11px] leading-5 text-ink-muted">
                {phase.draft.source_url
                  ? `${hostOf(phase.draft.source_url) ?? phase.draft.source_url}${
                      phase.draft.source_author ? ` · ${phase.draft.source_author}` : ''
                    }`
                  : (phase.draft.source_author ?? 'Pasted text — no source link')}
              </Text>
              {phase.draft.source_url ? (
                <Text className="mt-1 font-mono text-[11px] leading-4 text-ink-muted">
                  {phase.draft.source_url}
                </Text>
              ) : null}
              {phase.draft.source_note ? (
                <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-secondary">
                  {phase.draft.source_note}
                </Text>
              ) : null}
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save entry"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            onPress={save}
            className={
              canSave
                ? 'mt-7 min-h-[48px] items-center justify-center rounded-btn bg-pine active:opacity-70'
                : 'mt-7 min-h-[48px] items-center justify-center rounded-btn border border-hairline bg-paper-dim'
            }>
            <Text
              className={
                canSave
                  ? 'font-label text-[15px] font-semibold text-pine-on'
                  : 'font-label text-[15px] font-semibold text-ink-muted'
              }>
              Save entry
            </Text>
          </Pressable>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard and start over"
            onPress={() => setPhase({ kind: 'input' })}
            className="mt-3 min-h-[44px] items-center justify-center active:opacity-60">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Discard
            </Text>
          </Pressable>
        </>
      ) : phase.kind === 'working' ? (
        <View className="mt-10 items-center">
          <ActivityIndicator color={palette.pine} />
          <Text className="mt-4 font-serif text-[14px] text-ink-secondary">{phase.label}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel the import"
            onPress={() => {
              abortRef.current?.abort();
              setPhase({ kind: 'input' });
            }}
            className="mt-6 min-h-[44px] items-center justify-center active:opacity-60">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Cancel
            </Text>
          </Pressable>
        </View>
      ) : (
        <>
          {phase.kind === 'failed' ? (
            // Prose on the bare sheet: instructions, not an alert.
            <View className="mt-5">
              <Text className="font-serif text-[14px] leading-6 text-ink">{phase.message}</Text>
              {phase.suggestPaste ? (
                <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                  Open the article, copy its text, and paste it below — that path doesn’t depend on
                  the site letting ARC read it.
                </Text>
              ) : null}
            </View>
          ) : null}

          {!keySet ? (
            <View className="mt-5">
              <Text className="font-serif text-[14px] leading-6 text-ink">
                Reading an article needs a model key.
              </Text>
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Set one in Settings › Coach. Writing an entry yourself needs nothing at all.
              </Text>
            </View>
          ) : null}

          {/* The two rungs, as a choice rather than a fallback chain: paste is
              first-class UI, not an error state (§5). */}
          <View className="mt-6 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: mode === 'url' }}
              accessibilityLabel="Import from a link"
              onPress={() => setMode('url')}
              className={mode === 'url' ? CHIP_ON : CHIP}>
              <Text
                className={
                  mode === 'url'
                    ? 'font-label text-[13px] font-semibold text-paper-hi'
                    : 'font-label text-[13px] font-semibold text-ink-secondary'
                }>
                From a link
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: mode === 'text' }}
              accessibilityLabel="Paste the article text"
              onPress={() => setMode('text')}
              className={mode === 'text' ? CHIP_ON : CHIP}>
              <Text
                className={
                  mode === 'text'
                    ? 'font-label text-[13px] font-semibold text-paper-hi'
                    : 'font-label text-[13px] font-semibold text-ink-secondary'
                }>
                Paste the text
              </Text>
            </Pressable>
          </View>

          {mode === 'url' ? (
            <View className="mt-5">
              <SectionLabel label="Article link" />
              <TextInput
                accessibilityLabel="Article link"
                value={url}
                onChangeText={setUrl}
                placeholder="https://…"
                placeholderTextColor={palette.inkMuted}
                autoCapitalize="none"
                autoCorrect={false}
                keyboardType="url"
                className={INPUT}
                style={{ marginTop: 8 }}
              />
              <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
                ARC fetches the page once, reads its text, and never stores the page itself. Sites
                behind a paywall or a consent wall won’t hand anything over — paste is the answer
                there.
              </Text>
            </View>
          ) : (
            <View className="mt-5">
              <SectionLabel label="Article text" />
              <TextInput
                accessibilityLabel="Article text"
                value={text}
                onChangeText={setText}
                placeholder="Paste the article here."
                placeholderTextColor={palette.inkMuted}
                multiline
                textAlignVertical="top"
                className={INPUT_PASTE}
                style={{ marginTop: 8 }}
              />
              {text.trim() !== '' && text.trim().length < 200 ? (
                <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
                  That’s a headline’s worth of text. Paste the article body — ARC won’t invent an
                  entry from a title.
                </Text>
              ) : null}
            </View>
          )}

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Read this article"
            accessibilityState={{ disabled: !canImport }}
            disabled={!canImport}
            onPress={() =>
              mode === 'url'
                ? void run({ kind: 'url', url }, 'Fetching and reading the article…')
                : void run({ kind: 'text', text }, 'Reading the text…')
            }
            className={
              canImport
                ? 'mt-7 min-h-[48px] items-center justify-center rounded-btn bg-pine active:opacity-70'
                : 'mt-7 min-h-[48px] items-center justify-center rounded-btn border border-hairline bg-paper-dim'
            }>
            <Text
              className={
                canImport
                  ? 'font-label text-[15px] font-semibold text-pine-on'
                  : 'font-label text-[15px] font-semibold text-ink-muted'
              }>
              Read it
            </Text>
          </Pressable>

          {/* The floor, always drawn, never an apology. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Write the entry yourself instead"
            onPress={toEditor}
            className="mt-3 min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
            <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Write it yourself
            </Text>
          </Pressable>
        </>
      )}
    </Screen>
  );
}
