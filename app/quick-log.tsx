import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useRef, useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import { getDb } from '@/lib/db/client';
import { todayISODate } from '@/lib/db/date';
import { logNote } from '@/lib/db/repositories/logs';
import { recordScreenTime } from '@/lib/db/repositories/screen-time';
import { logMetricCapture } from '@/lib/health/publish';
import { formatMeasured, metricByKey, resolveDisplay } from '@/lib/log/metrics';
import { quickLineAction } from '@/lib/log/quick-line';
import { isMealEstimationAvailable } from '@/lib/nutrition/estimate';
import { filedDayWords, formatHm } from '@/lib/screen-time/entry';
import { noteTypedScreenTime } from '@/lib/screen-time/receipt-store';

/**
 * The quick-log box (owner, item 63: *"Action button brings up log anything box
 * + this works for foods, if possible a button to open photo logger too"*).
 *
 * Opened by the Action Button's "Log in ARC" App Intent or an `arc://quick`
 * link — both held behind the app lock until the app can show it
 * (src/lib/log/quick-launch.ts) — and drawn as the Log tab's command field is:
 * one recessed well that IS the input, the screen's one pine action docked to
 * its right. The keyboard is up on arrival; that is the whole point of a button
 * on the side of the phone.
 *
 * What a line does is `quickLineAction` (src/lib/log/quick-line.ts):
 *   - a metric ("weight 178", "16 oz water", "st 200") files exactly as the Log
 *     tab files it, under the LOGICAL day, and says what it filed;
 *   - anything else is a food description, handed to the describe-estimate
 *     screen with the words as a param — nothing is written until its review is
 *     saved. Without a model key the words are kept as a note instead, so the
 *     line is never lost to a screen that cannot use it.
 *
 * The camera opens the photo logger: the same screen, straight into the
 * viewfinder, as the Eat tab's Photo quick-log.
 *
 * Both hand-offs REPLACE this screen, so the estimate's Save — which goes back —
 * lands on whatever was open before the button was pressed, not on an empty box.
 */
export default function QuickLogScreen() {
  const router = useRouter();
  const { units } = useUnitPreferences();
  const inputRef = useRef<TextInput>(null);
  const [text, setText] = useState('');
  const [receipt, setReceipt] = useState<string | null>(null);

  // Back on this screen (say, from the estimate's back chevron): the keyboard
  // comes back with it. `autoFocus` covers the first arrival.
  useFocusEffect(
    useCallback(() => {
      inputRef.current?.focus();
    }, [])
  );

  const canSend = text.trim().length > 0;

  const send = () => {
    const now = new Date();
    const action = quickLineAction(text, units, now);
    if (action.kind === 'empty') return;
    if (action.kind === 'food' && isMealEstimationAvailable()) {
      router.replace({ pathname: '/meal-estimate', params: { describe: action.description } });
      return;
    }
    const db = getDb();
    const date = todayISODate(now);
    try {
      if (action.kind === 'screen_time') {
        const write = recordScreenTime(db, action.date, action.minutes, 'typed');
        // The Log tab's receipt row reports it too, with its Undo.
        noteTypedScreenTime(write.id);
        setReceipt(
          `Screen time ${formatHm(action.minutes)} filed to ${filedDayWords(action.date, date)}.`
        );
      } else if (action.kind === 'metric') {
        logMetricCapture(db, date, action.metric, action.canonical);
        const metric = metricByKey(action.metric);
        setReceipt(
          metric
            ? `Logged ${metric.label.toLowerCase()} ${formatMeasured(resolveDisplay(metric, units), action.canonical)}.`
            : 'Logged.'
        );
      } else if (action.kind === 'note') {
        logNote(db, date, action.text);
        setReceipt('Saved as a note — that number is outside what the record takes.');
      } else {
        // Food with no model key: kept, not dropped.
        logNote(db, date, action.description);
        setReceipt(
          'Saved as a note. Estimating food needs a model key — add one in the Coach tab.'
        );
      }
      setText('');
    } catch (error) {
      // A failed write must not crash the tap handler; the words stay to retry.
      console.warn('[quick-log] capture failed', error);
      setReceipt('Couldn’t save that. Try again.');
    }
  };

  const openCamera = () => {
    router.replace({ pathname: '/meal-estimate', params: { start: 'camera' } });
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Log" />
      </View>

      <View className="mt-2">
        <Block device="well">
          <View className="flex-row items-end gap-2.5">
            <View className="max-h-28 min-h-[44px] flex-1 justify-center">
              <TextInput
                ref={inputRef}
                value={text}
                onChangeText={(next) => {
                  setText(next);
                  if (receipt) setReceipt(null);
                }}
                placeholder="What did you eat? Or “weight 178”…"
                placeholderTextColor={palette.inkMuted}
                autoFocus
                multiline
                // Return sends, as the arrow does: a quick line is one line.
                submitBehavior="submit"
                returnKeyType="send"
                onSubmitEditing={send}
                className="py-2 font-serif text-[15px] leading-5 text-ink"
                accessibilityLabel="Log anything"
              />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Log entry"
              accessibilityState={{ disabled: !canSend }}
              disabled={!canSend}
              onPress={send}
              className={
                canSend
                  ? 'h-11 w-11 items-center justify-center rounded-btn bg-pine active:opacity-70'
                  : 'h-11 w-11 items-center justify-center rounded-btn border border-paper-deep'
              }>
              <Ionicons
                name="arrow-up"
                size={22}
                color={canSend ? palette.pineOn : palette.inkMuted}
              />
            </Pressable>
          </View>
        </Block>
      </View>

      {/* The photo logger, outlined: the accent on this screen belongs to send. */}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Photograph a meal"
        onPress={openCamera}
        className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:opacity-60">
        <Ionicons name="camera-outline" size={18} color={palette.inkSecondary} />
        <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
          Photograph a meal
        </Text>
      </Pressable>

      <View className="mt-4">
        <Block device="margin">
          {receipt ? (
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">{receipt}</Text>
          ) : (
            <Text className="font-serif text-[13px] leading-5 text-ink-muted">
              A number with a metric (“weight 178”, “16 oz water”) files it. Anything else is
              estimated as food, and nothing is logged until you review it.
            </Text>
          )}
        </Block>
      </View>
    </Screen>
  );
}
