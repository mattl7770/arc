import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block, DashedDivider, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useProtocolHub, type ProtocolHubRow } from '@/hooks/use-protocols';
import {
  phaseSummary,
  protocolTypeLabel,
  rateText,
  weekdayDate,
} from '@/lib/protocols/format';

/**
 * Protocols — the sub-app root. Versioned stacks, routines and blocks; the ONLY
 * source of Home's daily mission.
 *
 * It graduated from a row three taps inside the Data tab (owner call,
 * 2026-08-25). Home's mission area links straight here, and Data keeps its row
 * — one hub, two ways in, like Nutrition and Exercise.
 *
 * ## What a row says now, and why it is not just a name
 *
 * Every row used to read `name · type · v3 · 4 items`, which is a description
 * of a FILE. What the user needs to know about a protocol is whether it is
 * doing anything: which phase it is in, how often it asks for things, and
 * whether they are actually being done.
 *
 * **Re-cut 2026-09-19.** The row now LEADS with what the protocol is doing —
 * `3 today · next Wed` — and adherence moved to the foot beside the version.
 * Three things changed and each was a defect:
 *
 *   - the rate led the row, which is how well it has been run, a slower fact
 *     than what it asks of today and not the reason anyone opens this screen;
 *   - the cadence summary said **"mixed"** the moment two items disagreed (a
 *     daily creatine beside a Mon/Wed/Fri lift, or a single 3×/wk quota), which
 *     is true and useless. `contentCadenceSummary` is deleted;
 *   - **the description left the row** (owner's call). Two serif lines per row
 *     is what made a six-protocol hub a page and a half; it reads on the
 *     detail, one tap away.
 *
 * **Ended protocols are separated from running ones.** A protocol past its last
 * bounded phase is still `is_active = 1` and generates nothing; listed among
 * the running ones it would read as working while silently doing nothing.
 * Paused is a third list, because paused is a decision and ended is a date.
 *
 * Conformed Set treatment — **ruled plates**: a protocol list is a record, and
 * a record is a table, so each group is one plate with ruled rows. The closing
 * rationale is a **margin annotation**.
 *
 * Accent budget: exactly one — "New protocol", the single primary action.
 * Adherence is BEHAVIOUR, not biology, so no `signal-*` colour appears on it;
 * the rate is a measured value and takes mono ink like every other measurement.
 * The paused/ended words and the version string are workflow, so they stay
 * neutral too.
 *
 * The DASHED rule inside a row (`DashedDivider`, src/components/ui/block.tsx)
 * separates what a protocol is doing from its record. It cannot be solid:
 * the plate already separates its ROWS with solid hairlines, and a second solid
 * rule inside a row would leave the reader unable to tell where one protocol
 * ends and the next begins. A dashed rule is subordinate — a division within an
 * object rather than between objects — so the dash carries meaning, not texture.
 */

/**
 * What a row's lead figure says — **what this protocol is doing**, not how well
 * it has been done.
 *
 * The four forms, and why each is the honest one:
 *
 *   - `3 today` — a running protocol's rows on the committed mission. A daily
 *     protocol stops there: naming tomorrow is a longer way of saying tomorrow.
 *   - `1 today · next Wed` — the next day is drawn only when the earliest
 *     non-quota occurrence is strictly LATER than tomorrow. So a daily creatine
 *     beside a Mon/Wed/Fri lift reads `1 today · next Wed` on a Monday and
 *     `1 today` on a Tuesday.
 *   - `3 today · 1 of 3 this wk` — a single-quota protocol prints its
 *     ALLOWANCE and no day, because a quota has no next day: it is spread
 *     across every remaining day of the week until it is met.
 *   - `paused` / `Ended 12 Jul` / `Starts 1 Sep` — a protocol putting nothing
 *     on any day says so instead of printing a zero.
 *
 * `nothing today` is the fourth running case and is authored rather than left
 * blank: a Mon/Wed/Fri protocol on a Sunday with its next occurrence past the
 * horizon genuinely asks for nothing, and an empty slot reads as a fault.
 */
function leadFigure(row: ProtocolHubRow): string {
  const { item, phase, today, nextOn, allowance } = row;
  if (!item.isActive) return 'paused';
  if (phase.kind !== 'running') return phaseSummary(phase) ?? 'not running';
  const tail = nextOn
    ? ` · next ${weekdayDate(nextOn)}`
    : allowance
      ? ` · ${allowance.done} of ${allowance.perWeek} this wk`
      : '';
  if (today === 0) return tail === '' ? 'nothing today' : tail.replace(' · ', '');
  return `${today} today${tail}`;
}

/** One protocol row inside a plate. `first` suppresses the top rule. */
function ProtocolRow({
  row,
  first,
  onPress,
}: {
  row: ProtocolHubRow;
  first: boolean;
  onPress: () => void;
}) {
  const { item, phase, rate, planned } = row;
  const where = phaseSummary(phase);
  const figure = leadFigure(row);
  // "no record yet" and "0%" are different facts, and only one of them is true
  // of a protocol whose first day has not finished.
  const record = planned === 0 ? 'no record yet' : `${rateText(rate)} run`;
  // Where it is up to belongs on the label line — EXCEPT when the lead figure
  // has already said it, which is the ended and not-started case. Saying
  // "Ended 12 Jul" twice on one row is not emphasis.
  const state = phase.kind === 'running' ? where : null;

  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${item.name}. ${figure}. ${protocolTypeLabel(item.type)}${
          state ? `. ${state}` : ''
        }. ${item.versionNumber === null ? 'No version yet' : `Version ${item.versionNumber}`}. ${
          planned === 0 ? 'No record yet' : `${rateText(rate)} of planned items done`
        }.`}
        onPress={onPress}
        className="min-h-[44px] py-3 active:opacity-60">
        <View className="flex-row items-center gap-3">
          <Text className="flex-1 font-serif text-[16px] font-semibold text-ink">{item.name}</Text>
          {/* What it is doing today — counts and days are measured values, mono. */}
          <Text numberOfLines={1} className="font-mono text-[11px] text-ink-secondary">
            {figure}
          </Text>
          <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
        </View>

        {/* The description LEFT this row on 2026-09-19 (owner's call). Two serif
            lines per row is what made a six-protocol hub a page and a half, and
            a description is a fact about the file rather than about the day —
            it reads on the detail, one tap away. */}
        <Text className="mt-1 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
          {state ? `${protocolTypeLabel(item.type)} · ${state}` : protocolTypeLabel(item.type)}
        </Text>

        {/* The foot rule. `.cf-protocard-foot` closes each card with 10pt above
            the rule and 8pt below it; the spacing follows the sheet. */}
        <View className="mt-2.5">
          <DashedDivider />
        </View>
        <View className="mt-2 flex-row items-center justify-between gap-3">
          <Text className="flex-1 font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
            {'Version '}
            {/* A version number is a measured value inside a label, so it stays
                mono (00-design-spec.md §3). */}
            <Text className="font-mono">
              {item.versionNumber === null ? 'none yet' : `v${item.versionNumber}`}
            </Text>
          </Text>
          {/* Adherence moved here from the head: it is how well the protocol has
              been RUN, which is a slower fact than what it asks of today. */}
          <Text className="font-mono text-[11px] text-ink-muted">{record}</Text>
        </View>
      </Pressable>
    </View>
  );
}

/** The seed the Coach arrives with when the hub is empty. */
const DRAFT_PROMPT =
  'Draft my first protocol. Ask what I am already doing and what I want to change, then propose one.';

export default function ProtocolsScreen() {
  const router = useRouter();
  const hub = useProtocolHub();
  const total = hub.running.length + hub.ended.length + hub.paused.length;
  const open = (id: string) => router.push({ pathname: '/protocol-detail', params: { id } });

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Protocols" />
      </View>

      {/* The one accent on this screen. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="New protocol"
        onPress={() => router.push('/protocol-edit')}
        className="mt-5 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5 active:opacity-70">
        <Ionicons name="add" size={19} color={palette.pineOn} />
        <Text className="font-label text-[15px] font-semibold text-pine-on">New protocol</Text>
      </Pressable>

      {total === 0 ? (
        <View className="mt-8">
          <SectionLabel label="Your protocols" />
          <View className="mt-3">
            <Block device="plate">
              {/* Empty is authored, never blank — and it keeps the plate: this
                  is the state a fresh install opens in, and the record's place
                  is drawn before it has contents. */}
              <View className="py-1">
                <Text className="font-serif text-[15px] font-semibold text-ink">
                  No protocols yet
                </Text>
                <Text className="mt-1.5 font-serif text-[13px] leading-5 text-ink-secondary">
                  A protocol is a stack, a routine, or a training block. Your days fill in from it.
                </Text>
                {/* The second way in, and the reason there is no template
                    library: this is a single-user app and the Coach IS the
                    template engine — it can read the labs, the training and the
                    history that a canned "Morning Stack" could not. Neutral
                    ink; "New protocol" above is the screen's one accent. */}
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Ask the Coach to draft a protocol"
                  onPress={() =>
                    router.push({
                      pathname: '/(tabs)/coach',
                      params: { prompt: DRAFT_PROMPT },
                    })
                  }
                  className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline active:bg-paper-dim">
                  <Ionicons name="chatbubble-outline" size={16} color={palette.inkSecondary} />
                  <Text className="font-label text-[13px] font-medium text-ink">
                    Ask the Coach to draft one
                  </Text>
                </Pressable>
              </View>
            </Block>
          </View>
        </View>
      ) : null}

      {hub.running.length > 0 ? (
        <View className="mt-8">
          {/* The count is a measured value — mono, carried by the label's note
              slot, and it counts the rows drawn directly below it. */}
          <SectionLabel label="Running" note={String(hub.running.length)} />
          <View className="mt-3">
            <Block device="plate">
              {hub.running.map((row, index) => (
                <ProtocolRow
                  key={row.item.id}
                  row={row}
                  first={index === 0}
                  onPress={() => open(row.item.id)}
                />
              ))}
            </Block>
          </View>
        </View>
      ) : null}

      {hub.ended.length > 0 ? (
        <View className="mt-8">
          <SectionLabel label="Ended" note={String(hub.ended.length)} />
          <View className="mt-3">
            <Block device="plate">
              {hub.ended.map((row, index) => (
                <ProtocolRow
                  key={row.item.id}
                  row={row}
                  first={index === 0}
                  onPress={() => open(row.item.id)}
                />
              ))}
            </Block>
          </View>
        </View>
      ) : null}

      {hub.paused.length > 0 ? (
        <View className="mt-8">
          <SectionLabel label="Paused" note={String(hub.paused.length)} />
          <View className="mt-3">
            <Block device="plate">
              {hub.paused.map((row, index) => (
                <ProtocolRow
                  key={row.item.id}
                  row={row}
                  first={index === 0}
                  onPress={() => open(row.item.id)}
                />
              ))}
            </Block>
          </View>
        </View>
      ) : null}

      {/* How an edit here reaches Home. One sentence, because it is now one
          rule: a save re-derives today through the same diff a mode change
          uses, so nothing already done is disturbed. */}
      <View className="mt-8">
        <Block device="margin">
          <Text className="font-serif text-[11px] leading-4 text-ink-muted">
            Running protocols build Today&rsquo;s Mission. An edit reaches today straight away;
            anything already done or skipped keeps its record.
          </Text>
        </Block>
      </View>
    </Screen>
  );
}
