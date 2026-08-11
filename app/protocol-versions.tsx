import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { useProtocolVersions } from '@/hooks/use-protocol-versions';
import { protocolTypeLabel } from '@/lib/protocols/format';

/**
 * Protocol version history — the timeline behind "versioned like code",
 * pushed from the protocol editor.
 *
 * Every content save writes a NEW immutable `protocol_versions` row and moves
 * `protocols.current_version_id` to it; the row it replaced is kept. Until now
 * the app wrote that history and never showed it. This screen is the read.
 *
 * The read runs screen → hook → repository like every other screen in the app:
 * `listVersions` in repositories/protocols.ts owns the SQL (and shares its item
 * count expression with `listProtocols`, so the two can never drift), and
 * useProtocolVersions owns the focus refresh. Nothing here touches getDb.
 *
 * Conformed Set treatment — one **plate**: a version list is a record, and a
 * record is a table. The rail down the left is drawn with bordered and filled
 * Views (there is no react-native-svg in this app and that stays true —
 * 01-rn-port-guide.md §5). The closing caption is a **margin annotation**,
 * outside the plate, because devices never nest. (The sheet draws it inside,
 * under a dashed rule — `.cf-vhist-cap`. This app has never had that rule here,
 * and reinstating it is not what restoring the caption needed.)
 *
 * The rows are deliberately NOT ruled, unlike every other plate in the app. The
 * rail already runs the full height of the list and separates one node from the
 * next; a hairline across each boundary would cut the rail it crosses and draw
 * the same separation twice. Rules are how a plate separates rows when nothing
 * else does — here something else does.
 *
 * Type voices: version numbers, dates and item counts are measurements, so they
 * are mono. Change notes are the author speaking, so they are serif. State
 * words ("Current", "Coach") are the label voice.
 *
 * **Accent budget: ZERO.** This is a reference surface — like Screenings and
 * Experiments, it is something you read, not something you act on — and §2's
 * budget list (Home hero, one primary action per screen, completion stamps,
 * user chat bubbles, the active tab, the Coach presence dot) has no slot for
 * "the live row of a list". An earlier pass marked the current version with a
 * filled accent node on the argument that it is the same kind of state as the
 * active tab; the ruling was not to widen the budget, because that list is the
 * one thing the whole tree is checked against. So the live/superseded split is
 * carried entirely by FORM and WEIGHT, which is where it belonged anyway: the
 * current version is a SOLID ink node with a bold version number, every
 * superseded one a hollow dashed muted square with a lighter number. Fill,
 * rule style and weight all disagree — three axes, none of them hue, which is
 * the tick-ladder rule from home/mission.tsx applied to a timeline. No signal-*
 * anywhere either: a version is workflow, not biology.
 *
 * ## The state this screen does NOT draw, and why
 *
 * The mockup draws a suspended moment — v2 dashed and labelled
 * "proposed · awaiting your OK" above a solid current v1. **The data model
 * cannot produce that row today, so it is not drawn.** Every writer of
 * `protocol_versions` (repositories/protocols.ts) bumps `current_version_id` in
 * the same transaction, and the Coach's `update_protocol` tool only reaches
 * that writer *after* the user approves — the proposal itself lives in
 * `PendingWrite`, which is React state in use-coach-chat.ts and is never
 * persisted. So an unapproved version has no row, no id and no lifetime beyond
 * the open chat turn. Drawing one here would be a picture of a record that does
 * not exist. What the data can say is said: current, superseded, and who wrote
 * each one.
 */

/** Hermes ships no Intl, so the stamp is hand-rolled (see home/date-eyebrow.tsx). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/**
 * The screen the back control returns to. This one is unambiguous: exactly one
 * caller pushes `/protocol-versions` (app/protocol-edit.tsx, the "version
 * history" row), and that screen's own `StackHeader` title is "Edit Protocol" —
 * so the word here is the title of the sheet underneath, not a guess. The mockup
 * writes `‹ Data` because its version history is drawn hanging off the Protocols
 * sheet; in the app it hangs off the editor, and the control names where it
 * actually goes.
 */
const PARENT = 'Edit Protocol';

/**
 * ISO instant -> "3 Jul 26 · 14:20" in local time. The clock time is not
 * decoration: two saves in one afternoon are ordinary, and without it their
 * rows would carry identical stamps.
 */
function stamp(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const year = String(d.getFullYear() % 100).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${d.getDate()} ${MONTHS[d.getMonth()] ?? ''} ${year} · ${hours}:${minutes}`;
}

/** A count that isn't there is an em-dash, never a zero we invented. */
function itemsText(count: number | null): string {
  if (count === null) return '—';
  return `${count} ${count === 1 ? 'item' : 'items'}`;
}

/**
 * The node marks. Whole literal class strings from a map — Tailwind's scanner
 * only sees names that appear literally in source (src/components/home/signal.tsx).
 *
 * Solid ink = live. Hollow dashed muted = superseded. The two differ by fill,
 * by rule style AND by weight, none of which is hue — so the distinction holds
 * with no accent spent and would survive being printed in greyscale.
 */
const NODE: Record<'current' | 'prior', string> = {
  current: 'mt-1 h-3 w-3 bg-ink',
  prior: 'mt-1 h-3 w-3 border border-dashed border-ink-muted',
};

/** The version number carries the same split in weight: bold live, plain prior. */
const VERSION_TEXT: Record<'current' | 'prior', string> = {
  current: 'font-mono text-[13px] font-semibold text-ink',
  prior: 'font-mono text-[13px] text-ink-secondary',
};

export default function ProtocolVersionsScreen() {
  // A deep link can repeat the param (?id=a&id=b), which expo-router delivers
  // as string[] despite the generic — coerce so a malformed link degrades to
  // the "no longer exists" branch instead of throwing at the SQLite bind.
  const params = useLocalSearchParams<{ id?: string | string[] }>();
  const id = Array.isArray(params.id) ? params.id[0] : params.id;

  const history = useProtocolVersions(id);

  if (!history) {
    return (
      <Screen>
        <View className="pt-2">
          <StackHeader title="Version History" parent={PARENT} />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This protocol no longer exists.
        </Text>
      </Screen>
    );
  }

  const { protocol, versions, currentVersionId } = history;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Version History" parent={PARENT} />
      </View>

      {/* Which protocol this is the history of. The name is speech, the type is
          a label; neither is a measurement. */}
      <Text className="mt-3 font-serif text-[16px] font-semibold text-ink">{protocol.name}</Text>
      <Text className="mt-1 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
        {protocolTypeLabel(protocol.type)}
      </Text>

      <View className="mt-6">
        {/* The count is measured — mono, in the label's note slot. It counts the
            rows drawn directly below, so it cannot drift from them. */}
        <SectionLabel
          label="Versions"
          note={versions.length > 0 ? String(versions.length) : undefined}
        />

        <View className="mt-3">
          <Block device="plate">
            {versions.length === 0 ? (
              // Empty is authored, never blank — and it keeps the plate: the
              // timeline's place is drawn before it has entries.
              <View className="py-1">
                <Text className="font-serif text-[15px] font-semibold text-ink">
                  No versions yet
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  This protocol has no saved content. The first save writes v1, and every save after
                  it keeps the one before.
                </Text>
              </View>
            ) : (
              versions.map((v, index) => {
                const current = v.id === currentVersionId;
                const last = index === versions.length - 1;
                return (
                  <View
                    key={v.id}
                    accessible
                    accessibilityRole="text"
                    accessibilityLabel={
                      `Version ${v.versionNumber}, ${current ? 'current' : 'superseded'}. ` +
                      `Saved ${stamp(v.createdAt)}. ${itemsText(v.itemCount)}. ` +
                      `${v.createdBy === 'ai' ? 'Written by Coach. ' : ''}` +
                      `${v.changeNotes ? `Note: ${v.changeNotes}` : 'No change note.'}`
                    }
                    className="flex-row gap-2.5">
                    {/* The rail. Two Views: the node, then a 1px column that
                        stretches to the bottom of the row — which is the top of
                        the next node, because the padding that separates rows
                        lives on the content column, not on the row. The last
                        row draws no rail: there is nothing older to reach. */}
                    <View className="w-4 items-center">
                      <View className={current ? NODE.current : NODE.prior} />
                      {last ? null : <View className="mt-1 w-px flex-1 bg-hairline" />}
                    </View>

                    <View className={last ? 'flex-1 pb-1' : 'flex-1 pb-4'}>
                      <View className="flex-row items-baseline gap-2">
                        <Text className={current ? VERSION_TEXT.current : VERSION_TEXT.prior}>
                          v{v.versionNumber}
                        </Text>
                        <Text className="flex-1 font-mono text-[10px] text-ink-muted">
                          {stamp(v.createdAt)}
                        </Text>
                        {/* The word carries the last of what the accent used to:
                            present on exactly one row, absent on every other,
                            in full ink against the muted stamp beside it. Left
                            as a bare Text so it still sits on the row's
                            baseline — a bordered View here would align by its
                            bottom edge and drop below the line. */}
                        {current ? (
                          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1px] text-ink">
                            Current
                          </Text>
                        ) : null}
                      </View>

                      {/* The author speaking — serif. A version with no note
                          says so rather than leaving a gap the eye reads as a
                          rendering fault. */}
                      <Text
                        className={`mt-1.5 font-serif text-[13px] leading-5 ${
                          v.changeNotes ? 'text-ink-secondary' : 'text-ink-muted'
                        }`}>
                        {v.changeNotes ?? 'No change note.'}
                      </Text>

                      <View className="mt-1.5 flex-row items-baseline gap-2">
                        <Text className="flex-1 font-mono text-[10px] text-ink-muted">
                          {itemsText(v.itemCount)}
                        </Text>
                        {/* Authorship is stamped on the row (`created_by`), so
                            a Coach-written version is named. User-written is
                            the default and stays unmarked — labelling every
                            other row "You" would be noise, not information. */}
                        {v.createdBy === 'ai' ? (
                          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                            Coach
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </Block>
        </View>
      </View>

      {/* The whole closing caption went on 2026-08-11 as explanatory copy. Most
          of it deserved to: "every save keeps the version before it" is what
          the timeline draws, and "history is never lost" is reassurance. One
          clause was neither. Deleting a protocol takes its versions with it,
          and that is a consequence the user cannot discover before triggering
          it — nothing on this screen, or on the editor holding the delete,
          says so. Just that clause is back. */}
      <View className="mt-8">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            Deleting a protocol deletes its version history.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
