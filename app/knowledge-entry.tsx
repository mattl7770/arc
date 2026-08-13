import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Linking, Pressable, Text, View } from 'react-native';

import { DashedDivider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  archiveKnowledgeEntry,
  getKnowledgeEntry,
  getPackEntry,
  restoreKnowledgeEntry,
  type KnowledgeEntryRow,
  type PackEntry,
} from '@/lib/db/repositories/knowledge';
import { provenanceFooter } from '@/lib/knowledge/provenance';

/**
 * The reader (docs/knowledge-subapp.md §3) — the one screen in this family that
 * is *for reading*, and the reason the entry table exists at all: chunks are
 * whitespace-normalized and split, so the authored document only survives round
 * trip because it is stored whole.
 *
 * ## Two kinds behind one route
 *
 * `kind=entry` reads `knowledge_entries`; `kind=pack` reads one row of the
 * shipped corpus out of `knowledge_chunks`. They are NOT interchangeable ids
 * from two tables pretending to be one — the param says which, so a pack entry
 * that ever grows into several chunks becomes a group-by here and nothing else
 * has to change.
 *
 * ## Pack entries are read-only, decisively
 *
 * A pack version bump DELETEs the pack's rows and re-inserts them
 * (`ingestCorpus`), so an in-place edit to a pack entry is structurally doomed —
 * it would survive until the next content update and then vanish with no
 * explanation. Rather than invent a second content type to carry annotations,
 * the footer says exactly that and offers the honest alternative: **write your
 * own entry on this topic**, which gives everything a margin note would — your
 * stance, findable, cited, and ranked ABOVE the pack in search — with no edit
 * path for a version bump to eat.
 *
 * ## Conformed Set treatment
 *
 * No device at all. This is a page of prose, not a record filed on a page — the
 * same reasoning that took the Coach thread off its well
 * (src/components/ui/block.tsx). Topic in the label voice, title and body in
 * serif with generous line-height, provenance in mono behind a dashed rule,
 * which is the mark this design uses for an aside beneath the main content
 * rather than a second equal division.
 */

/** Only http(s) is ever handed to the OS from a stored provenance string. */
function openable(url: string): boolean {
  return /^https?:\/\//i.test(url.trim());
}

/** Body paragraphs, blank-line separated — the structure the entry preserved. */
function paragraphs(body: string): string[] {
  return body
    .split(/\n\s*\n+/)
    .map((p) => p.replace(/[ \t]+/g, ' ').trim())
    .filter((p) => p.length > 0);
}

export default function KnowledgeEntryScreen() {
  const router = useRouter();
  const { id, kind } = useLocalSearchParams<{ id?: string; kind?: string }>();
  const isPack = kind === 'pack';

  const read = useCallback((): { entry?: KnowledgeEntryRow; pack?: PackEntry } => {
    if (typeof id !== 'string') return {};
    const db = getDb();
    return isPack ? { pack: getPackEntry(db, id) } : { entry: getKnowledgeEntry(db, id) };
  }, [id, isPack]);

  const [state, setState] = useState(read);
  // An edit on the pushed editor must be visible the moment we come back.
  useFocusEffect(
    useCallback(() => {
      setState(read());
    }, [read])
  );

  const entry = state.entry;
  const pack = state.pack;
  const title = entry?.title ?? pack?.title ?? null;
  const topic = entry?.topic ?? pack?.topic ?? null;
  const body = entry?.body ?? pack?.body ?? null;

  if (title === null || body === null) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Entry" parent="Knowledge" />
        </View>
        <Text className="mt-5 font-serif text-[14px] leading-6 text-ink-secondary">
          That entry is no longer here — it may have been deleted.
        </Text>
      </Screen>
    );
  }

  const confirmArchive = () => {
    if (!entry) return;
    Alert.alert(
      'Archive this entry?',
      'It keeps its text but leaves every search — the Coach won’t cite it until you restore it.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive',
          style: 'destructive',
          onPress: () => {
            archiveKnowledgeEntry(getDb(), entry.id);
            router.back();
          },
        },
      ]
    );
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={isPack ? 'ARC reference' : 'Your entry'} parent="Knowledge" />
      </View>

      <View className="mt-6">
        {topic ? (
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
            {topic}
          </Text>
        ) : null}
        <Text className="mt-2 font-serif text-[24px] font-semibold leading-8 text-ink">{title}</Text>
      </View>

      {/* The body. Generous leading, paragraph gaps preserved from the source —
          this is the only surface in the app that is asked to be READ at length
          rather than scanned. */}
      <View className="mt-5">
        {paragraphs(body).map((para, index) => (
          <Text
            key={index}
            className={
              index === 0
                ? 'font-serif text-[16px] leading-7 text-ink'
                : 'mt-4 font-serif text-[16px] leading-7 text-ink'
            }>
            {para}
          </Text>
        ))}
      </View>

      {/* Provenance — an aside beneath the content, so a dashed rule, not a
          solid one. Mono: where a document came from and when is a record. */}
      <View className="mt-8">
        <DashedDivider />
        <View className="mt-3">
          {isPack ? (
            <>
              <Text className="font-mono text-[11px] leading-4 text-ink-muted">
                ARC reference · pack {pack?.pack_version ? `v${pack.pack_version}` : 'unversioned'}
              </Text>
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Part of ARC’s shipped reference — replaced when the pack updates, so it can’t be
                edited in place.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Write your own entry on this topic"
                onPress={() =>
                  router.push({
                    pathname: '/knowledge-entry-edit',
                    params: topic ? { topic } : {},
                  })
                }
                className="mt-4 min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
                <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
                <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
                  Write your own entry on this topic
                </Text>
              </Pressable>
            </>
          ) : entry ? (
            <>
              <Text className="font-mono text-[11px] leading-4 text-ink-muted">
                {provenanceFooter(entry)}
              </Text>
              {/* The URL is shown as TEXT and handed to the OS — this screen
                  never fetches anything. The one fetch this feature has lives at
                  import time, once, on a URL the user pasted (the 2026-08-12
                  ADR).

                  `openable` is a scheme allow-list, not a formality. Everything
                  that writes `source_url` today goes through
                  `normalizeArticleUrl`, which forces http/https — but this is
                  the point where a stored string becomes an ACTION taken by the
                  OS, and the guard belongs at the point of action rather than
                  resting on every past and future writer having been careful.
                  A non-http row renders as plain text instead. */}
              {entry.source_url ? (
                openable(entry.source_url) ? (
                  <Pressable
                    accessibilityRole="link"
                    accessibilityLabel={`Open ${entry.source_url} in the browser`}
                    onPress={() => {
                      const url = entry.source_url;
                      if (url && openable(url)) void Linking.openURL(url);
                    }}
                    className="mt-2 min-h-[44px] justify-center active:opacity-60">
                    <Text className="font-mono text-[11px] leading-4 text-pine">
                      {entry.source_url}
                    </Text>
                  </Pressable>
                ) : (
                  <Text className="mt-2 font-mono text-[11px] leading-4 text-ink-muted">
                    {entry.source_url}
                  </Text>
                )
              ) : null}
              {entry.source_note ? (
                <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
                  {entry.source_note}
                </Text>
              ) : null}

              {entry.archived_at === null ? (
                <View className="mt-4 flex-row items-stretch gap-2">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Edit this entry"
                    onPress={() =>
                      router.push({ pathname: '/knowledge-entry-edit', params: { id: entry.id } })
                    }
                    className="min-h-[46px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
                    <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
                    <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
                      Edit
                    </Text>
                  </Pressable>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Archive this entry"
                    onPress={confirmArchive}
                    className="min-h-[46px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
                    <Ionicons name="archive-outline" size={17} color={palette.inkMuted} />
                    <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-secondary">
                      Archive
                    </Text>
                  </Pressable>
                </View>
              ) : (
                <View className="mt-4">
                  <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                    Archived {entry.archived_at.slice(0, 10)} — out of every search until restored.
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Restore this entry"
                    onPress={() => {
                      restoreKnowledgeEntry(getDb(), entry.id);
                      setState(read());
                    }}
                    className="mt-3 min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
                    <Ionicons name="refresh-outline" size={17} color={palette.inkSecondary} />
                    <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
                      Restore
                    </Text>
                  </Pressable>
                </View>
              )}
            </>
          ) : null}
        </View>
      </View>
    </Screen>
  );
}
