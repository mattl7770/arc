import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Divider } from '@/components/ui/block';
import { palette } from '@/constants/theme';

/**
 * Header for a stack-pushed screen (Nutrition, Exercise, the metric keypad…):
 * a back chevron and a serif title. The tab screens don't use this — they own
 * their own headers — but pushed screens have no native header (headerShown is
 * off globally), so this is how you get back.
 *
 * Conformed Set treatment — **square and ruled.** The back control loses its
 * radius (square is the point: this is a drawing, not a bubble) and the row
 * closes on a hairline, so a pushed sheet opens with its title line drawn rather
 * than floating. The rule belongs to the header band, which is an object; it is
 * not a rule across the page.
 *
 * The title is serif — "serif speaks", and a screen title is speech, not a
 * measurement (00-design-spec.md §3). It takes `flex-1` so a long title wraps
 * inside the gutter instead of running under the edge.
 *
 * The tap target is 44×44, not the 36×36 it used to be: every tappable control
 * in this design clears 44pt, and the back chevron is the most-used control in
 * the app. The negative margin is retuned to −12 so the glyph stays at the same
 * optical x as before while the target grows around it.
 *
 * ## The back control names where it goes (`parent`)
 *
 * The sheet's `.cf-back` is a chevron AND a word — `‹ Data`, `‹ Log` — with the
 * word in the label voice at 10px, sentence case, `--ink-soft`. The port dropped
 * the word, which costs more than it looks: a bare chevron says *back* and a
 * named one says *back to where*, and on a five-tab app with sub-screens pushed
 * from three different tabs, "where" is the part the reader cannot infer. It is
 * also the difference between a control and a hieroglyph for anyone using
 * VoiceOver, which is why the spoken label follows the visible word rather than
 * staying a generic "Back".
 *
 * **`parent` is optional and the bare chevron is the fallback**, deliberately.
 * This component is shared by every pushed screen in the app, and a screen
 * reachable from two places has no single true parent — guessing one puts a
 * confident lie on the most-used control on the sheet. So a screen opts in only
 * when it knows, and the screens that do not stay exactly as they were.
 */
export function StackHeader({ title, parent }: { title: string; parent?: string }) {
  const router = useRouter();
  return (
    <View>
      <View className="flex-row items-center gap-1 pb-2">
        {/* Two shapes, two whole class literals — Tailwind's scanner only sees
            names that appear literally in source. Without a word the target is
            the square 44×44 it has always been; with one it keeps the 44pt floor
            and grows sideways to fit, so the word is inside the tap target
            rather than beside it. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={parent ? `Back to ${parent}` : 'Back'}
          onPress={() => router.back()}
          className={
            parent
              ? '-ml-3 min-h-[44px] flex-row items-center gap-1 pl-3 pr-2 active:opacity-60'
              : '-ml-3 h-11 w-11 items-center justify-center active:opacity-60'
          }>
          <Ionicons name="chevron-back" size={22} color={palette.ink} />
          {parent ? (
            <Text
              numberOfLines={1}
              className="font-label text-[10px] font-semibold tracking-[0.3px] text-ink-secondary">
              {parent}
            </Text>
          ) : null}
        </Pressable>
        <Text className="flex-1 font-serif text-lg font-semibold text-ink">{title}</Text>
      </View>
      {/* The rule that closes the header band. Drawn, not a `border-b`: that is
          the same four-sided trap as `border-t` (see Divider), and on the
          shared header it would have put a box around the title of every
          pushed screen in the app. */}
      <Divider />
    </View>
  );
}
