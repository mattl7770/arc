import Ionicons from '@expo/vector-icons/Ionicons';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { useSessionKeySet } from '@/hooks/use-session-key';
import {
  isPhotoReadingAvailable,
  PHOTO_ANALYSIS_PRIVACY_LINE,
  PhotoReadingUnavailableError,
  readPhotos,
  type PhotoReadingInput,
} from '@/lib/photos/analyze';
import type { PhotoReading } from '@/lib/photos/types';

/**
 * The on-demand AI reading, as a panel — shared by the detail screen ("Read this
 * photo") and the compare screen ("Compare these two"), because they are the
 * same four beats with a different payload and it is the beats that must not
 * drift (docs/progress-photos-subapp.md §5).
 *
 * ```
 * idle ── tap ──▶ confirm (privacy line + Send) ──▶ reading (ONLINE, one turn,
 *                                                   no tools, abort on unmount)
 *      ──▶ review (offline) ──▶ Save   → a progress_photo_analyses row
 *                            ·  Discard → nothing written
 * ```
 *
 * **Nothing is written until Save**, which matters more here than for a meal
 * estimate: a reading has no other landing table, so the review gate is the only
 * thing standing between a model's first draft and the permanent record.
 *
 * **The privacy line is shown every time**, verbatim, immediately above the
 * control that sends. Not once at first use, not in Settings: the thing it
 * describes happens on every tap.
 *
 * **Accent budget: one per phase, and the phases are exclusive.** Read (idle),
 * Send (confirm), Save (review).
 */
type Phase =
  | { kind: 'idle' }
  | { kind: 'confirm' }
  | { kind: 'reading' }
  | { kind: 'review'; reading: PhotoReading; model: string }
  | { kind: 'error'; message: string };

const DIRECTION_MARK: Record<string, string> = {
  leaner: '↓',
  fuller: '↑',
  unchanged: '=',
  unclear: '?',
};

export function PhotoReadingPanel({
  action,
  what,
  buildInput,
  onSave,
}: {
  /** The idle control's label — "Read this photo" / "Compare these two". */
  action: string;
  /** What is being read, for the review's future-tense consequence line. */
  what: string;
  /**
   * Assemble the payload: the working copies downscaled to 1024px plus ARC's own
   * numeric truth. Async because the downscale is; null when the pixels could
   * not be read (a missing file, no manipulator in this binary).
   */
  buildInput: () => Promise<PhotoReadingInput | null>;
  /** Persist the reading. Called only from Save, never from the model call. */
  onSave: (reading: PhotoReading, model: string) => void;
}) {
  // `useSessionKeySet` is a useSyncExternalStore over the key mirror, so this
  // re-renders the moment a key lands in the Keychain — the affordance is never
  // stale in either direction.
  const keySet = useSessionKeySet();
  const available = keySet && isPhotoReadingAvailable();
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  // The model call is a live stream. Leaving mid-reading must stop it, or it
  // runs to completion and is billed in full while its result lands on an
  // unmounted screen (app/meal-estimate.tsx does exactly this).
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);

  const send = async () => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhase({ kind: 'reading' });
    try {
      const input = await buildInput();
      if (controller.signal.aborted) return;
      if (!input) {
        setPhase({
          kind: 'error',
          message:
            'Couldn’t read the image off disk. If it says “not on this phone”, the file didn’t come across with the database.',
        });
        return;
      }
      const { reading, model } = await readPhotos(input, controller.signal);
      if (controller.signal.aborted) return;
      setPhase({ kind: 'review', reading, model });
    } catch (error) {
      if (controller.signal.aborted) return;
      const message =
        error instanceof PhotoReadingUnavailableError
          ? error.message
          : error instanceof Error && error.message.includes('caveats')
            ? error.message
            : 'Couldn’t read the photos. Check your connection and try again.';
      setPhase({ kind: 'error', message });
    }
  };

  if (!available) {
    return (
      <View className="mt-6">
        <Block device="margin">
          <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
            Reading a photo needs a model key — the same one the Coach uses.
          </Text>
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-muted">
            Add one in the Coach tab. Everything else on this screen works offline.
          </Text>
        </Block>
      </View>
    );
  }

  if (phase.kind === 'idle') {
    return (
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={action}
        onPress={() => setPhase({ kind: 'confirm' })}
        className="mt-6 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70">
        <Ionicons name="sparkles-outline" size={18} color={palette.pineOn} />
        <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
          {action}
        </Text>
      </Pressable>
    );
  }

  if (phase.kind === 'confirm') {
    return (
      <View className="mt-6">
        <Block device="margin">
          <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
            {PHOTO_ANALYSIS_PRIVACY_LINE}
          </Text>
        </Block>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Send for a reading"
          onPress={() => void send()}
          className="mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70">
          <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
            Send
          </Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Cancel the reading"
          onPress={() => setPhase({ kind: 'idle' })}
          className="mt-2 min-h-[44px] items-center justify-center active:opacity-60">
          <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
            Not now
          </Text>
        </Pressable>
      </View>
    );
  }

  if (phase.kind === 'reading') {
    return (
      <View className="mt-8 items-center">
        <ActivityIndicator color={palette.ink} />
        <Text className="mt-3 font-serif text-[14px] text-ink-secondary">Reading the photos…</Text>
      </View>
    );
  }

  if (phase.kind === 'error') {
    return (
      <View className="mt-6">
        <Block device="margin">
          <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
            {phase.message}
          </Text>
        </Block>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Try the reading again"
          onPress={() => setPhase({ kind: 'confirm' })}
          className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
          <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
            Try again
          </Text>
        </Pressable>
      </View>
    );
  }

  const { reading, model } = phase;
  return (
    <View className="mt-6">
      <Block device="plate">
        <SectionLabel label="Reading" note="est · AI" />
        <Text className="mt-2 font-serif text-[15px] leading-6 text-ink">{reading.summary}</Text>

        {reading.changes.length > 0 ? (
          <View className="mt-3">
            {reading.changes.map((change, index) => (
              <View key={`${change.area}-${index}`}>
                <Divider first={index === 0} />
                <View className="flex-row items-baseline gap-2 py-2">
                  <Text className="w-4 font-mono text-[12px] text-ink-secondary">
                    {DIRECTION_MARK[change.direction] ?? '?'}
                  </Text>
                  <Text className="flex-1 font-serif text-[13px] leading-5 text-ink-secondary">
                    <Text className="font-label text-[11px] uppercase tracking-[0.6px] text-ink">
                      {change.area}
                    </Text>
                    {'  '}
                    {change.note}
                  </Text>
                  <Text className="font-mono text-[10px] text-ink-muted">{change.direction}</Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}

        {reading.observations.length > 0 ? (
          <View className="mt-3">
            {reading.observations.map((observation, index) => (
              <View key={`${observation.area}-${index}`}>
                <Divider first={index === 0 && reading.changes.length === 0} />
                <View className="py-2">
                  <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                    <Text className="font-label text-[11px] uppercase tracking-[0.6px] text-ink">
                      {observation.area}
                    </Text>
                    {'  '}
                    {observation.note}
                  </Text>
                </View>
              </View>
            ))}
          </View>
        ) : null}
      </Block>

      {/* The caveats are not a footnote. They are the reason the reading is
          allowed to exist at all, so they sit outside the plate, in the margin
          voice, where prose belongs. */}
      <View className="mt-3">
        <Block device="margin">
          <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
            {reading.caveats}
          </Text>
        </Block>
      </View>

      <Text className="mt-3 font-mono text-[10px] text-ink-muted">
        {model}
        {reading.confidence ? ` · ${reading.confidence} confidence` : ''}
      </Text>

      {/* The decision, in future tense, immediately above the control that
          performs it — and nothing after it but its other branch. */}
      <Text className="mt-5 font-serif text-[13px] leading-5 text-ink-muted">
        On save: kept with {what}, labelled as an AI reading. Discarding writes nothing — and
        re-reading costs another call.
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Save this reading"
        onPress={() => {
          onSave(reading, model);
          setPhase({ kind: 'idle' });
        }}
        className="mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70">
        <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
          Save reading
        </Text>
      </Pressable>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Discard this reading"
        onPress={() => setPhase({ kind: 'idle' })}
        className="mt-2 min-h-[44px] items-center justify-center active:opacity-60">
        <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
          Discard
        </Text>
      </Pressable>
    </View>
  );
}

/** A saved reading, rendered read-only on the detail and compare screens. */
export function SavedReading({
  summary,
  caveats,
  model,
  createdAt,
  observations,
  changes,
  pairLabel,
  first,
}: {
  summary: string;
  caveats: string;
  model: string;
  createdAt: string;
  observations: { area: string; note: string }[];
  changes: { area: string; direction: string; note: string }[];
  /** "vs 12 Jan 2026" when this is a pair reading; omitted for a single. */
  pairLabel?: string;
  first: boolean;
}) {
  return (
    <View>
      <Divider first={first} />
      <View className="py-3">
        <View className="flex-row items-baseline gap-2">
          <Text className="flex-1 font-serif text-[14px] leading-5 text-ink">{summary}</Text>
          <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
            est · AI
          </Text>
        </View>
        {changes.map((change, index) => (
          <Text
            key={`${change.area}-${index}`}
            className="mt-1.5 font-serif text-[12px] leading-5 text-ink-secondary">
            <Text className="font-mono text-[11px] text-ink-muted">
              {DIRECTION_MARK[change.direction] ?? '?'}{' '}
            </Text>
            <Text className="font-label text-[10px] uppercase tracking-[0.6px] text-ink">
              {change.area}
            </Text>
            {'  '}
            {change.note}
          </Text>
        ))}
        {observations.map((observation, index) => (
          <Text
            key={`${observation.area}-${index}`}
            className="mt-1.5 font-serif text-[12px] leading-5 text-ink-secondary">
            <Text className="font-label text-[10px] uppercase tracking-[0.6px] text-ink">
              {observation.area}
            </Text>
            {'  '}
            {observation.note}
          </Text>
        ))}
        <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">{caveats}</Text>
        <Text className="mt-1.5 font-mono text-[10px] text-ink-muted">
          {createdAt.slice(0, 10)} · {model}
          {pairLabel ? ` · ${pairLabel}` : ''}
        </Text>
      </View>
    </View>
  );
}
