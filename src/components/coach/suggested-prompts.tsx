import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';
import { useSessionKeySet } from '@/hooks/use-session-key';

/**
 * Starter prompts, shown only before the thread has anything in it — each is a
 * real question the Coach answers from the user's own on-device record.
 *
 * Conformed Set treatment — the **ruled plate** device: this is a list of
 * things, and a list of things is a record, so it is a table with ruled rows
 * rather than the chip rail it used to be. The rail was the wrong container
 * twice over: it made four equal options look like tags on something, and it
 * hid the fourth off the right edge on a narrow phone.
 *
 * **The empty thread is authored, never blank** (00-design-spec.md §5). This
 * block is the whole content of a Coach screen that has never been used, so it
 * has to say where it is and what happens next — a bare row of chips floating on
 * an empty sheet says neither. The lede is that sentence.
 *
 * Prompts are set in the serif voice because they are speech: they are the
 * user's own words, pre-drafted. No accent anywhere here — the screen's accent
 * budget is spent on the Coach presence dot, the user's bubbles and the one
 * primary action in the composer.
 *
 * ## Preview mode — the no-key state (mockup sheet C-02)
 *
 * With no model connected the Coach still works end to end, and still replies —
 * honestly, saying it cannot ground an answer (src/lib/ai/coach-service.ts).
 * So the no-key screen is not a dead composer to be blocked off; it is a real
 * screen running in a reduced mode, and what it owes the owner is the part the
 * session line has no room for: **what connecting buys, and where to do it.**
 *
 * The state itself is already reported by the session line above this block, so
 * this block does not report it again. It states the *consequence* instead
 * (these questions get answered from the record only once a model is
 * connected), then gives the destination that fixes it.
 *
 * That note takes the **margin annotation** device: it is prose about the sheet
 * rather than a record, and the margin device is UNMARKED as of 2026-08-09 — prose sits on the sheet, separated by air and distinguished by the serif voice. It is a sibling
 * of the plate, never a child — devices do not nest.
 *
 * `keySet` comes from the store hook rather than a prop because the screen does
 * not pass one and this block must not read `apiKeyStore.has()` bare in render
 * (under the React Compiler a render that reads mutable external state directly
 * can memoize stale, which is why every other reader of it takes it as a prop).
 * `useSessionKeySet` is `useSyncExternalStore`, so it re-renders the moment a
 * key is pasted into the line above and the note retires itself.
 */
const PROMPTS = [
  'How’s my recovery today?',
  'What should I prioritize?',
  'Adjust today’s plan',
  'Explain my HRV trend',
];

/** Connected: the thread is live, so the only thing missing is a first move. */
const LEDE_LIVE = 'Nothing asked yet. Pick a starting point, or type your own question below.';
/** Preview: same list, but say plainly what it can and cannot reach right now. */
const LEDE_PREVIEW =
  'Nothing asked yet. Each of these is answered from your own record — labs, wearables, today’s log. Until a model is connected the Coach replies in preview and reads none of it.';
/**
 * Where to connect one. The sentence that used to open this — "Connect a model
 * and these become real answers, grounded in your own numbers" — was a pitch,
 * not an instruction, and the lede above already states what preview cannot
 * reach. What is left is the route (owner's slop sweep, 2026-08-10).
 */
const PREVIEW_NOTE =
  'The quickest path is the line at the top of this screen; the key and the model it runs are managed in Settings.';

export function SuggestedPrompts({ onPick }: { onPick: (text: string) => void }) {
  const keySet = useSessionKeySet();
  const router = useRouter();

  return (
    <View>
      <Block device="plate">
        <SectionLabel label="Suggested Prompts" />

        <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
          {keySet ? LEDE_LIVE : LEDE_PREVIEW}
        </Text>

        <View className="mt-1">
          {PROMPTS.map((prompt) => (
            <View key={prompt}>
              {/* Unconditional: the lede paragraph above is what the first
                  rule separates this list from. */}
              <Divider />
              <Pressable
                accessibilityRole="button"
                onPress={() => onPick(prompt)}
                className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
                <Text className="flex-1 font-serif text-[15px] leading-5 text-ink">{prompt}</Text>
                <Ionicons
                  name="chevron-forward"
                  size={13}
                  color={palette.inkMuted}
                  accessibilityElementsHidden
                  importantForAccessibility="no"
                />
              </Pressable>
            </View>
          ))}
        </View>
      </Block>

      {keySet ? null : (
        <View className="mt-3">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-muted">{PREVIEW_NOTE}</Text>

            {/* The one action this empty state carries, and it is drawn in ink:
                the screen's accent belongs to the composer's send. */}
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Open Coach settings"
              onPress={() => router.push('/settings-coach')}
              className="mt-0.5 min-h-[44px] flex-row items-center gap-1.5 self-start active:opacity-60">
              <Text className="font-label text-[11px] font-semibold uppercase tracking-[1.2px] text-ink">
                Settings › Coach
              </Text>
              <Ionicons
                name="chevron-forward"
                size={12}
                color={palette.ink}
                accessibilityElementsHidden
                importantForAccessibility="no"
              />
            </Pressable>
          </Block>
        </View>
      )}
    </View>
  );
}
