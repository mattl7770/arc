import Ionicons from '@expo/vector-icons/Ionicons';
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { logMetric, logNote } from '@/lib/db/repositories/logs';
import { isLoggableCanonical, metricByKey } from '@/lib/log/metrics';
import { parseCommand } from '@/lib/log/parse';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';

/**
 * The Log tab hero (direction A, "Open Line"): a recessed "Log anything…" field
 * with the screen's one pine action docked to its right.
 *
 * The pine button does double duty — a **mic** when the field is empty (voice
 * capture arrives with the Coach, Phase 3), a **send** arrow once there's text
 * (functional now). On send, the text runs through the offline parser
 * (src/lib/log/parse.ts): a recognised metric ("weight 178") is logged to its
 * table, everything else is saved as a free note for the Coach.
 */
export function CommandField({ onLogged }: { onLogged: () => void }) {
  const [text, setText] = useState('');
  const [voiceHint, setVoiceHint] = useState(false);
  const { units } = useUnitPreferences();

  const trimmed = text.trim();
  const canSend = trimmed.length > 0;

  const changeText = (next: string) => {
    setText(next);
    if (voiceHint) setVoiceHint(false);
  };

  const send = () => {
    if (!trimmed) return;
    const db = getDb();
    const date = todayISODate();
    const result = parseCommand(trimmed, units);
    try {
      const metric = result.kind === 'metric' ? metricByKey(result.metric) : undefined;
      if (result.kind === 'metric' && metric && isLoggableCanonical(metric, result.canonical)) {
        logMetric(db, date, result.metric, result.canonical);
      } else {
        // A plain note, or a parsed-but-out-of-range value ("weight 0",
        // "bf 150") — never lose the input; keep the raw text as a note.
        logNote(db, date, trimmed);
      }
      setText('');
      onLogged();
    } catch (error) {
      // A failed write must not crash the tap handler; keep the text so the
      // user can retry rather than silently losing it.
      console.warn('[log] capture failed', error);
    }
  };

  const tapMic = () => setVoiceHint(true);

  return (
    <View className="rounded-card border border-hairline bg-porcelain p-3">
      {/* items-end (not stretch) keeps the pine action a fixed stamp — a
          multi-line note grows the field, never the accent. */}
      <View className="flex-row items-end gap-2.5">
        <View className="max-h-28 min-h-[48px] flex-1 justify-center rounded-btn border border-hairline-soft bg-paper-deep px-3.5">
          <TextInput
            value={text}
            onChangeText={changeText}
            placeholder="Log anything…"
            placeholderTextColor={palette.inkMuted}
            multiline
            className="py-2.5 text-[15px] leading-5 text-ink"
            accessibilityLabel="Log anything"
          />
        </View>
        {canSend ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Log entry"
            onPress={send}
            className="h-12 w-[52px] items-center justify-center rounded-btn bg-pine active:opacity-70">
            <Ionicons name="arrow-up" size={22} color={palette.pineOn} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Voice log"
            onPress={tapMic}
            className="h-12 w-[52px] items-center justify-center rounded-btn bg-pine active:opacity-70">
            <Ionicons name="mic-outline" size={22} color={palette.pineOn} />
          </Pressable>
        )}
      </View>

      <View className="mt-2.5 flex-row items-start gap-2 px-0.5">
        <Ionicons
          name="reader-outline"
          size={13}
          color={palette.inkMuted}
          style={{ marginTop: 2 }}
          accessibilityElementsHidden
          importantForAccessibility="no"
        />
        <Text className="flex-1 text-xs leading-5 text-ink-muted">
          {voiceHint ? (
            <Text className="text-ink-secondary">Voice capture arrives with the Coach.</Text>
          ) : (
            <>
              Type to log. A number with a metric (“weight 178”) files it; anything else is saved as
              a <Text className="text-ink-secondary">note for Coach</Text>.
            </>
          )}
        </Text>
      </View>
    </View>
  );
}
