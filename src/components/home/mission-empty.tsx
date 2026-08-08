import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { palette } from '@/constants/theme';

type Props = {
  /** True when at least one active protocol has a live version. */
  hasActiveProtocols: boolean;
};

/**
 * Home's honest empty day — what replaces the hero and the checklist when the
 * day has nothing planned.
 *
 * This is the FIRST screen on a new install, and it is deliberately not a grey
 * placeholder. It is also deliberately not a fake: Home used to plant an
 * eleven-item demo mission into the user's health database whenever no protocol
 * existed, two rows pre-marked complete, so the screen opened at "2 of 11" over
 * data the user never entered. That is gone. When there is no plan, the screen
 * says there is no plan, and offers the one action that fixes it.
 *
 * No hero, no progress fraction, no invented rows. It carries the screen's one
 * pine accent on the primary action, which is correct here — with no hero card
 * rendered, this IS the single directive thing on the page.
 */
export function MissionEmpty({ hasActiveProtocols }: Props) {
  const router = useRouter();
  const copy = hasActiveProtocols ? IDLE : UNBUILT;

  return (
    <View>
      <View className="rounded-card border border-hairline bg-porcelain p-5">
        <Text className="text-[11px] font-medium uppercase tracking-[2px] text-ink-muted">
          {copy.eyebrow}
        </Text>

        <Text className="mt-2.5 font-serif text-[21px] font-semibold leading-7 text-ink">
          {copy.headline}
        </Text>

        <Text className="mt-2.5 text-[15px] leading-6 text-ink-secondary">{copy.body}</Text>

        {/* The one pine on this screen: the only action worth taking right now. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.action}
          onPress={() => router.push(copy.href)}
          className="mt-5 flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3.5 active:opacity-70">
          <Ionicons name={copy.icon} size={18} color={palette.pineOn} />
          <Text className="text-[15px] font-semibold text-pine-on">{copy.action}</Text>
        </Pressable>
      </View>

      <Text className="mt-3 text-[12.5px] leading-5 text-ink-muted">{copy.footnote}</Text>
    </View>
  );
}

/** No protocols yet — the true first run. */
const UNBUILT = {
  eyebrow: 'No active protocols',
  headline: 'Today has no plan yet.',
  body:
    'ARC builds each day from the protocols you are actually running — a supplement stack, a ' +
    'morning routine, a training block. You have none yet, so today is empty. Nothing has been ' +
    'invented to fill it.',
  action: 'Build your first protocol',
  icon: 'add' as const,
  href: '/protocol-edit' as const,
  footnote: 'Anything you do in the meantime can still be captured from the Log tab.',
};

/** Protocols exist and are live, but expanded to nothing for this day. */
const IDLE = {
  eyebrow: 'Nothing scheduled',
  headline: 'Your protocols put nothing on today.',
  body:
    'Your active protocols have no items in their live versions, so there is nothing to run. ' +
    'Open one and add the items you actually do — every save becomes a new version.',
  action: 'Open your protocols',
  icon: 'list-outline' as const,
  href: '/protocols' as const,
  footnote: 'Paused protocols are skipped. Today fills in as soon as a live version has items.',
};
