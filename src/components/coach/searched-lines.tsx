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
 */
export function SearchedLines({ searches }: { searches: readonly WebSearchSummary[] | undefined }) {
  if (!searches || searches.length === 0) return null;
  return (
    <View className="mt-1">
      {searches.map((search, index) => (
        <Text
          key={`${search.query}-${index}`}
          className="font-mono text-[10px] leading-4 tracking-[0.5px] text-ink-muted">
          {searchedLine(search)}
        </Text>
      ))}
    </View>
  );
}
