import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { SectionLabel } from '@/components/ui/section-label';
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
 * placeholder. **Empty is authored, never blank.** It is also deliberately not
 * a fake: Home used to plant an eleven-item demo mission into the user's health
 * database whenever no protocol existed, two rows pre-marked complete, so the
 * screen opened at "2 of 11" over data the user never entered. That is gone.
 * When there is no plan, the screen says there is no plan, and offers the one
 * action that fixes it.
 *
 * Conformed Set treatment — the **ruled plate** device. It stands where a
 * record would stand and states that the record is empty, which is a truer
 * shape than the stamped hero: there is no next action inside the day to stamp,
 * only a way to build one.
 *
 * The plate was stripped on 2026-08-10 and **restored the same day**, on the
 * owner's instruction. The sweep that took it argued that a device is a claim
 * about what is inside it, so a plate around an absence makes the claim false.
 * That was an invented rule, and it was the wrong answer to the real complaint:
 * the "weird boxes" reported from hardware were a NativeWind divider artefact
 * (`border-t border-hairline` rendering as a full rectangle on React Native),
 * not the plates. This is the first screen a fresh install opens on, and it
 * should look like a record waiting to be filled.
 *
 * No hero, no progress fraction, no invented rows. It carries the screen's one
 * accent on the primary action, which is correct here — with no hero card
 * rendered, this IS the single directive thing on the page.
 */
export function MissionEmpty({ hasActiveProtocols }: Props) {
  const router = useRouter();
  const copy = hasActiveProtocols ? IDLE : UNBUILT;

  return (
    <View>
      <Block device="plate">
        <SectionLabel label={copy.eyebrow} />

        <Text className="mt-2.5 font-serif text-[21px] font-semibold leading-7 text-ink">
          {copy.headline}
        </Text>

        <Text className="mt-2.5 font-serif text-[15px] leading-6 text-ink-secondary">
          {copy.body}
        </Text>

        {/* The one accent on this screen: the only action worth taking right now. */}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copy.action}
          onPress={() => router.push(copy.href)}
          className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70">
          <Ionicons name={copy.icon} size={18} color={palette.pineOn} />
          <Text className="font-label text-[15px] font-semibold text-pine-on">{copy.action}</Text>
        </Pressable>
      </Block>

      {/*
        The footnote is prose, so it takes the serif voice like the body above
        it. It carried no font-* token at all until now, which meant it fell
        through to the RN system sans — a fourth face that is not one of the
        three the design has (00-design-spec.md §3: no Text may be faceless). It
        sits outside the plate deliberately: it is an aside about the screen,
        not part of the record.
      */}
      <Text className="mt-2.5 font-serif text-[12.5px] leading-5 text-ink-muted">
        {copy.footnote}
      </Text>
    </View>
  );
}

/**
 * No protocols yet — the true first run.
 *
 * This used to land straight on `/protocol-edit`: a blank form with a name
 * field, where the user had to invent both the content and its shape. It lands
 * on the HUB now, whose empty state offers the two real ways to start — build
 * it yourself, or have the Coach draft one from what it already knows about
 * you. There is deliberately no template library: this is a single-user app,
 * and the Coach is a better template engine than a canned "Morning Stack".
 */
const UNBUILT = {
  eyebrow: 'No active protocols',
  headline: 'Today has no plan yet.',
  body:
    'ARC builds each day from the protocols you are actually running — a supplement stack, a ' +
    'morning routine, a training block. You have none yet, so today is empty. Nothing has been ' +
    'invented to fill it.',
  action: 'Build your first protocol',
  icon: 'add' as const,
  href: '/protocols' as const,
  footnote: 'Anything you do in the meantime can still be captured from the Log tab.',
};

/**
 * Protocols exist and are live, but expanded to nothing for this day.
 *
 * Since content schema 2 there are three ways that happens and they are all
 * true at once here: a live version with no items, every item's CADENCE
 * skipping today, or every protocol past its last phase. The copy names the
 * cadence case because it is the new one and the only one the user might not
 * expect; the hub is where the other two are visible.
 */
const IDLE = {
  eyebrow: 'Nothing scheduled',
  headline: 'Your protocols put nothing on today.',
  body:
    'Nothing your active protocols run falls on today — either their items are set to other days, ' +
    'or their live versions have no items yet. Open them and see what each one is up to.',
  action: 'Open your protocols',
  icon: 'list-outline' as const,
  href: '/protocols' as const,
  footnote: 'Paused and ended protocols are skipped. Today fills in as soon as one comes round.',
};
