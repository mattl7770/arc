import Ionicons from '@expo/vector-icons/Ionicons';
import { Link } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';

/**
 * The route that does not exist.
 *
 * **Empty is authored, never blank** (00-design-spec.md §5) — that rule applies
 * to a dead end as much as to an empty day, so this is written rather than
 * left as two lines of stray text. Conformed Set treatment: the **ruled plate**
 * device, matching MissionEmpty, which is the same shape of moment — a surface
 * that has nothing to show, says so plainly, and offers the one thing that
 * fixes it.
 *
 * It also drops the native header it used to switch back on. Every other pushed
 * screen in ARC is chrome-less by design (the root Stack sets `headerShown:
 * false`), and a lone iOS header here read as a different app. There is nothing
 * to go *back* to on a dead route anyway — the way out is Home, so the way out
 * is the action, which is this screen's single accent.
 *
 * No error code is shown. A "404" keys no user action and would be exactly the
 * invented reference code the design bans.
 */
export default function NotFoundScreen() {
  return (
    <Screen>
      <View className="flex-1 justify-center">
        <Block device="plate">
          <SectionLabel label="Route not found" />

          <Text className="mt-2.5 font-serif text-[21px] font-semibold leading-7 text-ink">
            This screen does not exist.
          </Text>

          <Text className="mt-2.5 font-serif text-[15px] leading-6 text-ink-secondary">
            The link you followed points somewhere ARC has no screen for. Nothing was lost — every
            log, protocol and lab on this device is exactly where you left it.
          </Text>

          {/* The one accent: the only way out of a dead route. */}
          <Link href="/" asChild>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to Home"
              className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70">
              <Ionicons name="home" size={17} color={palette.pineOn} />
              <Text className="font-label text-[15px] font-semibold text-pine-on">
                Back to Home
              </Text>
            </Pressable>
          </Link>
        </Block>
      </View>
    </Screen>
  );
}
