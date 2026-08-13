import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect } from 'expo-router';
import { useCallback, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import {
  FRESHNESS_SPOKEN,
  freshnessTally,
  freshnessTone,
} from '@/components/exercise/freshness-display';
import { MuscleFigure, MuscleFigureLegend } from '@/components/exercise/muscle-figure';
import { Block, Divider } from '@/components/ui/block';
import { GaugeTrack, gaugeTextClass } from '@/components/ui/gauge';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import {
  clearMuscleAnchor,
  listMuscleAnchors,
  setMuscleAnchor,
} from '@/lib/db/repositories/muscle-anchors';
import { recentMuscleLoads } from '@/lib/db/repositories/training-stats';
import { FRESHNESS_LOOKBACK_DAYS, MUSCLE_LABEL } from '@/lib/exercise/constants';
import { muscleFreshness } from '@/lib/exercise/freshness';
import type { Muscle, MuscleFreshness } from '@/lib/exercise/types';

/**
 * Muscle freshness in full — pushed from the hub's body figure. The figure
 * repeats at the top (larger), then the complete per-muscle ledger: name, a
 * gauge track, and the toned mono score, one ruled row per muscle. The hub
 * shows the figure; this screen shows the numbers behind it, and is the one
 * place a reading can be CORRECTED.
 *
 * The two are not redundant and the split is deliberate: the FIGURE answers
 * *where on me*, which no list can, and the LEDGER answers *by how much*, which
 * no drawing can.
 *
 * ## Correcting a reading (owner, 2026-08-12; migration 0037)
 *
 * *"Add functionality to manually adjust muscle freshness after tapping into
 * the sub-screen"*. Tapping a row opens its adjuster: nudge by ten, or jump to
 * either end, or clear a correction already made. Every button writes
 * immediately — there is no pending state to lose, and no Save to forget.
 *
 * What gets written is an ANCHOR, not a value: "as of now, this muscle was N
 * percent". The recovery model then proceeds from there — the assertion decays
 * on the muscle's own clock and the next real session depletes from it — so a
 * correction fades the way a session does instead of pinning the figure forever.
 * The full argument is in db/migrations/0037_muscle_freshness_anchors.sql.
 *
 * An asserted number and a derived one must not wear the same face (the rule
 * `resolved_by` applies to recipe lines, 0034), so a row currently resting on an
 * anchor says so under the muscle's name.
 *
 * ## The surface system (00-design-spec.md §1)
 *
 *   Figure + key     field  a readout about the body — corner ticks, no box
 *   Ledger           plate  a record, ruled
 *
 * No accent — nothing here is a next action. Freshness is a biological state, so
 * its marks ride the gauge's closed biological tones, never the accent; the
 * track/fill treatment and its contrast measurements live on
 * src/components/ui/gauge.tsx, and the shared state→tone/spoken maps in
 * src/components/exercise/freshness-display.ts. The adjuster's buttons carry
 * their border alone — a control raised onto plate stock is the surface
 * inversion src/components/ui/block.tsx forbids.
 */

const read = (): MuscleFreshness[] => {
  const db = getDb();
  return muscleFreshness(
    recentMuscleLoads(db, FRESHNESS_LOOKBACK_DAYS),
    new Date(),
    listMuscleAnchors(db)
  );
};

/** How far one nudge moves a muscle. Ten is a tenth of the scale, one tap. */
const NUDGE = 10;

export default function MuscleFreshnessScreen() {
  const [ledger, setLedger] = useState<MuscleFreshness[]>(read);
  const [editing, setEditing] = useState<Muscle | null>(null);
  const reload = useCallback(() => setLedger(read()), []);
  useFocusEffect(reload);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Muscle freshness" />
      </View>

      {/* The figure — a readout about the body, so: measured field.
          128pt per figure: with the freshness scale (30pt) and two 8pt gaps that
          is 302pt, inside the 311 a 375pt iPhone SE leaves after the Screen's
          20pt gutters and this device's 12pt padding. Nothing here shrinks —
          `flexShrink` is 0 in React Native — so the budget is a hard edge, not
          a hint. The hub draws the same figure at its 118pt default. */}
      <View className="mt-4">
        <Block device="field">
          <SectionLabel
            label="Body map"
            note={`${freshnessTally(ledger).fresh.length} of ${ledger.length} fresh`}
          />
          <View className="mt-3">
            <MuscleFigure mode="freshness" ledger={ledger} figureWidth={128} />
          </View>
          <View className="mt-3">
            <MuscleFigureLegend mode="freshness" ledger={ledger} />
          </View>
        </Block>
      </View>

      {/* The complete ledger — a record, so: ruled plate. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel label="Per muscle" note={`Last ${FRESHNESS_LOOKBACK_DAYS} days`} />
          <View className="mt-2">
            {ledger.map((m, i) => (
              <MuscleRow
                key={m.muscle}
                entry={m}
                first={i === 0}
                editing={editing === m.muscle}
                onToggle={() => setEditing((cur) => (cur === m.muscle ? null : m.muscle))}
                onChanged={reload}
              />
            ))}
          </View>
        </Block>
      </View>

      <Text className="mt-4 font-serif text-[12px] leading-5 text-ink-muted">
        Freshness decays with every hard set and recovers on each muscle&rsquo;s own timescale —
        large muscles take ~72 h, small ones ~36 h. 100 means fully recovered. A value set by hand
        recovers from that moment on the same clock, and the next logged set takes it back down.
      </Text>
    </Screen>
  );
}

/**
 * One muscle's row, and its adjuster when open.
 *
 * The row is `accessible` so a screen reader hears "Quads 82 percent, fresh" as
 * one element — geometry and colour say nothing to it (the pattern of
 * src/components/home/signal.tsx) — and the announcement names the basis when
 * the reading rests on an anchor, because that is the part a sighted reader gets
 * from the label under the name.
 */
function MuscleRow({
  entry,
  first,
  editing,
  onToggle,
  onChanged,
}: {
  entry: MuscleFreshness;
  first: boolean;
  editing: boolean;
  onToggle: () => void;
  onChanged: () => void;
}) {
  const anchored = entry.anchoredAt != null;
  const name = MUSCLE_LABEL[entry.muscle];

  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityState={{ expanded: editing }}
        accessibilityLabel={`${name} ${entry.freshness} percent, ${FRESHNESS_SPOKEN[entry.state]}${
          anchored ? ', set by hand' : ''
        }. Adjust it.`}
        onPress={onToggle}
        className="min-h-[44px] flex-row items-center gap-3 py-2 active:opacity-60">
        <View className="w-[86px]">
          <Text className="font-serif text-[13px] text-ink">{name}</Text>
          {anchored ? (
            <Text className="mt-0.5 font-label text-[9px] font-semibold uppercase tracking-[0.8px] text-ink-secondary">
              Set by hand
            </Text>
          ) : null}
        </View>
        <View className="flex-1">
          <GaugeTrack value={entry.freshness} tone={freshnessTone(entry.state)} />
        </View>
        {/* The row states its condition twice — once in the fill, once in the
            matching ink cut — and the % says what the number is a number OF. */}
        <Text
          className={`w-10 text-right font-mono text-[12px] font-semibold ${gaugeTextClass(freshnessTone(entry.state))}`}>
          {entry.freshness}%
        </Text>
        <Ionicons
          name={editing ? 'chevron-up' : 'chevron-forward'}
          size={15}
          color={palette.inkMuted}
        />
      </Pressable>
      {editing ? <FreshnessEditor entry={entry} onChanged={onChanged} /> : null}
    </View>
  );
}

/**
 * The adjuster: nudge, jump to either end, or clear.
 *
 * It expands INSIDE the ledger plate, so it opens on a `Divider` rather than a
 * `border-t` and carries no device of its own (devices never nest). The buttons
 * wear their border alone — no fill — because a control raised onto plate stock
 * inside another surface is the inversion src/components/ui/block.tsx forbids,
 * and none of these is the screen's one next action, so none of them takes the
 * accent.
 *
 * Every tap writes and re-reads. There is no draft value and no Save: a pending
 * number that looks like a reading but is not yet one would be exactly the
 * asserted/derived confusion this whole feature is built to avoid.
 */
function FreshnessEditor({ entry, onChanged }: { entry: MuscleFreshness; onChanged: () => void }) {
  const name = MUSCLE_LABEL[entry.muscle].toLowerCase();
  const set = (value: number) => {
    setMuscleAnchor(getDb(), entry.muscle, value);
    onChanged();
  };

  return (
    <View>
      <Divider />
      <View className="flex-row flex-wrap gap-2 pb-3 pt-3">
        <EditorButton
          label="−10"
          a11y={`Drop ${name} ten percent`}
          onPress={() => set(entry.freshness - NUDGE)}
        />
        <EditorButton
          label="+10"
          a11y={`Raise ${name} ten percent`}
          onPress={() => set(entry.freshness + NUDGE)}
        />
        <EditorButton label="Fresh" a11y={`Mark ${name} fully fresh`} onPress={() => set(100)} />
        <EditorButton label="Spent" a11y={`Mark ${name} fully spent`} onPress={() => set(0)} />
        {entry.anchoredAt != null ? (
          <EditorButton
            label="Clear"
            muted
            a11y={`Clear the hand-set value for ${name}`}
            onPress={() => {
              clearMuscleAnchor(getDb(), entry.muscle);
              onChanged();
            }}
          />
        ) : null}
      </View>
    </View>
  );
}

function EditorButton({
  label,
  a11y,
  muted = false,
  onPress,
}: {
  label: string;
  a11y: string;
  muted?: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={a11y}
      onPress={onPress}
      className="min-h-[44px] min-w-[56px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
      <Text
        className={
          muted
            ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
            : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
        }>
        {label}
      </Text>
    </Pressable>
  );
}
