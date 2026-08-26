import { useLocalSearchParams } from 'expo-router';
import { Alert, Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { rederiveMissionForDay } from '@/lib/db/repositories/mission-generate';
import { restoreVersion } from '@/lib/db/repositories/protocols';
import { diffContent, diffLines } from '@/lib/protocols/diff';
import { protocolTypeLabel } from '@/lib/protocols/format';
import { useProtocolVersions } from '@/hooks/use-protocol-versions';

/**
 * Protocol version history — the timeline behind "versioned like code",
 * pushed from the protocol detail screen.
 *
 * Every content save writes a NEW immutable `protocol_versions` row and moves
 * `protocols.current_version_id` to it; the row it replaced is kept.
 *
 * ## The two halves that were missing, and now are not
 *
 * The history was real, immutable and drawn — and paid nothing back. There was
 * **no diff and no way back**, so "versioned like code" was the storage half
 * with none of the payoff: you could not see what a version changed, and
 * `change_notes` was the author's unchecked word for it.
 *
 *   - **The diff** (src/lib/protocols/diff.ts) is computed between each version
 *     and the one below it and drawn directly under that version's note, so the
 *     sentence the author wrote and the change they actually made are read
 *     together. It works across the schema turnover: both sides are normalised
 *     before comparison, so a v1 version diffs against a v2 one exactly like
 *     two v2 versions do.
 *   - **Restore** is a NEW version carrying the old content, never a move of
 *     the live pointer — reverting a commit, not deleting one. History is
 *     append-only and stays that way, and the restored version's note says
 *     which version it came from. It re-derives today straight afterwards, so
 *     the mission follows the way it does for any other save.
 *
 * Conformed Set treatment — one **plate**: a version list is a record, and a
 * record is a table. The rail down the left is drawn with bordered and filled
 * Views: `react-native-svg` is declared in package.json but is NOT in the
 * owner's current binary, so this View-based drawing stays (01-rn-port-guide.md
 * §5). The closing caption is a **margin annotation**, outside the plate,
 * because devices never nest.
 *
 * The rows are deliberately NOT ruled, unlike every other plate in the app. The
 * rail already runs the full height of the list and separates one node from the
 * next; a hairline across each boundary would cut the rail it crosses and draw
 * the same separation twice.
 *
 * Type voices: version numbers, dates and item counts are measurements, so they
 * are mono. Change notes are the author speaking, so they are serif. The diff
 * lines are the record of a change — measured, terse, and set in mono so they
 * cannot be mistaken for the author's own sentence above them. State words
 * ("Current", "Coach") and the Restore control are the label voice.
 *
 * **Accent budget: ZERO.** This is a reference surface, and §2's budget list has
 * no slot for "the live row of a list". The live/superseded split is carried
 * entirely by FORM and WEIGHT: the current version is a SOLID ink node with a
 * bold version number, every superseded one a hollow dashed muted square with a
 * lighter number. Fill, rule style and weight all disagree — three axes, none of
 * them hue. No `signal-*` anywhere either: a version is workflow, not biology.
 *
 * ## The state this screen does NOT draw, and why
 *
 * The mockup draws a suspended moment — v2 dashed and labelled
 * "proposed · awaiting your OK" above a solid current v1. **The data model
 * cannot produce that row, so it is not drawn.** Every writer of
 * `protocol_versions` bumps `current_version_id` in the same transaction, and
 * the Coach's `update_protocol` only reaches that writer *after* the user
 * approves — the proposal itself lives in `PendingWrite`, React state in
 * use-coach-chat.ts, never persisted. Drawing one here would be a picture of a
 * record that does not exist.
 */

/** Hermes ships no Intl, so the stamp is hand-rolled (see home/date-eyebrow.tsx). */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

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

/** How many diff lines a row prints before it summarises the rest. */
const DIFF_LINE_LIMIT = 6;

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
          <StackHeader title="Version History" parent="Protocols" />
        </View>
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-muted">
          This protocol no longer exists.
        </Text>
      </Screen>
    );
  }

  const { protocol, versions, currentVersionId } = history;

  /**
   * Make an old version live again. A confirmation first, because it changes
   * what lands on today — and the summary says what it will contain, so a
   * restore cannot be approved as a smaller thing than it is.
   */
  const confirmRestore = (versionId: string, versionNumber: number, itemCount: number | null) => {
    Alert.alert(
      `Restore v${versionNumber}?`,
      `This saves its contents as a new version — ${itemsText(itemCount)} — and leaves every version already here exactly as it is. Today's mission follows; anything already done or skipped keeps its record.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Restore',
          onPress: () => {
            try {
              const db = getDb();
              restoreVersion(db, protocol.id, versionId);
              rederiveMissionForDay(db, todayISODate());
            } catch (error) {
              console.warn('[protocols] restore failed', error);
              Alert.alert('Restore failed', 'Nothing was changed. Please try again.');
            }
          },
        },
      ]
    );
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Version History" parent={protocol.name} />
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
                // Newest first, so the version BELOW this one in the list is
                // the one it replaced. The oldest has nothing under it, which
                // is why it prints no diff — v1 is not a change, it is a start.
                const previous = versions[index + 1];
                const lines = previous
                  ? diffLines(diffContent(previous.content, v.content))
                  : [];
                const shown = lines.slice(0, DIFF_LINE_LIMIT);
                const rest = lines.length - shown.length;
                return (
                  <View
                    key={v.id}
                    accessible
                    accessibilityRole="text"
                    accessibilityLabel={
                      `Version ${v.versionNumber}, ${current ? 'current' : 'superseded'}. ` +
                      `Saved ${stamp(v.createdAt)}. ${itemsText(v.itemCount)}. ` +
                      `${v.createdBy === 'ai' ? 'Written by Coach. ' : ''}` +
                      `${v.changeNotes ? `Note: ${v.changeNotes}. ` : 'No change note. '}` +
                      `${previous ? (lines.length === 0 ? 'No change to the items.' : `Changes: ${lines.join('; ')}.`) : ''}`
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

                      {/* What the save ACTUALLY did, under what its author said
                          it did. Mono, because each line is a record of a
                          change rather than prose — and because the two must
                          never be mistaken for one another. */}
                      {previous ? (
                        <View className="mt-1.5">
                          {lines.length === 0 ? (
                            <Text className="font-mono text-[10.5px] leading-4 text-ink-muted">
                              no change to the items
                            </Text>
                          ) : (
                            <>
                              {shown.map((line, i) => (
                                <Text
                                  key={`${v.id}-${i}`}
                                  className="font-mono text-[10.5px] leading-4 text-ink-secondary">
                                  {line}
                                </Text>
                              ))}
                              {rest > 0 ? (
                                <Text className="font-mono text-[10.5px] leading-4 text-ink-muted">
                                  {`+ ${rest} more`}
                                </Text>
                              ) : null}
                            </>
                          )}
                        </View>
                      ) : null}

                      <View className="mt-1.5 flex-row items-center gap-2">
                        <Text className="flex-1 font-mono text-[10px] text-ink-muted">
                          {itemsText(v.itemCount)}
                          {v.phaseCount > 1 ? ` · ${v.phaseCount} phases` : ''}
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
                        {/* Only on a superseded row: "restore what is already
                            live" is a control with nothing to do. Label voice,
                            no accent — this screen spends none. */}
                        {current ? null : (
                          <Pressable
                            accessibilityRole="button"
                            accessibilityLabel={`Restore version ${v.versionNumber}`}
                            onPress={() => confirmRestore(v.id, v.versionNumber, v.itemCount)}
                            className="min-h-[44px] justify-center px-1 active:opacity-60">
                            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1px] text-ink">
                              Restore
                            </Text>
                          </Pressable>
                        )}
                      </View>
                    </View>
                  </View>
                );
              })
            )}
          </Block>
        </View>
      </View>

      {/* The one consequence the user cannot discover before triggering it:
          deleting a protocol takes its versions with it, and nothing on the
          editor holding that delete says so. */}
      <View className="mt-8">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            Restoring writes a new version; nothing here is ever overwritten. Deleting a protocol
            deletes its version history.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
