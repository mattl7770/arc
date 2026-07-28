import { useState, useSyncExternalStore } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
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
 */

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

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
      <View className="mt-2 rounded-card border border-hairline bg-porcelain px-4 py-3">
        <View className="flex-row items-center gap-2">
          <View
            className={`h-1.5 w-1.5 rounded-full ${keySet ? 'bg-pine' : 'bg-hairline-strong'}`}
          />
          <Text className="text-[15px] text-ink">{keySet ? 'Connected' : 'Not connected'}</Text>
        </View>
        <Text className="mt-1.5 text-[12px] leading-5 text-ink-secondary">
          {!keySet
            ? 'The Coach runs an honest preview until a key is set — it won’t answer from your data.'
            : hydrated && persistent
              ? 'Key stored in this device’s Keychain.'
              : 'Key held for this session — a dev build is needed for the Keychain to persist it across launches.'}
        </Text>
      </View>

      {/* API key — write-only. The stored value is never shown back. */}
      <View className="mt-6">
        <SectionLabel>Anthropic API key</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain px-4 py-4">
          <View className="rounded-btn bg-paper-deep px-3">
            <TextInput
              value={draft}
              onChangeText={setDraft}
              placeholder={keySet ? 'Paste a new key to replace…' : 'sk-ant-…'}
              placeholderTextColor={palette.inkMuted}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry
              className="py-2.5 font-mono text-[13px] text-ink"
              accessibilityLabel="Anthropic API key"
            />
          </View>
          <View className="mt-3 flex-row items-center gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ disabled: !canSave }}
              disabled={!canSave}
              onPress={() => {
                void apiKeyStore.setKey(draft);
                setDraft('');
              }}
              className={`flex-1 items-center rounded-btn py-2.5 ${
                canSave ? 'bg-pine active:opacity-70' : 'bg-hairline'
              }`}>
              <Text
                className="text-[14px] font-medium"
                style={{ color: canSave ? palette.pineOn : palette.inkMuted }}>
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
                className="items-center rounded-btn border border-hairline px-4 py-2.5 active:bg-paper-deep">
                <Text className="text-[14px] text-ink">Clear</Text>
              </Pressable>
            ) : null}
          </View>
          <Text className="mt-3 text-[11px] leading-4 text-ink-muted">
            Create a key at console.anthropic.com (pay-as-you-go, billed to you). It stays on this
            device and is sent only on the Coach’s own calls to Anthropic — never to ARC.
          </Text>
        </View>
      </View>

      {/* Model — the pick the Coach service reads on every turn. */}
      <View className="mt-6">
        <SectionLabel>Model</SectionLabel>
        <View className="mt-3 rounded-card border border-hairline bg-porcelain">
          {COACH_MODELS.map((option, index) => {
            const on = option.id === model;
            return (
              <Pressable
                key={option.id}
                accessibilityRole="button"
                accessibilityState={{ selected: on }}
                accessibilityLabel={`${option.label}. ${option.note}.`}
                onPress={() => void apiKeyStore.setModel(option.id)}
                className={`flex-row items-center gap-3 px-4 py-3 active:bg-paper-deep ${
                  index === 0 ? '' : 'border-t border-hairline-soft'
                }`}>
                <View
                  className={`h-4 w-4 items-center justify-center rounded-full border ${
                    on ? 'border-pine' : 'border-hairline-strong'
                  }`}>
                  {on ? <View className="h-2 w-2 rounded-full bg-pine" /> : null}
                </View>
                <View className="flex-1">
                  <Text className={`text-[15px] ${on ? 'text-ink' : 'text-ink-secondary'}`}>
                    {option.label}
                  </Text>
                  <Text className="mt-0.5 text-[12px] text-ink-muted">{option.note}</Text>
                </View>
              </Pressable>
            );
          })}
        </View>
        <Text className="mt-3 px-1 text-[11px] leading-4 text-ink-muted">
          Sonnet handles this workload at near-Opus quality for a fraction of the cost; Opus is
          worth it for deep, whole-history analysis. Switch anytime.
        </Text>
      </View>
    </Screen>
  );
}
