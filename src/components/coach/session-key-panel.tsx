import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { palette } from '@/constants/theme';
import { sessionKeyStore } from '@/lib/ai/session-key-store';

/**
 * The clearly-labelled "Paste API key (this session only)" affordance.
 *
 * Temporary by design: the key goes into process memory
 * (src/lib/ai/session-key-store.ts) — never persisted, gone on restart — so
 * the real agent is demonstrable before the Settings/Keychain screen ships.
 * Deliberately spelled out in the caption so there is zero ambiguity about
 * where the secret lives.
 */
export function SessionKeyPanel({ keySet }: { keySet: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');

  if (keySet) {
    return (
      <View className="flex-row items-center justify-between border-b border-hairline bg-porcelain px-5 py-2">
        <Text className="text-xs text-ink-secondary">
          Model connected — key held in memory, this session only.
        </Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            sessionKeyStore.clear();
            setDraft('');
            setExpanded(false);
          }}
          className="active:opacity-60">
          <Text className="text-xs font-medium text-ink">Disconnect</Text>
        </Pressable>
      </View>
    );
  }

  if (!expanded) {
    return (
      <View className="flex-row items-center justify-between border-b border-hairline bg-porcelain px-5 py-2">
        <Text className="text-xs text-ink-secondary">Preview mode — no model connected.</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => setExpanded(true)}
          className="active:opacity-60">
          <Text className="text-xs font-medium text-ink">Paste API key…</Text>
        </Pressable>
      </View>
    );
  }

  const canConnect = draft.trim().length > 0;

  return (
    <View className="border-b border-hairline bg-porcelain px-5 py-3">
      <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
        Paste API key (this session only)
      </Text>
      <View className="mt-2 flex-row items-center gap-2">
        <View className="flex-1 rounded-btn bg-paper-deep px-3">
          <TextInput
            value={draft}
            onChangeText={setDraft}
            placeholder="sk-ant-…"
            placeholderTextColor={palette.inkMuted}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            className="py-2 font-mono text-[13px] text-ink"
            accessibilityLabel="API key"
          />
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ disabled: !canConnect }}
          disabled={!canConnect}
          onPress={() => {
            sessionKeyStore.set(draft);
            setDraft('');
            setExpanded(false);
          }}
          className={`rounded-btn px-3.5 py-2 ${canConnect ? 'bg-pine active:opacity-70' : 'bg-hairline'}`}>
          <Text
            className="text-[13px] font-medium"
            style={{ color: canConnect ? palette.pineOn : palette.inkMuted }}>
            Connect
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            setDraft('');
            setExpanded(false);
          }}
          className="active:opacity-60">
          <Text className="text-[13px] text-ink-muted">Cancel</Text>
        </Pressable>
      </View>
      <Text className="mt-2 text-[11px] leading-4 text-ink-muted">
        Held in memory only — never saved, cleared when the app closes. Keychain storage arrives
        with Settings.
      </Text>
    </View>
  );
}
