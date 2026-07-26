import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { type CaptureType, logCapture } from '@/lib/db/repositories/logs';

/**
 * Focused capture sheet reached from a quick-capture tile (Supplement, Therapy).
 *
 * Wired: a one-tap quick-log strip (your stack / recent) and a manual "add one"
 * form both persist to `log_entries` (marked ad-hoc, so they show in the Log
 * feed, not Home's mission), then return to the Log tab. Supplement folds
 * Medication in later as a type toggle; protocol-linking arrives with Protocols.
 */
type FieldSpec = { key: string; label: string; placeholder: string };
type CaptureConfig = {
  captureType: CaptureType;
  title: string;
  quickLabel: string;
  quick: { name: string; detail: string }[];
  /** First field is the primary (required); the rest append to the title. */
  fields: FieldSpec[];
  cta: string;
  ctaIcon: keyof typeof Ionicons.glyphMap;
  protocolToggle?: boolean;
};

const CONFIGS: Record<string, CaptureConfig> = {
  supplement: {
    captureType: 'supplement',
    title: 'Log Supplement',
    quickLabel: 'From your stack',
    quick: [
      { name: 'Creatine', detail: '5 g' },
      { name: 'Omega-3', detail: '2 g' },
      { name: 'Vitamin D3', detail: '5000 IU' },
      { name: 'Magnesium', detail: '400 mg' },
    ],
    fields: [
      { key: 'name', label: 'Name', placeholder: 'e.g. Berberine' },
      { key: 'dose', label: 'Dose', placeholder: '500 mg' },
    ],
    cta: 'Log supplement',
    ctaIcon: 'medkit-outline',
    protocolToggle: true,
  },
  therapy: {
    captureType: 'therapy',
    title: 'Log Therapy',
    quickLabel: 'Recent',
    quick: [
      { name: 'Sauna', detail: '20 min · 82°C' },
      { name: 'Cold plunge', detail: '3 min · 4°C' },
      { name: 'Red light', detail: '10 min' },
    ],
    fields: [
      { key: 'type', label: 'Type', placeholder: 'Sauna, cold, red light…' },
      { key: 'duration', label: 'Duration', placeholder: '20 min' },
      { key: 'intensity', label: 'Intensity', placeholder: 'Temperature / setting' },
    ],
    cta: 'Log therapy',
    ctaIcon: 'thermometer-outline',
  },
};

const FALLBACK: CaptureConfig = {
  captureType: 'supplement',
  title: 'Capture',
  quickLabel: 'Quick log',
  quick: [],
  fields: [{ key: 'entry', label: 'Entry', placeholder: 'What happened?' }],
  cta: 'Log',
  ctaIcon: 'add-outline',
};

function SectionLabel({ children }: { children: string }) {
  return (
    <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
      {children}
    </Text>
  );
}

export default function CaptureScreen() {
  const router = useRouter();
  const { type } = useLocalSearchParams<{ type?: string }>();
  const config = (type && CONFIGS[type]) || FALLBACK;

  const [fields, setFields] = useState<Record<string, string>>({});
  const [protocol, setProtocol] = useState(false);

  const primaryKey = config.fields[0]!.key;
  const canLog = (fields[primaryKey] ?? '').trim().length > 0;

  const save = (title: string) => {
    if (!title.trim()) return;
    try {
      logCapture(getDb(), todayISODate(), config.captureType, title, { protocol });
      router.back();
    } catch (error) {
      // A failed write must not crash the tap handler.
      console.warn('[log] capture failed', error);
    }
  };

  const logManual = () => {
    const parts = config.fields.map((f) => (fields[f.key] ?? '').trim()).filter(Boolean);
    save(parts.join(' · '));
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={config.title} />
      </View>

      {/* Quick-log strip — one tap logs and returns */}
      {config.quick.length > 0 ? (
        <View className="mt-2">
          <SectionLabel>{config.quickLabel}</SectionLabel>
          <View className="mt-2 flex-row flex-wrap gap-2">
            {config.quick.map((q) => (
              <Pressable
                key={q.name}
                accessibilityRole="button"
                accessibilityLabel={`Log ${q.name} ${q.detail}`}
                onPress={() => save(`${q.name} · ${q.detail}`)}
                className="flex-row items-center gap-2 rounded-btn border border-hairline bg-porcelain py-2 pl-3 pr-3.5 active:bg-paper-deep">
                <Ionicons name="add" size={15} color={palette.inkSecondary} />
                <View>
                  <Text className="text-[13px] text-ink">{q.name}</Text>
                  <Text className="font-mono text-[10px] text-ink-muted">{q.detail}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {/* Manual add */}
      <View className="mt-8">
        <SectionLabel>Add one</SectionLabel>
        <View className="mt-2 gap-3">
          {config.fields.map((f, index) => (
            <View key={f.key}>
              <Text className="mb-1 text-xs text-ink-secondary">{f.label}</Text>
              <TextInput
                value={fields[f.key] ?? ''}
                onChangeText={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))}
                placeholder={f.placeholder}
                placeholderTextColor={palette.inkMuted}
                autoFocus={index === 0}
                className="rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3 text-[15px] text-ink"
                accessibilityLabel={f.label}
              />
            </View>
          ))}
          {config.protocolToggle ? (
            <Pressable
              accessibilityRole="switch"
              accessibilityLabel="Part of a protocol"
              accessibilityState={{ checked: protocol }}
              onPress={() => setProtocol((p) => !p)}
              className="mt-1 flex-row items-center justify-between rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3">
              <Text className="text-[13px] text-ink-secondary">Part of a protocol</Text>
              <View
                className={`h-6 w-10 rounded-full px-0.5 ${protocol ? 'bg-pine' : 'bg-hairline'}`}>
                <View
                  className={`h-5 w-5 rounded-full bg-porcelain ${protocol ? 'ml-auto' : ''}`}
                />
              </View>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* The one pine action on this screen. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={config.cta}
        accessibilityState={{ disabled: !canLog }}
        disabled={!canLog}
        onPress={logManual}
        className={`mt-6 flex-row items-center justify-center gap-2 rounded-btn py-3.5 ${
          canLog ? 'bg-pine active:opacity-70' : 'bg-hairline'
        }`}>
        <Ionicons
          name={config.ctaIcon}
          size={18}
          color={canLog ? palette.pineOn : palette.inkMuted}
        />
        <Text className={`text-[15px] font-semibold ${canLog ? 'text-pine-on' : 'text-ink-muted'}`}>
          {config.cta}
        </Text>
      </Pressable>
    </Screen>
  );
}
