import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useState } from 'react';
import { Alert, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  listAllMemories,
  searchMemories,
  MEMORY_PROMPT_LIMIT,
  type CoachMemoryRow,
} from '@/lib/db/repositories/coach-memory';
import {
  deleteKnowledgeEntry,
  listKnowledgeEntries,
  listPackEntries,
  restoreKnowledgeEntry,
  type KnowledgeEntryRow,
  type PackEntry,
} from '@/lib/db/repositories/knowledge';
import { provenanceLine } from '@/lib/knowledge/provenance';

/**
 * The knowledge base (docs/knowledge-subapp.md §3) — the browsable reference the
 * Coach cites.
 *
 * ## What this screen is for
 *
 * The pack (src/lib/rag/corpus.ts) was already searchable by the Coach and
 * invisible to the user; entries were not possible at all. So this hub does two
 * things at once: it makes the shipped doctrine readable, and it makes the
 * user's own doctrine writable. Both land in the same chunk table, both are
 * cited, and yours outranks ARC's — which is the whole reason the second half
 * exists.
 *
 * ## The four runs (0044 split the entries; C14 added memory on top)
 *
 * Owner, 2026-08-26: *"two sections, one for scientific data and another for
 * personal data about the user that should be remembered."* So what the user
 * writes is partitioned in two. Owner again, C14: *"the coach shouldn't be
 * reading every scientific article put in there every turn, but I should be
 * able to manually add stuff to coach memory that it should know every turn."*
 * So the memory store — which stayed a separate table, see §2c of the spec —
 * moved its SURFACE here, and the screen draws four runs:
 *
 *   COACH MEMORY one-line facts carried into EVERY turn, capped. The only run
 *                on this screen the Coach does not have to go looking for, and
 *                the reason it is drawn first: it is the smallest, the most
 *                expensive per row, and the one whose cap has a consequence
 *                the owner must be able to see.
 *   PERSONAL     pages about HIM — a surgical history, how he reacts to
 *                something, a constraint he has settled on.
 *   SCIENTIFIC   his own doctrine about how the world works.
 *   ARC REFERENCE the shipped pack, which is scientific by construction and is
 *                not something he writes into — hence its own run rather than a
 *                nested sub-heading. The sections partition HIS writing; the
 *                pack is the shipped half of the scientific one.
 *
 * The runs are ordered by how eagerly the Coach reads them: memory every turn,
 * the user's own pages when they bear on the question, ARC's pack last. That is
 * also the order of how much a row costs and how much it matters, which is why
 * one ordering serves both. The LENGTH litmus that decides which store a fact
 * belongs in (docs/knowledge-subapp.md §8) is stated in the memory run's own
 * copy and again in its editor — where the owner is actually choosing.
 *
 * Two stacked runs rather than a toggle, because this screen is BROWSED: a
 * toggle hides half the base behind a tap and makes "what do I have?" a
 * two-state question. Counts sit on each label.
 *
 * Personal is drawn FIRST and deliberately: it is the smaller, rarer and more
 * consequential half, and burying it under a run that grows with every imported
 * article would make the section the owner asked for the one he never sees.
 *
 * The two empty states are DIFFERENT FACTS and are written as such. An empty
 * scientific run sits above a shipped pack, so "nothing of your own yet" is a
 * remark about authorship. An empty personal run means ARC holds no page about
 * the user at all, which is a different thing to say.
 *
 * ## Search is this screen's, not the Coach's
 *
 * The field filters the two lists in place, deliberately NOT through
 * `searchUserHistory`: that is the Coach's cross-source recall tool, ranking six
 * stores against each other, and pointing it at a two-list screen would return
 * meals and workouts to a knowledge search. The repository's filter shares its
 * `queryTerms` splitter and its distinct-term ranking, so "matches" means the
 * same thing in both places — it just looks at two tables instead of six. It is
 * also fully KEYLESS and offline, which is the point: reading your own reference
 * must never depend on a model.
 *
 * ## Conformed Set treatment (00-design-spec.md §1)
 *
 *   Actions    → one **stamp**, capped. The accent budget for this screen is
 *                one and this spends it (owner call, 2026-08-12: import takes
 *                the accent, "Write an entry" rides beside it as a ghost).
 *   Search     → a **well** wrapping a BARE TextInput — the block IS the field.
 *   Both lists → **ruled plates**, one per topic for the reference, the
 *                `labs.tsx` category-plate model. Rules are drawn by `Divider`,
 *                never `border-t` (which React Native paints as a full
 *                rectangle — the owner's "weird boxes").
 *
 * Devices never nest, so every topic plate is a sibling and the heading that
 * names the run of them sits bare on the sheet.
 *
 * ## The empty state is a reading, not a void
 *
 * The pack ships, so this screen is never globally empty. "Your entries" with
 * zero rows is authored and honest about the mechanism rather than apologetic —
 * it says what lands here and that the Coach cites it.
 */

/** Human topic headings. Anything not listed is title-cased from the data. */
const TOPIC_LABELS: Record<string, string> = {
  cardiovascular: 'Cardiovascular',
  recovery: 'Recovery',
  training: 'Training',
  sleep: 'Sleep',
  metabolic: 'Metabolic',
  method: 'Method',
  supplements: 'Supplements',
  lifestyle: 'Lifestyle',
  other: 'Other',
};

function topicLabel(topic: string): string {
  return TOPIC_LABELS[topic] ?? topic.charAt(0).toUpperCase() + topic.slice(1);
}

/** A memory's kind, as the eyebrow over its row (the 0030 CHECK vocabulary). */
const CATEGORY_LABEL: Record<CoachMemoryRow['category'], string> = {
  preference: 'Preference',
  constraint: 'Constraint',
  context: 'Context',
  goal: 'Goal',
};

/** Pack entries bucketed by topic, in pack order within each bucket. */
function groupByTopic(entries: PackEntry[]): { topic: string; items: PackEntry[] }[] {
  const groups = new Map<string, PackEntry[]>();
  for (const entry of entries) {
    const key = entry.topic || 'other';
    const bucket = groups.get(key);
    if (bucket) bucket.push(entry);
    else groups.set(key, [entry]);
  }
  return [...groups.entries()].map(([topic, items]) => ({ topic, items }));
}

/**
 * One run of the user's own entries, inside a plate the caller owns.
 *
 * Extracted when the single "Your entries" run became two (0044) — the two
 * sections draw the identical row, and two copies of it would be two places for
 * the provenance line or the 46pt target to drift apart.
 */
function EntryRows({
  entries,
  onOpen,
}: {
  entries: KnowledgeEntryRow[];
  onOpen: (id: string) => void;
}) {
  return (
    <>
      {entries.map((entry, index) => (
        <View key={entry.id}>
          <Divider first={index === 0} />
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={`${entry.title}. ${topicLabel(entry.topic)}. ${provenanceLine(entry)}.`}
            onPress={() => onOpen(entry.id)}
            className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
            <View className="flex-1">
              <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                {topicLabel(entry.topic)}
              </Text>
              <Text className="mt-1 font-serif text-[16px] leading-5 text-ink">{entry.title}</Text>
              {/* Provenance is a statement about the document, not a
                  measurement — serif, muted, not mono. */}
              <Text className="mt-0.5 font-serif text-[12px] leading-4 text-ink-muted">
                {provenanceLine(entry)}
              </Text>
            </View>
            <Ionicons name="chevron-forward" size={16} color={palette.inkSecondary} />
          </Pressable>
        </View>
      ))}
    </>
  );
}

export default function KnowledgeScreen() {
  const router = useRouter();
  const [query, setQuery] = useState('');
  const [personal, setPersonal] = useState<KnowledgeEntryRow[]>(() =>
    listKnowledgeEntries(getDb(), { query: '', section: 'personal' })
  );
  const [entries, setEntries] = useState<KnowledgeEntryRow[]>(() =>
    listKnowledgeEntries(getDb(), { query: '', section: 'scientific' })
  );
  const [pack, setPack] = useState<PackEntry[]>(() => listPackEntries(getDb(), ''));
  const [archived, setArchived] = useState<KnowledgeEntryRow[]>(() =>
    listKnowledgeEntries(getDb(), { archived: true })
  );
  const [showArchived, setShowArchived] = useState(false);
  const [memories, setMemories] = useState<CoachMemoryRow[]>(() => searchMemories(getDb()));
  const [forgotten, setForgotten] = useState<CoachMemoryRow[]>(() =>
    listAllMemories(getDb()).filter((m) => m.archived_at !== null)
  );
  const [showForgotten, setShowForgotten] = useState(false);

  const load = useCallback((text: string) => {
    const db = getDb();
    // Memory is filtered by the same splitter and the same distinct-term
    // ranking as the two entry runs (the repository shares `queryTerms`), so
    // one search field means one thing across three stores.
    setMemories(searchMemories(db, text));
    setPersonal(listKnowledgeEntries(db, { query: text, section: 'personal' }));
    setEntries(listKnowledgeEntries(db, { query: text, section: 'scientific' }));
    setPack(listPackEntries(db, text));
    // Both feet are NOT filtered by the query and NOT split further: an
    // archived entry and a forgotten memory are out of every search either way,
    // so narrowing them by a search term would be a search over things that
    // cannot be found.
    setArchived(listKnowledgeEntries(db, { archived: true }));
    setForgotten(listAllMemories(db).filter((m) => m.archived_at !== null));
  }, []);

  // Re-read on focus so an entry written, edited or archived on a pushed screen
  // is current when the user comes back.
  useFocusEffect(
    useCallback(() => {
      load(query);
    }, [load, query])
  );

  const search = (text: string) => {
    setQuery(text);
    load(text);
  };

  const searching = query.trim() !== '';
  const groups = groupByTopic(pack);

  const openEntry = (id: string) =>
    router.push({ pathname: '/knowledge-entry', params: { id, kind: 'entry' } });
  const openPack = (id: string) =>
    router.push({ pathname: '/knowledge-entry', params: { id, kind: 'pack' } });

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Knowledge" parent="Data" />
      </View>

      {/* The one accent on this screen. Import takes it; writing rides beside it
          outlined — a control inside a stamp carries its border alone, never a
          raise onto plate stock (src/components/ui/block.tsx). */}
      <View className="mt-5">
        <Block device="stamp" cap>
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
            Add to the base
          </Text>
          <Text className="mt-2 font-serif text-[19px] font-semibold leading-6 text-ink">
            Doctrine you commit to
          </Text>
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            Yours outranks ARC’s shipped reference, and the Coach cites both.
          </Text>
          <View className="mt-4 flex-row items-stretch gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Import an article"
              onPress={() => router.push('/knowledge-import')}
              className="min-h-[44px] flex-1 flex-row items-center justify-center gap-2 rounded-btn bg-pine px-4 py-3 active:opacity-70">
              <Ionicons name="download-outline" size={18} color={palette.pineOn} />
              <Text className="font-label text-[15px] font-semibold text-pine-on">
                Import an article
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Write an entry"
              onPress={() => router.push('/knowledge-entry-edit')}
              className="min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline px-4 py-3 active:opacity-60">
              <Ionicons name="create-outline" size={17} color={palette.inkSecondary} />
              <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
                Write
              </Text>
            </Pressable>
          </View>
        </Block>
      </View>

      {/* The capture surface: the well IS the field, so the input is bare, and
          the 44pt target lives on the TextInput rather than on the well. */}
      <View className="mt-3">
        <Block device="well">
          <View className="flex-row items-center gap-2">
            <Ionicons name="search-outline" size={16} color={palette.inkMuted} />
            <TextInput
              accessibilityLabel="Search the knowledge base"
              value={query}
              onChangeText={search}
              placeholder="Search memory and entries"
              placeholderTextColor={palette.inkMuted}
              autoCapitalize="none"
              autoCorrect={false}
              className="min-h-[44px] flex-1 font-serif text-[15px] text-ink"
            />
          </View>
        </Block>
      </View>

      {/* COACH MEMORY (C14) — the store the Coach reads on EVERY turn, drawn
          first for that reason. Rows are one line each, so the whole run is
          browsable inline; writing and removing happen on the pushed editor
          (/coach-memory), which is where the length rule can be stated beside
          the field rather than as a preamble here.

          The cap is stated IN WORDS and only when it bites. A store that has
          silently stopped being carried is the failure this run exists to make
          visible — the owner can read a fact on this screen and watch the Coach
          behave as though it had never been told, and nothing else in the app
          would explain why. */}
      <View className="mt-7">
        <SectionLabel
          label={searching ? 'Coach memory — matches' : 'Coach memory'}
          note={memories.length > 0 ? String(memories.length) : undefined}
        />
        {memories.length === 0 ? (
          <View className="mt-2">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {searching ? 'No memory matches.' : 'The Coach holds nothing yet.'}
            </Text>
            {searching ? null : (
              <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                Write one yourself, or tell the Coach and it will ask to keep it.
              </Text>
            )}
          </View>
        ) : (
          <>
            <View className="mt-2">
              <Block device="plate">
                {memories.map((memory, index) => (
                  <View key={memory.id}>
                    <Divider first={index === 0} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${CATEGORY_LABEL[memory.category]}. ${memory.content}. Edit.`}
                      onPress={() =>
                        router.push({ pathname: '/coach-memory', params: { id: memory.id } })
                      }
                      className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                      <View className="flex-1">
                        <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                          {CATEGORY_LABEL[memory.category]}
                        </Text>
                        <Text className="mt-1 font-serif text-[15px] leading-5 text-ink">
                          {memory.content}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={palette.inkSecondary} />
                    </Pressable>
                  </View>
                ))}
              </Block>
            </View>
            {/* Only past the cap, and phrased as a consequence rather than a
                setting: the number alone would tell the owner nothing about
                what it costs him. */}
            {memories.length > MEMORY_PROMPT_LIMIT ? (
              <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
                The Coach carries the {MEMORY_PROMPT_LIMIT} most recent into every turn, so{' '}
                {memories.length - MEMORY_PROMPT_LIMIT} of these are no longer riding along. They
                stay here, and the Coach can still find them by searching — delete or forget the
                ones that have stopped being true.
              </Text>
            ) : null}
          </>
        )}
        {searching ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Remember something"
            onPress={() => router.push('/coach-memory')}
            className="mt-3 min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
            <Ionicons name="bookmark-outline" size={17} color={palette.inkSecondary} />
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Remember something
            </Text>
          </Pressable>
        )}
        {/* FORGOTTEN — the memory store's own foot, mirroring Archived at the
            bottom of the screen. It sits inside this run rather than merged
            into that one because they are different stores with different
            words for the same act, and one heading over both would have to
            pick a word that lies about half its rows. */}
        {forgotten.length > 0 ? (
          <View className="mt-4">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ expanded: showForgotten }}
              accessibilityLabel={`Forgotten. ${forgotten.length}. ${showForgotten ? 'Collapse' : 'Expand'}.`}
              onPress={() => setShowForgotten((prev) => !prev)}
              className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
              <View className="flex-1">
                <SectionLabel label="Forgotten" note={String(forgotten.length)} />
              </View>
              <Ionicons
                name={showForgotten ? 'chevron-up' : 'chevron-down'}
                size={14}
                color={palette.inkMuted}
              />
            </Pressable>
            {showForgotten ? (
              <View className="mt-2">
                <Block device="plate">
                  {forgotten.map((memory, index) => (
                    <View key={memory.id}>
                      <Divider first={index === 0} />
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${memory.content}. Forgotten. Open.`}
                        onPress={() =>
                          router.push({ pathname: '/coach-memory', params: { id: memory.id } })
                        }
                        className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                        <View className="flex-1">
                          <Text className="font-serif text-[14px] leading-5 text-ink-muted">
                            {memory.content}
                          </Text>
                          <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                            forgotten {(memory.archived_at ?? '').slice(0, 10)}
                          </Text>
                        </View>
                        <Ionicons name="chevron-forward" size={16} color={palette.inkSecondary} />
                      </Pressable>
                    </View>
                  ))}
                </Block>
              </View>
            ) : null}
          </View>
        ) : null}
      </View>

      {/* PERSONAL — the section the owner asked for, drawn first among the
          written pages. The plate
          closes round the rows and never round the empty sentence: a plate
          encloses a record, and "nothing yet" is a sentence on the bare sheet
          under its label. */}
      <View className="mt-7">
        <SectionLabel
          label={searching ? 'Personal — matches' : 'Personal'}
          note={personal.length > 0 ? String(personal.length) : undefined}
        />
        {personal.length === 0 ? (
          <View className="mt-2">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {searching
                ? 'Nothing personal matches.'
                : 'ARC holds no page about you yet.'}
            </Text>
          </View>
        ) : (
          <View className="mt-2">
            <Block device="plate">
              <EntryRows entries={personal} onOpen={openEntry} />
            </Block>
          </View>
        )}
        {searching ? null : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Write a personal note"
            onPress={() =>
              router.push({
                pathname: '/knowledge-entry-edit',
                params: { section: 'personal' },
              })
            }
            className="mt-3 min-h-[46px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:bg-paper-dim">
            <Ionicons name="person-outline" size={17} color={palette.inkSecondary} />
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Write a personal note
            </Text>
          </Pressable>
        )}
      </View>

      {/* SCIENTIFIC — the user's own doctrine about how the world works. The
          shipped pack is the other half of this section and follows below under
          its own heading, because it is the half he does not write into. */}
      <View className="mt-7">
        <SectionLabel
          label={searching ? 'Scientific — matches' : 'Scientific'}
          note={entries.length > 0 ? String(entries.length) : undefined}
        />
        {entries.length === 0 ? (
          <View className="mt-2">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {searching
                ? 'Nothing of yours matches.'
                : 'Nothing of your own yet. Below is ARC’s shipped reference.'}
            </Text>
          </View>
        ) : (
          <View className="mt-2">
            <Block device="plate">
              <EntryRows entries={entries} onOpen={openEntry} />
            </Block>
          </View>
        )}
      </View>

      {/* ARC REFERENCE — grouped by topic, one plate per topic. The heading sits
          bare on the sheet: the plates below ARE the block it names, and a plate
          around a heading for other plates would nest devices. */}
      <View className="mt-7">
        <SectionLabel
          label={searching ? 'ARC reference — matches' : 'ARC reference'}
          note={pack.length > 0 ? String(pack.length) : undefined}
        />
      </View>
      {groups.length === 0 ? (
        <View className="mt-2">
          <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
            {searching
              ? 'Nothing in ARC’s reference matches.'
              : 'ARC’s reference hasn’t loaded yet — it lands on first launch.'}
          </Text>
        </View>
      ) : (
        groups.map((group, groupIndex) => (
          <View key={group.topic} className={groupIndex === 0 ? 'mt-3' : 'mt-7'}>
            <Block device="plate">
              <SectionLabel label={topicLabel(group.topic)} note={String(group.items.length)} />
              <View className="mt-1">
                {group.items.map((item, index) => (
                  <View key={item.id}>
                    <Divider first={index === 0} />
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`${item.title}. ARC reference.`}
                      onPress={() => openPack(item.id)}
                      className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                      <Text className="flex-1 font-serif text-[15px] leading-5 text-ink">
                        {item.title}
                      </Text>
                      <Ionicons name="chevron-forward" size={16} color={palette.inkSecondary} />
                    </Pressable>
                  </View>
                ))}
              </View>
            </Block>
          </View>
        ))
      )}

      {/* ARCHIVED — collapsed at the foot, the coach-memory.tsx pattern. An
          archived entry keeps its row and loses its chunks, so it is out of
          every search until restored; the section says so rather than leaving
          the reader to guess what "archived" cost. */}
      {archived.length > 0 ? (
        <View className="mt-7">
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ expanded: showArchived }}
            accessibilityLabel={`Archived. ${archived.length}. ${showArchived ? 'Collapse' : 'Expand'}.`}
            onPress={() => setShowArchived((prev) => !prev)}
            className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
            <View className="flex-1">
              <SectionLabel label="Archived" note={String(archived.length)} />
            </View>
            <Ionicons
              name={showArchived ? 'chevron-up' : 'chevron-down'}
              size={14}
              color={palette.inkMuted}
            />
          </Pressable>
          {showArchived ? (
            <View className="mt-2">
              <Text className="mb-2 font-serif text-[12px] leading-5 text-ink-muted">
                Archived entries keep their text but leave every search — the Coach can’t cite them
                until you restore one.
              </Text>
              <Block device="plate">
                {archived.map((entry, index) => (
                  <View key={entry.id}>
                    <Divider first={index === 0} />
                    <View className="flex-row items-center gap-3 py-3">
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`${entry.title}. Archived. Open.`}
                        onPress={() => openEntry(entry.id)}
                        className="min-h-[44px] flex-1 justify-center active:opacity-60">
                        <Text className="font-serif text-[15px] leading-5 text-ink-muted">
                          {entry.title}
                        </Text>
                        <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
                          archived {(entry.archived_at ?? '').slice(0, 10)}
                        </Text>
                      </Pressable>
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Restore ${entry.title}`}
                        hitSlop={8}
                        onPress={() => {
                          restoreKnowledgeEntry(getDb(), entry.id);
                          load(query);
                        }}
                        className="min-h-[44px] justify-center active:opacity-60">
                        <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine">
                          Restore
                        </Text>
                      </Pressable>
                      {/* The spec's promised hard delete (§2/§3), arm/confirm —
                          the coach-memory idiom. Muted, never the accent: a
                          destructive control does not compete with Restore.
                          (2026-08-13 review fix: deleteKnowledgeEntry existed
                          with zero callers while the spec said BUILT.) */}
                      <Pressable
                        accessibilityRole="button"
                        accessibilityLabel={`Delete ${entry.title} permanently`}
                        hitSlop={8}
                        onPress={() =>
                          Alert.alert(
                            'Delete this entry?',
                            `“${entry.title}” and its chunks are removed for good — the Coach can never cite it again. Archived entries can be restored. Deleted ones can’t.`,
                            [
                              { text: 'Cancel', style: 'cancel' },
                              {
                                text: 'Delete',
                                style: 'destructive',
                                onPress: () => {
                                  deleteKnowledgeEntry(getDb(), entry.id);
                                  load(query);
                                },
                              },
                            ]
                          )
                        }
                        className="min-h-[44px] justify-center active:opacity-60">
                        <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                          Delete
                        </Text>
                      </Pressable>
                    </View>
                  </View>
                ))}
              </Block>
            </View>
          ) : null}
        </View>
      ) : null}
    </Screen>
  );
}
