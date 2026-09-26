import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, View } from 'react-native';

import { UndoRow } from '@/components/nutrition/undo-row';
import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import type { UndoWords } from '@/lib/nutrition/undo-store';
import type { LogFeedItem } from '@/types/log';

/** The absence, stated as a fact. */
const EMPTY_STATE = 'Nothing logged yet today.';

/**
 * What VoiceOver reads for a row's ×: which row, and when it was logged. A note
 * is not read out whole — its text is the row itself, one swipe away.
 */
function removeLabel(entry: LogFeedItem): string {
  return `Remove ${entry.note ? 'the note' : `${entry.category}, ${entry.title}`}, logged at ${entry.time}`;
}

/**
 * Today's log so far — a running record beneath the capture controls, newest
 * first. Reads real entries from the DB (src/hooks/use-log-feed.ts).
 *
 * Conformed Set treatment — the **ruled plate** device (00-design-spec.md §1):
 * a record is a table, so the feed sits on paper-hi inside a hairline with its
 * rows ruled. The plate edge closes the list, which is why the first row draws
 * no rule of its own and the last draws no trailing one. Explicit hairlines
 * rather than `divide-y`: that utility needs a CSS sibling selector, which React
 * Native has no equivalent for.
 *
 * Three voices on one row: the time and the entry itself in **mono** (a logged
 * entry is a measurement — "178.4 lb", "+16 oz"), a free note in **serif**
 * italic because a note is prose, and the category strip in the **label** voice.
 * The "Note · for Coach" caption is what stops a bucket-less note reading as a
 * half-filled metric.
 *
 * The section note is a plain count of the rows drawn directly beneath it, so it
 * always reconciles — and it is dropped entirely at zero rather than printed as
 * "0 entries", because a tally of nothing is noise (§5: no denominators until
 * targets exist).
 *
 * ## Every row has a × (owner, 2026-09-25)
 *
 * *"Add a delete with an Undo to each capture on the Log tab."* Until then a
 * capture could not be removed anywhere in the app. Each row now ends in the
 * meal screen's own item × — a muted glyph, no border, no accent, a 32 pt box
 * with a 12 pt slop past the 44 pt floor — and a tap removes the row at once,
 * with no confirmation, because what it offers back is exact: the **Undo row**
 * the meal screen draws (src/components/nutrition/undo-row.tsx), a ruled row
 * of this same plate under the last entry. The removal is `removeLogCapture`
 * (src/lib/health/publish.ts), which takes a weight's or a glass's copy out of
 * Apple Health too, and the Undo puts both back.
 *
 * ## The empty ledger
 *
 * "Empty is authored, never blank" (00-design-spec.md §5), and the mockup's
 * empty-ledger sheet (S-02) sets the idiom: an italic muted line **stating the
 * absence as a fact**. The second line that followed it — the one pointing at
 * the command field — was cut by the owner as explanatory copy on 2026-08-11.
 *
 * **The plate holds steady across both states**, so the record's *place* is
 * drawn before it has contents. It was made conditional on 2026-08-10 and
 * reverted the same day: the stray rectangles the owner reported from hardware
 * were a NativeWind divider artefact, not the plates, and de-plating the empty
 * branches was the wrong answer to a rendering bug.
 *
 * The way out of empty is the command field at the top of this same screen, so
 * an empty ledger carries no control of its own. The one exception is the Undo
 * row, when the entry just removed was the day's last.
 */
export function RecentLogs({
  entries,
  onRemove,
  undo = null,
  onUndo,
}: {
  entries: LogFeedItem[];
  /** Remove one row. Absent, the rows draw no ×. */
  onRemove?: (entry: LogFeedItem) => void;
  /** The open Undo for this day's record, drawn under the last row. */
  undo?: UndoWords | null;
  onUndo?: () => void;
}) {
  const count = entries.length;

  return (
    <Block device="plate">
      <SectionLabel
        label="Logged today"
        note={count > 0 ? `${count} ${count === 1 ? 'entry' : 'entries'}` : undefined}
      />

      {count === 0 ? (
        <View className="mt-2.5">
          <Text className="font-serif text-[15px] italic leading-5 text-ink-muted">
            {EMPTY_STATE}
          </Text>
        </View>
      ) : (
        <View className="mt-1">
          {entries.map((entry, index) => (
            <View key={entry.id}>
              <Divider first={index === 0} />
              <View className="flex-row gap-3 py-3">
                <Text className="w-11 pt-0.5 font-mono text-[11px] text-ink-muted">
                  {entry.time}
                </Text>
                <View className="flex-1">
                  <Text
                    className={
                      entry.note
                        ? 'font-serif text-[15px] italic leading-5 text-ink-secondary'
                        : 'font-mono text-[14px] leading-5 text-ink'
                    }>
                    {entry.title}
                  </Text>
                  <View className="mt-1 flex-row items-center gap-1.5">
                    {entry.note ? (
                      <Ionicons
                        name="reader-outline"
                        size={11}
                        color={palette.inkMuted}
                        accessibilityElementsHidden
                        importantForAccessibility="no"
                      />
                    ) : null}
                    <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                      {entry.note ? 'Note · for Coach' : entry.category}
                    </Text>
                  </View>
                </View>
                {onRemove ? (
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={removeLabel(entry)}
                    hitSlop={12}
                    onPress={() => onRemove(entry)}
                    className="h-8 w-8 items-center justify-center rounded-btn active:opacity-60">
                    <Ionicons name="close" size={16} color={palette.inkMuted} />
                  </Pressable>
                ) : null}
              </View>
            </View>
          ))}
        </View>
      )}

      {/* The receipt for the entry just removed — a ruled row of this plate,
          never a second device. */}
      {undo && onUndo ? <UndoRow offer={undo} onUndo={onUndo} /> : null}
    </Block>
  );
}
