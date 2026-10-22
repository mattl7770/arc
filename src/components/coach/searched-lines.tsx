import { Text, View } from 'react-native';

import { searchedLine, type WebSearchSummary } from '@/lib/ai/web-search';

/**
 * The quiet "Searched" lines (2026-10-21): what the model looked up on the web,
 * and which sites the answer came from. One line per search, in the muted mono
 * of the transparency chips — a search is provenance, like a tool chip, not news.
 *
 * Drawn under a Coach bubble (from the turn's persisted `tool_calls`, so a
 * reloaded thread shows the same lines) and on the estimate reviews (meal,
 * correction, food description), where it says why a figure is a menu's rather
 * than a guess. Draws nothing when there was no search, which is most turns.
 *
 * `notice` is the one line owed when the API refused the search tool on this
 * key (api-key-store.ts `takeWebSearchNotice`): the same quiet ink, because it
 * is the same kind of fact — what the answer was, and was not, built from.
 */
export function SearchedLines({
  searches,
  notice,
}: {
  searches: readonly WebSearchSummary[] | undefined;
  notice?: string | null;
}) {
  const lines = (searches ?? []).map(searchedLine);
  if (notice) lines.push(notice);
  if (lines.length === 0) return null;
  return (
    <View className="mt-1">
      {lines.map((line, index) => (
        <Text
          key={`${line}-${index}`}
          className="font-mono text-[10px] leading-4 tracking-[0.5px] text-ink-muted">
          {line}
        </Text>
      ))}
    </View>
  );
}
