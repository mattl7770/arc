import Ionicons from '@expo/vector-icons/Ionicons';
import { useCallback, useState, type ReactNode } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import type { Figure, SectionProvenance } from '@/lib/reports/types';

/**
 * The report preview's drawing vocabulary — a handful of Conformed Set
 * primitives the two report renderers place fields into.
 *
 * ## These components compute NOTHING
 *
 * Same rule as `src/lib/reports/render-html.ts`, and for the same reason: the
 * native preview and the HTML file are two renderers over ONE assembled
 * `ReportData`, so "the preview and the file cannot disagree" is structural
 * rather than a promise. There is no arithmetic in this directory, no
 * `toFixed`, no `Math.`, no date handling. A `null` value draws the em-dash the
 * assembler meant by it; everything else is placed as given.
 *
 * The two renderers do NOT share a layout, and are not meant to. A phone is not
 * a sheet of A4: an eight-column adherence table is correct on paper and
 * unreadable at 393pt, so the same eight fields become a name, a percentage and
 * a small ruled ledger beneath. What agrees is the FIGURES. What differs is the
 * geometry, which is what a drawing set does anyway.
 *
 * ## Surface system
 *
 * One device per block, never nested (src/components/ui/block.tsx). A section
 * is a **ruled plate** — a report is records, and a record is a table. Prose
 * that belongs to a section (a provenance line, a reconciliation note, an
 * authored caveat) is a **margin annotation** rendered as the plate's SIBLING,
 * because a margin inside a plate would be two devices in one block.
 *
 * There is no accent anywhere in here. The preview is a document you read; the
 * screen's single accent belongs to the one action that leaves the device
 * (app/report-view.tsx's "Save & share").
 */

/** The em-dash for an absent value — the assembler's `null`, drawn. */
export function Absent() {
  return <Text className="font-mono text-[15px] text-ink-muted">—</Text>;
}

/** Prose beside the sheet's rule. Always a SIBLING of a plate, never inside one. */
export function Margin({ children }: { children: ReactNode }) {
  return (
    <View className="mt-2">
      <Block device="margin">{children}</Block>
    </View>
  );
}

export function MarginText({ children }: { children: string }) {
  return (
    <Margin>
      <Text className="font-serif text-[12.5px] leading-[18px] text-ink-secondary">{children}</Text>
    </Margin>
  );
}

/** The measured provenance line — mono, because it states a source and a span. */
export function Provenance({ provenance }: { provenance: SectionProvenance }) {
  return (
    <Margin>
      <Text className="font-mono text-[10px] leading-4 text-ink-muted">
        {provenance.sources} · {provenance.range}
      </Text>
    </Margin>
  );
}

/**
 * A foldable section: one ruled plate whose header row is the toggle, with its
 * prose siblings beneath.
 *
 * The fold shape is the Data tab's ({@link app/(tabs)/data.tsx}) — a two-way
 * toggle carrying `accessibilityState.expanded`, `children` as a FUNCTION so a
 * collapsed section costs nothing to render, and a `note` that stays true in
 * both states. A folded section still states what it holds.
 */
export function ReportSection({
  title,
  note,
  defaultOpen = true,
  children,
  below,
}: {
  title: string;
  /** A tally or a date span. Must be true whether the section is open or closed. */
  note?: string;
  defaultOpen?: boolean;
  children: () => ReactNode;
  /**
   * Prose that belongs to the section but not inside its plate — the authored
   * notes and the {@link Provenance} line, each its own margin annotation.
   * Deliberately NOT a `provenance` prop rendered here: a section usually has
   * two or three of these and they have a reading order, so the call site
   * places them rather than this component guessing where the source line goes.
   */
  below?: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  const toggle = useCallback(() => setOpen((prev) => !prev), []);
  return (
    <View className="mt-7">
      <Block device="plate">
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ expanded: open }}
          accessibilityLabel={`${title}.${note ? ` ${note}.` : ''} ${open ? 'Collapse' : 'Expand'}.`}
          onPress={toggle}
          className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
          <View className="flex-1">
            <SectionLabel label={title} note={note} />
          </View>
          <Ionicons name={open ? 'chevron-up' : 'chevron-down'} size={14} color={palette.inkMuted} />
        </Pressable>
        {open ? <View className="mt-1">{children()}</View> : null}
      </Block>
      {open ? below : null}
    </View>
  );
}

/** The authored empty — a written sentence, never a zero (00-design-spec.md §5). */
export function AuthoredEmpty({ text }: { text: string }) {
  return (
    <View>
      <Divider />
      <Text className="py-3 font-serif text-[13.5px] leading-5 text-ink-secondary">{text}</Text>
    </View>
  );
}

/** One measured row: a label, a value slot that can hold the em-dash, a note. */
export function FigureRow({ figure, first }: { figure: Figure; first: boolean }) {
  return (
    <View>
      <Divider first={first} />
      <View className="flex-row items-start gap-3 py-3">
        <View className="flex-1">
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.1px] text-ink-muted">
            {figure.label}
          </Text>
          {figure.note ? (
            <Text className="mt-1 font-serif text-[12px] leading-[17px] text-ink-secondary">
              {figure.note}
            </Text>
          ) : null}
        </View>
        <View className="flex-row items-baseline gap-1">
          {figure.value == null ? (
            <Absent />
          ) : (
            <Text className="font-mono text-[17px] text-ink">{figure.value}</Text>
          )}
          {figure.unit ? (
            <Text className="font-mono text-[10.5px] text-ink-muted">{figure.unit}</Text>
          ) : null}
        </View>
      </View>
    </View>
  );
}

export function FigureRows({ figures }: { figures: Figure[] }) {
  return (
    <>
      {figures.map((figure, index) => (
        <FigureRow key={figure.label} figure={figure} first={index === 0} />
      ))}
    </>
  );
}

/**
 * A record row: a serif title line, an optional measured value on the right,
 * and any number of quiet sub-lines beneath. The workhorse of every table in
 * the preview — a phone renders a table as a stack of records, not as columns.
 */
export function RecordRow({
  title,
  value,
  unit,
  lines,
  emphasis = false,
  first = false,
}: {
  title: string;
  value?: string | null;
  unit?: string | null;
  lines?: (string | null)[];
  /** Draws the title in the stronger ink — an out-of-range marker, a fired trend. */
  emphasis?: boolean;
  first?: boolean;
}) {
  const shown = (lines ?? []).filter((line): line is string => line != null && line !== '');
  return (
    <View>
      <Divider first={first} />
      <View className="flex-row items-start gap-3 py-3">
        <View className="flex-1">
          <Text
            className={
              emphasis
                ? 'font-serif text-[14.5px] font-semibold text-ink'
                : 'font-serif text-[14.5px] text-ink'
            }>
            {title}
          </Text>
          {shown.map((line) => (
            <Text
              key={line}
              className="mt-1 font-serif text-[12px] leading-[17px] text-ink-secondary">
              {line}
            </Text>
          ))}
        </View>
        {value !== undefined ? (
          <View className="flex-row items-baseline gap-1">
            {value == null ? (
              <Absent />
            ) : (
              <Text className="font-mono text-[15px] text-ink">{value}</Text>
            )}
            {unit ? <Text className="font-mono text-[10px] text-ink-muted">{unit}</Text> : null}
          </View>
        ) : null}
      </View>
    </View>
  );
}

/**
 * The small ruled ledger under an adherence row — the five buckets that must
 * sum to `planned`, drawn as discrete labelled cells rather than joined into a
 * sentence, so the reconciliation stays visible on the phone exactly as it is
 * in the printed table.
 */
export function LedgerCells({ cells }: { cells: { label: string; value: string }[] }) {
  return (
    <View className="mt-2 flex-row flex-wrap">
      {cells.map((cell) => (
        <View key={cell.label} className="mr-4 mt-1">
          <Text className="font-label text-[9px] font-semibold uppercase tracking-[0.9px] text-ink-muted">
            {cell.label}
          </Text>
          <Text className="font-mono text-[13px] text-ink">{cell.value}</Text>
        </View>
      ))}
    </View>
  );
}

/** A plain bulleted line inside a plate — draws, PRs, upcoming appointments. */
export function BulletRow({ text, first }: { text: string; first: boolean }) {
  return (
    <View>
      <Divider first={first} />
      <Text className="py-2.5 font-serif text-[13.5px] leading-5 text-ink">{text}</Text>
    </View>
  );
}

/** A sub-heading inside a plate — a muscle group, a lab category, a protocol. */
export function GroupHeading({ text, note }: { text: string; note?: string }) {
  return (
    <View className="mt-4">
      <SectionLabel label={text} note={note} />
    </View>
  );
}
