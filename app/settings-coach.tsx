import { useState, useSyncExternalStore } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { apiKeyStore } from '@/lib/ai/api-key-store';
import { COACH_MODELS } from '@/lib/ai/model-client';

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
 */

export default function SettingsCoachScreen() {
  const keySet = useSyncExternalStore(apiKeyStore.subscribe, () => apiKeyStore.has());
  const hydrated = useSyncExternalStore(apiKeyStore.subscribe, () => apiKeyStore.isHydrated());
  const persistent = useSyncExternalStore(apiKeyStore.subscribe, () => apiKeyStore.isPersistent());
  const model = useSyncExternalStore(apiKeyStore.subscribe, () => apiKeyStore.getModel());

  const [draft, setDraft] = useState('');
  const canSave = draft.trim().length > 0;

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

      {/* Model — the pick the Coach service reads on every turn. */}
      <View className="mt-8">
        <SectionLabel label="Model" />
        <View className="mt-3">
          <Block device="plate">
            {COACH_MODELS.map((option, index) => {
              const on = option.id === model;
              return (
                <Pressable
                  key={option.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: on }}
                  accessibilityLabel={`${option.label}. ${option.note}.`}
                  onPress={() => void apiKeyStore.setModel(option.id)}
                  className={`min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60 ${
                    index === 0 ? '' : 'border-t border-hairline'
                  }`}>
                  {/* The selected mark is a filled square in ink — square corners
                      throughout, and no accent anywhere in Settings. */}
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
                    <Text className="mt-0.5 font-serif text-[12px] text-ink-muted">
                      {option.note}
                    </Text>
                  </View>
                </Pressable>
              );
            })}
          </Block>
        </View>

        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[11px] leading-4 text-ink-muted">
              Sonnet handles this workload at near-Opus quality for a fraction of the cost; Opus is
              worth it for deep, whole-history analysis. Switch anytime.
            </Text>
          </Block>
        </View>
      </View>
    </Screen>
  );
}
