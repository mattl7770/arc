import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
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
 *
 * Conformed Set treatment (00-design-spec.md §1): this screen is all controls,
 * so it carries no content blocks of its own — the shared `SectionLabel` names
 * each group and whitespace separates them. That absence is a **decision, not
 * an oversight**: it is form (b) of the capture-surface rule written down in
 * src/components/ui/block.tsx. Text fields are drawn as **recessed stock** (the
 * well's paper-dim on paper-deep), because an input well is what they are.
 * Every dose and duration is mono; every button and chip is the label voice.
 * The single accent is the CTA — the protocol switch is stamped in ink, since a
 * toggle is chrome, not the one next action.
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

/**
 * A text field drawn as recessed stock — the well device's own surface, applied
 * to the control directly. This is form (b) of the capture-surface rule in
 * src/components/ui/block.tsx: a *group* of labelled fields carries no block,
 * and each field wears `border-paper-deep bg-paper-dim` itself. Wrapping the
 * group in a `<Block device="well">` would stack a recess on a recess and force
 * these inputs up onto plate stock to stay legible — the inversion that rule
 * exists to stop. An input is never `bg-paper-hi`.
 */
const INPUT = 'border border-paper-deep bg-paper-dim px-3.5 py-3 font-serif text-[15px] text-ink';

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
          <SectionLabel label={config.quickLabel} />
          <View className="mt-2 flex-row flex-wrap gap-2">
            {config.quick.map((q) => (
              <Pressable
                key={q.name}
                accessibilityRole="button"
                accessibilityLabel={`Log ${q.name} ${q.detail}`}
                onPress={() => save(`${q.name} · ${q.detail}`)}
                className="min-h-[44px] flex-row items-center gap-2 rounded-btn border border-hairline bg-paper-hi py-2 pl-3 pr-3.5 active:bg-paper-dim">
                <Ionicons name="add" size={15} color={palette.inkSecondary} />
                <View>
                  <Text className="font-label text-[13px] font-semibold text-ink">{q.name}</Text>
                  {/* A dose is a measurement — mono, always. */}
                  <Text className="font-mono text-[10px] text-ink-muted">{q.detail}</Text>
                </View>
              </Pressable>
            ))}
          </View>
        </View>
      ) : null}

      {/* Manual add */}
      <View className="mt-8">
        <SectionLabel label="Add one" />
        <View className="mt-2 gap-3">
          {config.fields.map((f, index) => (
            <View key={f.key}>
              <Text className="mb-1.5 font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
                {f.label}
              </Text>
              <TextInput
                value={fields[f.key] ?? ''}
                onChangeText={(v) => setFields((prev) => ({ ...prev, [f.key]: v }))}
                placeholder={f.placeholder}
                placeholderTextColor={palette.inkMuted}
                autoFocus={index === 0}
                className={INPUT}
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
              className="mt-1 min-h-[44px] flex-row items-center justify-between border border-paper-deep bg-paper-dim px-3.5 py-3">
              <Text className="font-serif text-[14px] text-ink-secondary">Part of a protocol</Text>
              {/* Square track, square knob — corners are square across this
                  design — and stamped in ink, not pine: a switch is chrome. */}
              <View
                className={
                  protocol
                    ? 'h-6 w-11 justify-center bg-ink p-[3px]'
                    : 'h-6 w-11 justify-center bg-paper-deep p-[3px]'
                }>
                <View
                  className={
                    protocol
                      ? 'ml-auto h-[18px] w-[18px] bg-paper-hi'
                      : 'h-[18px] w-[18px] bg-paper-hi'
                  }
                />
              </View>
            </Pressable>
          ) : null}
        </View>
      </View>

      {/* The one pine action on this screen. Disabled is a bordered recess:
          ink-muted clears 4.5:1 on paper-dim, which it does not on hairline. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={config.cta}
        accessibilityState={{ disabled: !canLog }}
        disabled={!canLog}
        onPress={logManual}
        className={
          canLog
            ? 'mt-6 min-h-[48px] flex-row items-center justify-center gap-2 rounded-btn bg-pine active:opacity-70'
            : 'mt-6 min-h-[48px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline bg-paper-dim'
        }>
        <Ionicons
          name={config.ctaIcon}
          size={18}
          color={canLog ? palette.pineOn : palette.inkMuted}
        />
        <Text
          className={
            canLog
              ? 'font-label text-[12px] font-semibold uppercase tracking-[1px] text-pine-on'
              : 'font-label text-[12px] font-semibold uppercase tracking-[1px] text-ink-muted'
          }>
          {config.cta}
        </Text>
      </Pressable>
    </Screen>
  );
}
