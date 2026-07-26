import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams } from 'expo-router';
import { Text, View } from 'react-native';

import { MockupNote } from '@/components/ui/mockup-note';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';

/**
 * Focused capture sheet reached from a quick-capture tile (Supplement, Therapy).
 *
 * DESIGN MOCKUP — real layout, mock content, nothing persists yet. The pattern:
 * a quick-log strip of the things you take/do most (one tap), then a manual
 * "add one" form for anything new. Supplement folds Medication/peptides in as a
 * type toggle (docs/information-architecture.md). Until this is wired, the
 * command field on the Log tab captures any of it as a note.
 */
type QuickItem = { name: string; detail: string };
type Field = { label: string; placeholder: string };
type CaptureConfig = {
  title: string;
  quickLabel: string;
  quick: QuickItem[];
  fields: Field[];
  cta: string;
  ctaIcon: keyof typeof Ionicons.glyphMap;
};

const CONFIGS: Record<string, CaptureConfig> = {
  supplement: {
    title: 'Log Supplement',
    quickLabel: 'From your stack',
    quick: [
      { name: 'Creatine', detail: '5 g' },
      { name: 'Omega-3', detail: '2 g' },
      { name: 'Vitamin D3', detail: '5000 IU' },
      { name: 'Magnesium', detail: '400 mg' },
    ],
    fields: [
      { label: 'Name', placeholder: 'e.g. Berberine' },
      { label: 'Dose', placeholder: '500 mg' },
      { label: 'When', placeholder: 'Now' },
    ],
    cta: 'Log supplement',
    ctaIcon: 'medkit-outline',
  },
  therapy: {
    title: 'Log Therapy',
    quickLabel: 'Recent',
    quick: [
      { name: 'Sauna', detail: '20 min · 82°C' },
      { name: 'Cold plunge', detail: '3 min · 4°C' },
      { name: 'Red light', detail: '10 min' },
    ],
    fields: [
      { label: 'Type', placeholder: 'Sauna, cold, red light…' },
      { label: 'Duration', placeholder: '20 min' },
      { label: 'Intensity', placeholder: 'Temperature / setting' },
    ],
    cta: 'Log therapy',
    ctaIcon: 'thermometer-outline',
  },
};

const FALLBACK: CaptureConfig = {
  title: 'Capture',
  quickLabel: 'Quick log',
  quick: [],
  fields: [{ label: 'Entry', placeholder: 'What happened?' }],
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
  const { type } = useLocalSearchParams<{ type?: string }>();
  const config = (type && CONFIGS[type]) || FALLBACK;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={config.title} />
      </View>

      {/* Quick-log strip */}
      {config.quick.length > 0 ? (
        <View className="mt-2">
          <SectionLabel>{config.quickLabel}</SectionLabel>
          <View className="mt-2 flex-row flex-wrap gap-2">
            {config.quick.map((q) => (
              <View
                key={q.name}
                className="flex-row items-center gap-2 rounded-btn border border-hairline bg-porcelain py-2 pl-3 pr-3.5">
                <Ionicons name="add" size={15} color={palette.inkSecondary} />
                <View>
                  <Text className="text-[13px] text-ink">{q.name}</Text>
                  <Text className="font-mono text-[10px] text-ink-muted">{q.detail}</Text>
                </View>
              </View>
            ))}
          </View>
        </View>
      ) : null}

      {/* Manual add */}
      <View className="mt-8">
        <SectionLabel>Add one</SectionLabel>
        <View className="mt-2 gap-3">
          {config.fields.map((f) => (
            <View key={f.label}>
              <Text className="mb-1 text-xs text-ink-secondary">{f.label}</Text>
              <View className="rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3">
                <Text className="text-[15px] text-ink-muted">{f.placeholder}</Text>
              </View>
            </View>
          ))}
          {type === 'supplement' ? (
            <View className="mt-1 flex-row items-center justify-between rounded-btn border border-hairline-soft bg-paper-deep px-3.5 py-3">
              <Text className="text-[13px] text-ink-secondary">Part of a protocol</Text>
              <View className="h-6 w-10 justify-center rounded-full bg-hairline px-0.5">
                <View className="h-5 w-5 rounded-full bg-porcelain" />
              </View>
            </View>
          ) : null}
        </View>
      </View>

      {/* The one pine action on this screen. */}
      <View className="mt-6 flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5">
        <Ionicons name={config.ctaIcon} size={18} color={palette.pineOn} />
        <Text className="text-[15px] font-semibold text-pine-on">{config.cta}</Text>
      </View>

      <MockupNote>
        Design mockup — the one-tap quick log and this capture sheet wire up next. Nothing here
        saves yet; for now the command field on the Log tab captures any of it. Spec ·
        docs/information-architecture.md
      </MockupNote>
    </Screen>
  );
}
