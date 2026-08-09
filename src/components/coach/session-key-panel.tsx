import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { apiKeyStore } from '@/lib/ai/api-key-store';

/**
 * The Coach screen's session line — "is a model connected, and what do I do
 * about it" — plus the fast path to connect one.
 *
 * The key is saved to the device Keychain via the persistent store
 * (src/lib/ai/api-key-store.ts), so connecting here is durable — the same key
 * the Settings › Coach screen manages. This strip is the fast path; Settings is
 * where the key and model are managed in full. The field is `secureTextEntry`
 * and the value is never rendered back.
 *
 * ## Conformed Set treatment
 *
 * The collapsed states are the mockup's `cf-sessline`: a presence dot, one mono
 * line of state, and one control — drawn straight **on the sheet**, not on a
 * plate. It is not a record and not a verdict; it is a caption on the page, and
 * giving it a card would make a status line look like content. The only rule it
 * draws is the one closing the header band above the thread.
 *
 * The presence dot is the accent when a model is connected and neutral when it
 * is not — 00-design-spec.md §2 names "the Coach presence dot" explicitly in the
 * accent budget, and this is the screen's copy of it. **Nothing else in this
 * panel is allowed the accent.** Connect is a real primary action, but the
 * screen's one accent action is the composer's send, so Connect is drawn solid
 * in ink instead: unmissable, and still inside the budget.
 *
 * The no-key state is authored rather than blank (§5): it says what mode the
 * screen is in, in words, before offering the control that changes it. It stays
 * to ONE line on purpose — this band sits above the scroll view, so anything
 * taller permanently shortens the thread. The longer half of the no-key
 * authoring (what connecting buys, and the route to Settings › Coach) belongs
 * where there is room for it and where it retires itself once the thread starts:
 * coach/suggested-prompts.tsx, the empty-thread block.
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

  if (keySet) {
    return (
      <View className="flex-row items-center gap-2 border-b border-hairline px-5 py-1">
        {/* Spec-sanctioned accent (§2) — the Coach presence dot. */}
        <View className="h-1.5 w-1.5 rounded-full bg-pine" />
        <Text className="flex-1 font-mono text-[10px] text-ink-muted">
          Model connected · manage in Settings
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void apiKeyStore.clearKey();
            setDraft('');
            setExpanded(false);
          }}
          className="-mr-2 min-h-[44px] justify-center px-2 active:opacity-60">
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink">
            Disconnect
          </Text>
        </Pressable>
      </View>
    );
  }

  if (!expanded) {
    return (
      <View className="flex-row items-center gap-2 border-b border-hairline px-5 py-1">
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
