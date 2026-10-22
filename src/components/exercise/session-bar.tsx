import Ionicons from '@expo/vector-icons/Ionicons';
import {
  useFocusEffect,
  useIsFocused,
  useNavigation,
  useNavigationContainerRef,
  useRoute,
  useRouter,
} from 'expo-router';
import { useCallback, useEffect, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { Divider } from '@/components/ui/block';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { subscribeWorkoutDrafts } from '@/lib/db/repositories/workout-drafts';
import {
  barHearsSlot,
  LIVE_LOGGER_RESUME,
  readOpenLiveSession,
  sameSessionBar,
  sessionBarOnScreen,
  sessionBarView,
  type OpenLiveSession,
  type SessionBarView,
} from '@/lib/exercise/session-bar';
import { restTapTarget, type NavStateLike } from '@/lib/notifications/taps';

/**
 * The workout in progress, as one slim line (item 71, owner: *"should be able
 * to use the rest of the app while in an exercise session"*). The decisions are
 * in src/lib/exercise/session-bar.ts; this file is the reading and the drawing.
 *
 * ## Where it is drawn
 *
 *   - **Above the tab bar**, from the tab navigator's `tabBar`
 *     (`app/(tabs)/_layout.tsx`, {@link TabSessionBar}). The tab bar is in the
 *     tab view's flex column, not floated over it, so the bar shortens every tab
 *     root by its own height and covers nothing.
 *   - **At the foot of every pushed screen**, from `Screen`
 *     (src/components/ui/screen.tsx, {@link useScreenSession}), after its
 *     safe-area view — so the screen's scroll view ends above the bar and its
 *     last row still scrolls clear. It is part of the screen, so it slides in
 *     and out with it on a push or a back swipe instead of jumping between two
 *     hosts. Never on the live logger itself.
 *
 * ## The keyboard
 *
 * The bar is in the layout, never floated: when the keyboard rises it covers
 * the bar along with the tab bar, and the screens' own keyboard handling
 * (`automaticallyAdjustKeyboardInsets`, the Coach's `KeyboardAvoidingView`)
 * measures the overlap against their own frames, which the bar has already
 * shortened — so nothing has to know the bar is there.
 *
 * ## The look (the Conformed Set)
 *
 * Chrome, like the logger's docked rest line it reports on: plate stock
 * (`paper-hi`) under a 1px filled rule, square, no device — a device frames a
 * content block, and this is part of the frame. Serif names the workout, mono
 * measures both clocks, the label voice says REST. **No accent**: the bar is a
 * door, as Home's Resume row is, and the active tab directly beneath already
 * spends the accent on this part of the screen. "Rest done" is told by its
 * words and by ink weight, not by colour — it is not biology, so no signal
 * colour either.
 */

/**
 * The open session, kept current. Read on mount, re-read whenever the LIVE
 * slot is written or cleared anywhere (`subscribeWorkoutDrafts`; a manual
 * logger's writes are not the bar's) and when the host regains focus — and
 * the session already held is kept when the read would draw the same bar, so
 * a keystroke in the logger re-renders no host (`sameSessionBar`). `enabled` false reads and hears nothing — a tab root's
 * `Screen` never draws the bar, so it should not pay for it either.
 */
function useOpenLiveSession(enabled: boolean): OpenLiveSession | null {
  const read = useCallback((): OpenLiveSession | null => {
    if (!enabled) return null;
    try {
      return readOpenLiveSession(getDb());
    } catch (error) {
      // The bar is a shortcut; a failed read must never take a screen with it.
      console.warn('[exercise] session bar read failed', error);
      return null;
    }
  }, [enabled]);
  const [session, setSession] = useState(read);
  const refresh = useCallback(() => {
    const next = read();
    setSession((prev) => (sameSessionBar(prev, next) ? prev : next));
  }, [read]);
  useEffect(() => {
    if (!enabled) return;
    return subscribeWorkoutDrafts((key) => {
      if (barHearsSlot(key)) refresh();
    });
  }, [enabled, refresh]);
  // Focus is the belt to the subscription's braces: nothing writes the slot
  // without announcing it, but a host coming back into view re-reads anyway.
  useFocusEffect(refresh);
  return session;
}

/**
 * The clock the bar is redrawn on — once a second, and only while there is
 * something on screen to redraw. It counts nothing: every figure on the bar is
 * computed from the draft's own instants against this `now`.
 */
function useNow(running: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    // Catch up at once on coming back into view (a host that sat under the
    // logger for ten minutes must not show a ten-minute-old clock for a second),
    // then once a second.
    const tick = () => setNow(Date.now());
    const first = setTimeout(tick, 0);
    const timer = setInterval(tick, 1000);
    return () => {
      clearTimeout(first);
      clearInterval(timer);
    };
  }, [running]);
  return now;
}

/**
 * The open session for a pushed screen's foot, or null — `Screen` calls this
 * and, when there is one, draws {@link LiveSessionBar} and hands it the bottom
 * safe-area inset instead of its own safe-area view (a screen that asked for
 * the bottom edge would otherwise pad for the home indicator twice). It does
 * not tick: the one-second clock lives in the bar, so a screen is not
 * re-rendered every second for it.
 */
export function useScreenSession(): OpenLiveSession | null {
  const navigation = useNavigation();
  const route = useRoute();
  const enabled = sessionBarOnScreen(navigation.getState?.()?.type, route?.name);
  return useOpenLiveSession(enabled);
}

/** The bar for an open session, redrawn each second while its host is on screen. */
export function LiveSessionBar({
  session,
  inset = 0,
}: {
  session: OpenLiveSession;
  inset?: number;
}) {
  const now = useNow(useIsFocused());
  return <SessionBar view={sessionBarView(session, now)} inset={inset} />;
}

/** The bar above the tab bar. Still while a pushed screen covers the tabs. */
export function TabSessionBar() {
  const session = useOpenLiveSession(true);
  return session ? <LiveSessionBar session={session} /> : null;
}

/**
 * The bar itself. One button, 44pt — the whole line is the target. `inset`
 * is the bottom safe-area padding, given only at a pushed screen's foot (the
 * tab bar carries the inset under the tab bar's copy).
 *
 * **A tap never stacks a second logger over the first** (review, 2026-10-21).
 * The logger pushes screens of its own (an exercise's detail, which draws this
 * bar at its foot), and Home can be pushed over it; a bare push from there put
 * a second logger on the stack, and the first then read "session ended". So
 * the tap asks the question the "Rest complete" tap asks (`restTapTarget`,
 * src/lib/notifications/taps.ts): a live logger lower in the stack is gone
 * back to, as it was (`dismissTo` with its own params); with none, the
 * session is resumed by a push, as Home's Resume row does.
 */
export function SessionBar({ view, inset = 0 }: { view: SessionBarView; inset?: number }) {
  const router = useRouter();
  const navRef = useNavigationContainerRef();
  const open = () => {
    let state: NavStateLike | undefined;
    try {
      state = navRef.isReady() ? (navRef.getRootState() as NavStateLike | undefined) : undefined;
    } catch {
      // No state to read: the stored session decides, as for the rest tap.
      state = undefined;
    }
    const target = restTapTarget(state, true);
    if (target.kind === 'return') {
      router.dismissTo({
        pathname: LIVE_LOGGER_RESUME.pathname,
        params: target.params as Record<string, string>,
      });
    } else if (target.kind === 'resume') {
      router.push(LIVE_LOGGER_RESUME);
    }
  };
  return (
    <View className="bg-paper-hi" style={inset > 0 ? { paddingBottom: inset } : undefined}>
      {/* The bar's top edge, as the logger's rest line draws its own: a filled
          1px view, because a `border-t` here would draw all four sides. */}
      <Divider />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={view.accessibilityLabel}
        onPress={open}
        className="min-h-[44px] flex-row items-center gap-3 px-5 active:bg-paper-dim">
        <Text className="shrink font-serif text-[14px] text-ink" numberOfLines={1}>
          {view.name}
        </Text>
        {view.elapsed ? (
          <Text className="font-mono text-[13px] text-ink-secondary">{view.elapsed}</Text>
        ) : null}
        <View className="flex-1" />
        {view.rest?.kind === 'running' ? (
          <View className="flex-row items-baseline gap-1.5">
            <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
              Rest
            </Text>
            <Text className="font-mono text-[15px] text-ink">{view.rest.clock}</Text>
          </View>
        ) : view.rest?.kind === 'done' ? (
          <Text className="font-label text-[11px] font-semibold uppercase tracking-[1.2px] text-ink">
            Rest done
          </Text>
        ) : null}
        <Ionicons name="chevron-forward" size={12} color={palette.inkMuted} />
      </Pressable>
    </View>
  );
}
