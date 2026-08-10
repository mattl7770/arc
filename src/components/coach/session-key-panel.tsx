import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { apiKeyStore } from '@/lib/ai/api-key-store';

/**
 * The Coach screen's **no-model** band — "this screen has no model yet, here is
 * what that means and how to fix it" — plus the fast path to connect one.
 *
 * **It renders nothing once a key is set.** It used to keep a connected
 * counterpart ("Model connected · manage in Settings" + Disconnect), and on
 * hardware the owner's read was immediate: useful before connecting, noise
 * forever after (2026-08-09). They are right, and the reason is the set's own
 * rule about authored empty states (00-design-spec.md §5) — the authoring exists
 * to get you OUT of the empty state, so it has to retire when it succeeds.
 * Reporting "connected" on every visit is the app congratulating itself with a
 * permanent strip of the thread's vertical space. Once a model is connected the
 * screen opens straight into the conversation, and the header's own rule closes
 * the band.
 *
 * Nothing is stranded by that: Settings › Coach is where the key and model are
 * managed in full and carries the Clear action (app/settings-coach.tsx), the
 * expanded form below links there directly, and the connected state is still
 * legible elsewhere — the brief and the empty-thread block both read
 * `useSessionKeySet()` and change what they say.
 *
 * The key is saved to the device Keychain via the persistent store
 * (src/lib/ai/api-key-store.ts), so connecting here is durable — the same key
 * Settings › Coach manages. This strip is the fast path. The field is
 * `secureTextEntry` and the value is never rendered back.
 *
 * ## Conformed Set treatment
 *
 * The collapsed state is the mockup's `cf-sessline`: a presence dot, one mono
 * line of state, and one control — drawn straight **on the sheet**, not on a
 * plate. It is not a record and not a verdict; it is a caption on the page, and
 * giving it a card would make a status line look like content. It draws **no
 * rule at all**: the screen header's own `border-b` sits directly above it, and
 * a second hairline below turned the caption into a boxed band (2026-08-10).
 * The expanded form keeps one, because a multi-control form genuinely needs
 * closing off from the thread it is covering.
 *
 * The presence dot is neutral here and never the accent: 00-design-spec.md §2
 * sanctions "the Coach presence dot" in the accent budget, but the dot reports
 * state, so it has to be honest — and the only state this component now renders
 * is *no model*. (The screen's live accent dot is the one on the daily brief.)
 * Connect is a real primary action, but the screen's one accent action is the
 * composer's send, so Connect is drawn solid in ink instead: unmissable, and
 * still inside the budget.
 *
 * The no-key state is authored rather than blank (§5): it says what mode the
 * screen is in, in words, before offering the control that changes it. It stays
 * to ONE line on purpose — this band sits above the scroll view, so anything
 * taller shortens the thread for exactly as long as it is up. The longer half of
 * the no-key authoring (what connecting buys, and the route to Settings › Coach)
 * belongs where there is room for it and where it retires itself once the thread
 * starts: coach/suggested-prompts.tsx, the empty-thread block.
 *
 * The expanded form ends with the destination rather than merely naming it.
 * "Manage it in Settings › Coach" as prose was a signpost with no road: the key
 * pasted here runs against whatever model is already selected, and choosing that
 * model is only possible on that screen, so it is a real link.
 */
export function SessionKeyPanel({ keySet }: { keySet: boolean }) {
  const router = useRouter();
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');

  // Connected: the band has done its job and gets out of the way. Note this
  // also closes the expanded form the instant Connect lands, so the successful
  // paste needs no separate dismissal.
  if (keySet) return null;

  if (!expanded) {
    return (
      // **No rule of its own.** This band sits immediately under the header's
      // `border-b`, so drawing a second hairline ~28px lower boxed the session
      // line between two parallel rules — a box the owner never asked for around
      // a one-line caption, and exactly the "more lines on things that shouldn't
      // have them" they raised on 2026-08-10. The header's rule is the
      // structural one; this line is a caption on the sheet beneath it.
      <View className="flex-row items-center gap-2 px-5 py-1.5">
        {/* No model, no accent: the dot reports state, so it has to be honest. */}
        <View className="h-1.5 w-1.5 rounded-full bg-hairline" />
        <Text className="flex-1 font-mono text-[10px] text-ink-muted">
          Preview mode · no model connected
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded(true)}
          className="-mr-2 min-h-[44px] justify-center px-2 active:opacity-60">
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink">
            Paste API key
          </Text>
        </Pressable>
      </View>
    );
  }

  const canConnect = draft.trim().length > 0;

  return (
    <View className="border-b border-hairline px-5 pb-2 pt-2.5">
      <SectionLabel label="Paste API key" />

      <View className="mt-2 flex-row items-center gap-2">
        {/* The recessed stock of the `well` device, sized to a field rather than
            wrapped in <Block>: the Block carries fixed padding, and this one has
            to flex beside a 44pt button. Same tokens, same reading. */}
        <View className="flex-1 border border-paper-deep bg-paper-dim px-3">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="sk-ant-…"
            placeholderTextColor={palette.inkMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            className="py-3 font-mono text-[13px] text-ink"
            accessibilityLabel="API key"
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canConnect }}
          disabled={!canConnect}
          onPress={() => {
            void apiKeyStore.setKey(draft);
            setDraft('');
            setExpanded(false);
          }}
          className={
            canConnect
              ? 'min-h-[44px] items-center justify-center bg-ink px-4 active:opacity-70'
              : 'min-h-[44px] items-center justify-center bg-hairline px-4'
          }>
          <Text
            className="font-label text-[11px] font-semibold uppercase tracking-[1.2px]"
            style={{ color: canConnect ? palette.paperHi : palette.inkMuted }}>
            Connect
          </Text>
        </Pressable>
      </View>

      <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
        Saved to this device&rsquo;s Keychain — it never leaves except on the calls it makes to
        Anthropic.
      </Text>

      <View className="flex-row items-center justify-between">
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setDraft('');
            setExpanded(false);
          }}
          className="min-h-[44px] justify-center active:opacity-60">
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
            Cancel
          </Text>
        </Pressable>

        {/* Where the model is chosen — neutral ink, like everything else in this
            band. The panel's one sanctioned accent is the presence dot. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Open Coach settings"
          onPress={() => router.push('/settings-coach')}
          className="min-h-[44px] flex-row items-center gap-1.5 active:opacity-60">
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink">
            Settings › Coach
          </Text>
          <Ionicons
            name="chevron-forward"
            size={11}
            color={palette.ink}
            accessibilityElementsHidden
            importantForAccessibility="no"
          />
        </Pressable>
      </View>
    </View>
  );
}
