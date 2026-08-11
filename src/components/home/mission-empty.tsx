import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { Pressable, Text, View } from 'react-native';

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
 * Conformed Set treatment — **no device at all.** The authored copy sits bare
 * on the sheet under its SectionLabel, exactly like the empty branches of
 * `app/protocols.tsx` and `app/wearables.tsx`, which are the reference form.
 *
 * This file used to argue the opposite, and the argument is recorded here
 * because it is a good one that loses: the plate *"stands where a record would
 * stand and states that the record is empty"*. The ADR of 2026-08-10 (§1a in
 * docs/decisions.md) overrules it, and overrules it hardest here. In this design
 * **the device is a claim about what is inside it**, so a plate drawn around an
 * absence makes the claim false — and this branch is BOTH shapes that ADR names
 * as always wrong at once: a plate around a single row (one label, one headline,
 * one paragraph, one button) *and* a plate held through the empty branch. It is
 * also the first screen a fresh install opens on, which is when a reader has the
 * least context for telling structure from artefact, and "weird boxes" is the
 * note the owner has now sent back three times.
 *
 * What the plate was really doing was giving these four elements a place. Air,
 * the section label and the type voices do that already — which is what the
 * design already says sections do (src/components/ui/block.tsx).
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

      {/*
        The footnote is prose, so it takes the serif voice like the body above
        it. It carried no font-* token at all until now, which meant it fell
        through to the RN system sans — a fourth face that is not one of the
        three the design has (00-design-spec.md §3: no Text may be faceless).
        Its separation used to come from the plate edge it sat below; with the
        plate gone that job falls to air, so the gap is opened to mt-3 — it is
        an aside about the screen, not another line of the copy above it.
      */}
      <Text className="mt-3 font-serif text-[12.5px] leading-5 text-ink-muted">
        {copy.footnote}
      </Text>
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
