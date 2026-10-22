import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { AppState, Pressable, Switch, Text, TextInput, View } from 'react-native';

import { CalendarSetting } from '@/components/coach/calendar-setting';
import { ClockSetting } from '@/components/coach/clock-setting';
import { FindingThresholdSettings } from '@/components/coach/finding-thresholds';
import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { COACH_MODELS } from '@/lib/ai/model-client';
import {
  activeUsageResolution,
  USAGE_LEVEL_LABELS,
  type UsageResolution,
} from '@/lib/ai/usage-policy';
import {
  calendarAccess,
  requestCalendarAccess,
  type CalendarAccess,
} from '@/lib/calendar/calendar';
import { clearCalendarCache } from '@/lib/calendar/context';
import { getDb } from '@/lib/db/client';
import {
  getCalendarContextOn,
  setCalendarContextOn,
} from '@/lib/db/repositories/calendar-setting';
import {
  getSaveLogsAtOnce,
  setSaveLogsAtOnce,
} from '@/lib/db/repositories/coach-autosave-setting';
import { formatUsd, summarizeLedger } from '@/lib/ai/spend-ledger';
import { readSpendLedger } from '@/lib/ai/spend-store';
import { todayISODate } from '@/lib/db/date';
import { getNudgeSettings, saveNudgeSettings } from '@/lib/db/repositories/coach-nudges';
import { CHECKIN_AFTER_QUIET_MIN, type NudgeSettings } from '@/lib/notifications/nudge-plan';
import { syncReminderNotifications } from '@/lib/notifications/reminders';

/**
 * Settings › Coach — the durable home for the Coach's API key and model.
 *
 * The key is written to the iOS Keychain via the persistent store
 * (src/lib/ai/api-key-store.ts): on-device, per-app, never in the SQLite DB or
 * the JS bundle, and only ever sent on the direct calls the Coach makes to
 * Anthropic. This screen only ever WRITES the key (paste → save) or clears it —
 * the stored value is never read back into a visible field. Until the next dev
 * build ships the native module, the store falls back to memory-only and this
 * screen says so plainly rather than implying a persistence it doesn't have.
 *
 * Conformed Set treatment: the connection state is a **measured field** (it is a
 * verdict, not a record), the key entry is **recessed stock**, and the model
 * picker is a **ruled plate**.
 *
 * The field device is now unmarked — its corner ticks and its padding were cut
 * together (src/components/ui/block.tsx). That is right for a field used as a
 * *section*, which is what most call sites do; this one uses it as a compact
 * status badge sitting between the header and the key form, so it carries its
 * own vertical padding. Vertical only: an inset would knock it out of the left
 * margin every other section on this screen shares.
 *
 * **Zero accent.** Settings spends none (00-design-spec.md §2), so the presence
 * dot, the selected model marker and the Save action are all neutral ink. The
 * Coach's presence dot is on the accent budget on the Coach's own surfaces —
 * not here.
 *
 * ## Notifications (0064, docs/spikes/coach-notifications.md §4)
 *
 * The owner's answers, as controls: **Coach nudges** on or off (on by
 * default — he said yes to the Coach scheduling up to two a day without
 * asking); **quiet hours**, 21:30–07:00 until he moves them; and the **morning
 * check-in**, ON since 2026-09-26 (*"Turn it on, just after quiet hours end"*)
 * at five minutes after quiet hours end — 07:05 — moving with them when he
 * moves them, until he sets a time of his own on the wheel. That time then
 * stays put, and a **Follow quiet hours** control under it puts the check-in
 * back (nudge-plan.ts `CHECKIN_AFTER_QUIET_MIN`). The switch turns it on to
 * following, never to a fixed hour. Every change writes the setting and
 * rebuilds the OS schedule at once, through the one resync that owns it.
 * Turning nudges off cancels every one still ahead. Moving quiet hours over a
 * planned nudge HOLDS it back rather than cancelling it — never moved, and
 * back if the hours move off it — because the wheel commits every time it
 * settles and a spin must not destroy anything (coach-nudges.ts).
 * A ruled plate like the model picker: these are settings, a record.
 *
 * ## Web search (2026-10-21, docs/decisions.md "Provider-side web search")
 *
 * One switch, ON by default by the owner's answer ("whenever it helps"): the
 * Coach and the food estimators may run the provider's web search inside their
 * own model call. Persisted beside the model choice (api-key-store.ts), and read
 * on every turn, so turning it off takes effect on the next request.
 *
 * ## Record checks (Track 2 item 6, docs/ai-coach.md §3)
 *
 * The thresholds the record-hygiene and medical-attention findings read, as
 * steppers (src/components/coach/finding-thresholds.tsx). Their defaults and
 * the reason for each live in src/lib/ai/finding-thresholds.ts, the one place.
 *
 * ## Calendar (2026-10-21, docs/decisions.md "Calendar context to the model")
 *
 * One switch, OFF until he turns it on: the Coach may then see the next 7 days
 * of the phone's calendar events, read-only. Turning it on is the ONLY thing in
 * ARC that asks iOS for calendar access; it is stored on only when iOS grants
 * it. Access is re-checked whenever ARC comes back to the foreground, so a
 * change made in iOS Settings shows here at once (src/components/coach/
 * calendar-setting.tsx carries the sentences).
 *
 * ## Save simple logs at once (2026-10-21, docs/decisions.md "Simple logs save
 * at once, with Undo")
 *
 * One switch, ON by the owner's own default: a simple log he states in chat (a
 * weight, a supplement taken, a symptom, a note in his words, water, a meal in
 * words) saves without a card, with an Undo under the reply. Off puts every
 * write back behind a card. Stored in the preferences blob and read at the
 * start of every chat turn (coach-autosave-setting.ts).
 *
 * ## Two model picks (2026-10-21, the usage policy)
 *
 * **Chat model** (Coach chat, and the pass under Standard / Generous) and
 * **One-shot calls model** (estimates, imports, the lab parse, readings, the
 * exercise calls — src/lib/ai/call-types.ts). Each plate opens on **Level
 * default**: no pick, so the usage level decides, and the row names what that
 * is right now. Any model below it is an explicit pick, which always wins over
 * the level. The pickers live HERE rather than on Coach usage because this is
 * where the Coach's connection is configured — the key, search, calendar — and
 * where he already picked a model; Coach usage holds the level, its budget and
 * the spend, and names the models the level resolves to, pointing back here.
 * A pick made before the split carries over as the chat pick.
 *
 * ## Coach usage (2026-10-21)
 *
 * One row under the model pickers that opens the spend ledger's screen
 * (app/settings-coach-usage.tsx), showing today's and this month's estimate
 * so the cost of a model choice is one glance from the choice itself.
 */

/**
 * The Calendar switch: his choice (the preferences blob), iOS's answer, and the
 * change handler that asks iOS before storing an ON.
 */
function useCalendarSetting(): [boolean, CalendarAccess | null, (on: boolean) => void] {
  const [on, setOn] = useState(() => getCalendarContextOn(getDb()));
  const [access, setAccess] = useState<CalendarAccess | null>(null);
  useEffect(() => {
    let live = true;
    const check = () => {
      void calendarAccess().then((next) => {
        if (live) setAccess(next);
      });
    };
    check();
    const subscription = AppState.addEventListener('change', (state) => {
      if (state === 'active') check();
    });
    return () => {
      live = false;
      subscription.remove();
    };
  }, []);
  const change = useCallback((next: boolean) => {
    clearCalendarCache();
    if (!next) {
      setOn(setCalendarContextOn(getDb(), false));
      return;
    }
    void requestCalendarAccess().then((answer) => {
      setAccess(answer);
      if (answer === 'granted') setOn(setCalendarContextOn(getDb(), true));
    });
  }, []);
  return [on, access, change];
}

/** Today's and this month's estimate, as the Coach usage row prints it. */
function readSpendGlance(): string {
  const summary = summarizeLedger(readSpendLedger(getDb()), todayISODate());
  return `Today ${formatUsd(summary.today.usd)} · this month ${formatUsd(summary.month.usd)} · est.`;
}

/** {@link readSpendGlance}, re-read on focus: a turn elsewhere has spent since. */
function useSpendGlance(): string {
  const [glance, setGlance] = useState(readSpendGlance);
  useFocusEffect(useCallback(() => setGlance(readSpendGlance()), []));
  return glance;
}

/** The notification settings, written through and resynced on every change. */
function useNudgeSettings(): [NudgeSettings, (patch: Partial<NudgeSettings>) => void] {
  const [settings, setSettings] = useState(() => getNudgeSettings(getDb()));
  const save = useCallback((patch: Partial<NudgeSettings>) => {
    setSettings(saveNudgeSettings(getDb(), patch));
    void syncReminderNotifications(getDb());
  }, []);
  return [settings, save];
}

/** What runs now (usage-policy.ts), re-read on focus. */
function useUsageResolution(): UsageResolution {
  const [usage, setUsage] = useState(activeUsageResolution);
  useFocusEffect(useCallback(() => setUsage(activeUsageResolution()), []));
  return usage;
}

function modelLabel(id: string): string {
  return COACH_MODELS.find((m) => m.id === id)?.label ?? id;
}

/**
 * One model pick as a ruled plate: "Level default" first (no pick — the usage
 * level decides, and the row says what that is now), then every model. The
 * selected mark is a filled square in ink — square corners throughout, and no
 * accent anywhere in Settings.
 */
function ModelPicker({
  pick,
  levelDefault,
  levelName,
  onPick,
  what,
}: {
  pick: string | null;
  levelDefault: string;
  levelName: string;
  onPick: (id: string | null) => void;
  what: string;
}) {
  const rows: { id: string | null; label: string; note: string }[] = [
    {
      id: null,
      label: 'Level default',
      note: `${modelLabel(levelDefault)} · ${levelName}`,
    },
    ...COACH_MODELS.map((m) => ({ id: m.id as string, label: m.label, note: m.note as string })),
  ];
  return (
    <Block device="plate">
      {rows.map((option, index) => {
        const on = option.id === pick;
        return (
          <View key={option.id ?? 'level-default'}>
            <Divider first={index === 0} />
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: on }}
              accessibilityLabel={`${what}: ${option.label}. ${option.note}.`}
              onPress={() => onPick(option.id)}
              className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
              <View
                className={`h-4 w-4 items-center justify-center border ${
                  on ? 'border-ink' : 'border-hairline'
                }`}>
                {on ? <View className="h-2 w-2 bg-ink" /> : null}
              </View>
              <View className="flex-1">
                <Text
                  className={`font-serif text-[15px] ${on ? 'text-ink' : 'text-ink-secondary'}`}>
                  {option.label}
                </Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">{option.note}</Text>
              </View>
            </Pressable>
          </View>
        );
      })}
    </Block>
  );
}

export default function SettingsCoachScreen() {
  // Each getter doubles as the server snapshot: the headless render suite
  // renders this screen to HTML since 0064, and React requires one there. On
  // the phone the third argument is never read.
  const has = () => apiKeyStore.has();
  const isHydrated = () => apiKeyStore.isHydrated();
  const isPersistent = () => apiKeyStore.isPersistent();
  const getChatPick = () => apiKeyStore.getChatPick();
  const getUtilityPick = () => apiKeyStore.getUtilityPick();
  const isWebSearchOn = () => apiKeyStore.isWebSearchOn();
  const keySet = useSyncExternalStore(apiKeyStore.subscribe, has, has);
  const hydrated = useSyncExternalStore(apiKeyStore.subscribe, isHydrated, isHydrated);
  const persistent = useSyncExternalStore(apiKeyStore.subscribe, isPersistent, isPersistent);
  const chatPick = useSyncExternalStore(apiKeyStore.subscribe, getChatPick, getChatPick);
  const utilityPick = useSyncExternalStore(apiKeyStore.subscribe, getUtilityPick, getUtilityPick);
  const webSearch = useSyncExternalStore(apiKeyStore.subscribe, isWebSearchOn, isWebSearchOn);

  const [draft, setDraft] = useState('');
  const canSave = draft.trim().length > 0;
  const [nudges, saveNudges] = useNudgeSettings();
  const [calendarOn, calendarAccessNow, changeCalendar] = useCalendarSetting();
  const [saveAtOnce, setSaveAtOnce] = useState(() => getSaveLogsAtOnce(getDb()));
  const router = useRouter();
  const spend = useSpendGlance();
  // The level the defaults come from, re-read on focus: it is chosen on the
  // Coach usage screen one push away, and a soft budget can move it mid-day.
  const usage = useUsageResolution();
  const levelName = USAGE_LEVEL_LABELS[usage.effective];
  const chatDefault = usage.policy.chatModel;
  // Lean's utility default is "whatever the chat runs" — exactly as before.
  const utilityDefault = usage.policy.utilityModel ?? chatPick ?? chatDefault;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Coach" />
      </View>

      {/* Status — connected + where the key actually lives right now. */}
      <View className="mt-3">
        <Block device="field">
          {/* The badge's own padding — see the note above. */}
          <View className="py-2">
            <View className="flex-row items-center gap-2">
              {/* Square, like every other mark in this drawing. Ink, not accent. */}
              <View className={`h-1.5 w-1.5 ${keySet ? 'bg-ink' : 'bg-hairline'}`} />
              <Text className="font-serif text-[15px] text-ink">
                {keySet ? 'Connected' : 'Not connected'}
              </Text>
            </View>
            <Text className="mt-1.5 font-serif text-[12px] leading-5 text-ink-secondary">
              {!keySet
                ? 'The Coach runs an honest preview until a key is set — it won’t answer from your data.'
                : hydrated && persistent
                  ? 'Key stored in this device’s Keychain.'
                  : 'Key held for this session — a dev build is needed for the Keychain to persist it across launches.'}
            </Text>
          </View>
        </Block>
      </View>

      {/* API key — write-only. The stored value is never shown back. */}
      <View className="mt-8">
        <SectionLabel label="Anthropic API key" />
        <View className="mt-3">
          {/* Recessed stock: a capture surface, so the input IS the well. */}
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder={keySet ? 'Paste a new key to replace…' : 'sk-ant-…'}
            placeholderTextColor={palette.inkMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            className="border border-paper-deep bg-paper-dim px-3.5 py-3 font-mono text-[13px] text-ink"
            accessibilityLabel="Anthropic API key"
          />

          <View className="mt-3 flex-row items-center gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              disabled={!canSave}
              onPress={() => {
                void apiKeyStore.setKey(draft);
                setDraft('');
              }}
              className={`min-h-[44px] flex-1 items-center justify-center rounded-btn py-3 ${
                canSave ? 'bg-ink active:opacity-70' : 'border border-hairline bg-paper-dim'
              }`}>
              <Text
                className={`font-label text-[14px] font-semibold ${
                  canSave ? 'text-paper-hi' : 'text-ink-muted'
                }`}>
                {keySet ? 'Replace key' : 'Save key'}
              </Text>
            </Pressable>
            {keySet ? (
              <Pressable
                accessibilityRole="button"
                onPress={() => {
                  void apiKeyStore.clearKey();
                  setDraft('');
                }}
                className="min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 py-3 active:bg-paper-dim">
                <Text className="font-label text-[14px] text-ink">Clear</Text>
              </Pressable>
            ) : null}
          </View>

          <View className="mt-4">
            <Block device="margin">
              <Text className="font-serif text-[11px] leading-4 text-ink-muted">
                Create a key at console.anthropic.com (pay-as-you-go, billed to you). It stays on
                this device and is sent only on the Coach&rsquo;s own calls to Anthropic — never to
                ARC.
              </Text>
            </Block>
          </View>
        </View>
      </View>

      {/* Models — two picks (2026-10-21): the chat, and the one-shot calls.
          Each reads on every call; with no pick, the usage level decides. */}
      <View className="mt-8">
        <SectionLabel label="Chat model" />
        <View className="mt-3">
          <ModelPicker
            pick={chatPick}
            levelDefault={chatDefault}
            levelName={levelName}
            onPick={(id) => void apiKeyStore.setModel(id)}
            what="Coach chat"
          />
        </View>
      </View>

      <View className="mt-8">
        <SectionLabel label="One-shot calls model" />
        <View className="mt-3">
          <ModelPicker
            pick={utilityPick}
            levelDefault={utilityDefault}
            levelName={usage.policy.utilityModel === null ? 'follows chat' : levelName}
            onPick={(id) => void apiKeyStore.setUtilityModel(id)}
            what="one-shot calls"
          />
        </View>

        <View className="mt-4">
          <Block device="margin">
            {/* "Switch anytime." was cut by the owner as explanatory copy on
                2026-08-11 — the picker above it affords the switch. */}
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              One-shot calls are meal estimates and corrections, food descriptions, recipe and
              knowledge imports, lab reports, photo and report readings, and the exercise calls. A
              pick here always wins over the usage level&rsquo;s default. Haiku is the cheapest;
              Opus is the strongest on deep, whole-history analysis. What each choice actually costs
              is in Coach usage.
            </Text>
          </Block>
        </View>

        {/* Coach usage — what the calls have cost (the spend ledger), one tap
            from the choice that sets most of it. A ruled plate with one
            navigation row, like the rows of Settings itself. */}
        <View className="mt-4">
          <Block device="plate">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Coach usage. ${spend}`}
              onPress={() => router.push('/settings-coach-usage')}
              className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Coach usage</Text>
                <Text className="mt-0.5 font-mono text-[11px] text-ink-muted" numberOfLines={1}>
                  {spend}
                </Text>
              </View>
              <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
            </Pressable>
          </Block>
        </View>

        {/* Web search (2026-10-21): on by the owner's own answer, so the model
            searches whenever it judges that helps. A ruled plate like the
            nudges switch below: a setting, a record. */}
        <View className="mt-4">
          <Block device="plate">
            <View className="min-h-[44px] flex-row items-center gap-3 py-3">
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Web search</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  When it helps: the Coach and food estimates · ~1¢ a search
                </Text>
              </View>
              <Switch
                accessibilityLabel="Web search"
                value={webSearch}
                onValueChange={(on) => void apiKeyStore.setWebSearch(on)}
                trackColor={{ true: palette.ink, false: palette.hairlineStrong }}
                ios_backgroundColor={palette.hairlineStrong}
              />
            </View>
          </Block>
        </View>
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              The search runs at Anthropic, inside the Coach&rsquo;s own call. A query names the
              food or the fact, never your health data. The country comes from this phone&rsquo;s
              time zone and region settings, not its location.
            </Text>
          </Block>
        </View>

        {/* Calendar (2026-10-21): what the Coach may see of the week ahead —
            off until he turns it on. Beside Web search: both are inputs to
            the Coach's own call. */}
        <View className="mt-4">
          <CalendarSetting on={calendarOn} access={calendarAccessNow} onChange={changeCalendar} />
        </View>

        {/* Save simple logs at once (2026-10-21): on by the owner's answer. A
            ruled plate like Web search: a setting, a record. */}
        <View className="mt-4">
          <Block device="plate">
            <View className="min-h-[44px] flex-row items-center gap-3 py-3">
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Save simple logs at once</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  A weight, a supplement, a note you tell the Coach · Undo under the reply
                </Text>
              </View>
              <Switch
                accessibilityLabel="Save simple logs at once"
                value={saveAtOnce}
                onValueChange={(on) => setSaveAtOnce(setSaveLogsAtOnce(getDb(), on))}
                trackColor={{ true: palette.ink, false: palette.hairlineStrong }}
                ios_backgroundColor={palette.hairlineStrong}
              />
            </View>
          </Block>
        </View>
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              Only today&rsquo;s logs, in your own words and numbers. A figure the Coach estimated
              or converted, a backdate, a change, a removal, a reminder or a protocol edit always
              waits for your tap. Off: everything does.
            </Text>
          </Block>
        </View>
      </View>

      {/* Notifications — what the Coach may send, and when it may not. */}
      <View className="mt-8">
        <SectionLabel label="Notifications" />
        <View className="mt-3">
          <Block device="plate">
            {/* Not an `accessible` container — the Switch must stay individually
                focusable and toggleable for VoiceOver. */}
            <View className="min-h-[44px] flex-row items-center gap-3 py-3">
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Coach nudges</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  Up to two a day, planned when ARC opens
                </Text>
              </View>
              <Switch
                accessibilityLabel="Coach nudges"
                value={nudges.enabled}
                onValueChange={(enabled) => saveNudges({ enabled })}
                trackColor={{ true: palette.ink, false: palette.hairlineStrong }}
                ios_backgroundColor={palette.hairlineStrong}
              />
            </View>
            <Divider />
            <ClockSetting
              label="Quiet from"
              value={nudges.quietStart}
              onChange={(quietStart) => saveNudges({ quietStart })}
            />
            <Divider />
            <ClockSetting
              label="Quiet until"
              value={nudges.quietEnd}
              onChange={(quietEnd) => saveNudges({ quietEnd })}
            />
            <Divider />
            <View className="min-h-[44px] flex-row items-center gap-3 py-3">
              <View className="flex-1">
                <Text className="font-serif text-[15px] text-ink">Morning check-in</Text>
                <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                  {nudges.checkinTime
                    ? 'A daily notification; tap it and the Coach speaks first'
                    : 'Off'}
                </Text>
              </View>
              <Switch
                accessibilityLabel="Morning check-in"
                value={nudges.checkinTime !== null}
                onValueChange={(on) =>
                  saveNudges(on ? { checkinFollowsQuiet: true } : { checkinTime: null })
                }
                trackColor={{ true: palette.ink, false: palette.hairlineStrong }}
                ios_backgroundColor={palette.hairlineStrong}
              />
            </View>
            {nudges.checkinTime ? (
              <>
                <Divider />
                <ClockSetting
                  label="Check-in at"
                  value={nudges.checkinTime}
                  onChange={(checkinTime) => saveNudges({ checkinTime })}
                />
                {/* Whose time it is, under the time: part of the same row, so
                    no rule of its own. A time of his own offers the way back. */}
                {nudges.checkinFollowsQuiet ? (
                  <Text className="pb-3 font-serif text-[12px] leading-4 text-ink-muted">
                    {`${CHECKIN_AFTER_QUIET_MIN} minutes after quiet hours end, and moves with them`}
                  </Text>
                ) : (
                  <View className="flex-row items-center gap-3 pb-3">
                    <Text className="flex-1 font-serif text-[12px] leading-4 text-ink-muted">
                      Your time. Moving quiet hours leaves it here.
                    </Text>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={`Follow quiet hours: check in ${CHECKIN_AFTER_QUIET_MIN} minutes after they end`}
                      hitSlop={8}
                      onPress={() => saveNudges({ checkinFollowsQuiet: true })}
                      className="min-h-[32px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
                      <Text className="font-label text-[12px] font-semibold text-ink">
                        Follow quiet hours
                      </Text>
                    </Pressable>
                  </View>
                )}
              </>
            ) : null}
          </Block>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              A nudge timed inside quiet hours is dropped, not moved. Your own reminders, the
              morning check-in and protocol items keep their times. The lock screen shows the
              Coach&rsquo;s line in full, with no numbers in it; to hide it, set Show Previews to
              When Unlocked for ARC in iOS Settings.
            </Text>
          </Block>
        </View>
      </View>

      {/* Record checks — the thresholds the Coach's findings use. */}
      <FindingThresholdSettings />
    </Screen>
  );
}
