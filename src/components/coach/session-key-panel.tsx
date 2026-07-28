import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { palette } from '@/constants/theme';
import { apiKeyStore } from '@/lib/ai/api-key-store';

/**
 * The Coach screen's quick "connect a key" strip.
 *
 * The key is saved to the device Keychain via the persistent store
 * (src/lib/ai/api-key-store.ts), so connecting here is durable — the same key
 * the Settings › Coach screen manages. This strip is the fast path; Settings is
 * where the key and model are managed in full. The field is `secureTextEntry`
 * and the value is never rendered back.
 */
export function SessionKeyPanel({ keySet }: { keySet: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const [draft, setDraft] = useState('');

  if (keySet) {
    return (
      <View className="flex-row items-center justify-between border-b border-hairline bg-porcelain px-5 py-2">
        <Text className="text-xs text-ink-secondary">Model connected · manage in Settings.</Text>
        <Pressable
          accessibilityRole="button"
          onPress={() => {
            void apiKeyStore.clearKey();
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
        Paste API key
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
            void apiKeyStore.setKey(draft);
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
        Saved to this device&rsquo;s Keychain — it never leaves except on the calls it makes to
        Anthropic. Manage it in Settings › Coach.
      </Text>
    </View>
  );
}
