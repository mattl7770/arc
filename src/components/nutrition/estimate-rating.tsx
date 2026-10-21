import { Pressable, Text, View } from 'react-native';

import { RATING_ISSUES, type EstimateRating, type RatingIssue } from '@/lib/nutrition/ratings';

/** What the line needs to know about a meal's rating (0066). */
export type EstimateRatingView = {
  rating: EstimateRating;
  issue: RatingIssue | null;
  /** The fix has changed the items — an example exists. */
  corrected: boolean;
} | null;

/**
 * Where the line is, beyond what the row says: `verdict` is Change tapped
 * (Good / Off asked again), `issue` is Off just tapped (the one question asked,
 * even over an answer already recorded — a changed mind gets the question too).
 */
export type EstimateRatingStep = 'idle' | 'verdict' | 'issue';

/** What to do next, once the question is answered and nothing is fixed yet. */
const NEXT_STEP: Record<RatingIssue, string> = {
  portion: 'Set the portion on the item above.',
  item: 'Say what it was in Adjust with AI, or change the items above.',
  macros: 'Give the figures in Adjust with AI.',
};

function Chip({
  label,
  accessibilityLabel,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className="min-h-[44px] min-w-[44px] items-center justify-center rounded-btn border border-hairline px-3 active:bg-paper-dim">
      <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink">{label}</Text>
    </Pressable>
  );
}

/**
 * **Was this right?** — device round 3, item 86 (docs/nutrition-subapp.md §23).
 * On a logged meal that came from an estimate, one quiet line under its items:
 * *Good* or *Off*. Off asks the ONE question — portion, item or macros? — and
 * the answer routes to the path that fixes it (the screen does the routing).
 * What the fix changes is kept, before → after, as an example the estimator
 * sees next time.
 *
 * **Non-nagging by construction.** One place (this screen, not the estimate's
 * review — that is where the estimate is being corrected already), never a
 * modal, never a badge elsewhere. Once answered it reads back as one line with
 * a *Change*, and nothing asks again.
 *
 * Conformed Set: no device of its own — a line between the Items plate and the
 * Actions plate, in the label voice. Hairline chips with the 44 pt floor, ink
 * text, **no accent and no signal colour**: a verdict on an estimate is a fact
 * about the data, not a biological state, and the screen's pine stays on its
 * own control.
 */
export function EstimateRatingLine({
  view,
  step,
  onRate,
  onIssue,
  onChange,
}: {
  view: EstimateRatingView;
  step: EstimateRatingStep;
  onRate: (rating: EstimateRating) => void;
  onIssue: (issue: RatingIssue) => void;
  onChange: () => void;
}) {
  const asking = view === null || step === 'verdict';
  const askingIssue = !asking && view.rating === 'bad' && (view.issue === null || step === 'issue');

  const label = (text: string) => (
    <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">{text}</Text>
  );
  const trailing = (word: 'Change' | 'Cancel') => (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={
        word === 'Change' ? 'Change the rating of this estimate' : 'Keep the rating as it was'
      }
      hitSlop={12}
      onPress={onChange}
      className="ml-auto min-h-[44px] justify-center pl-3 active:opacity-60">
      <Text className="font-label text-[11px] uppercase tracking-[1.2px] text-ink-secondary">
        {word}
      </Text>
    </Pressable>
  );

  if (asking) {
    return (
      <View className="flex-row flex-wrap items-center gap-2">
        {label('Was this right?')}
        <View className="ml-auto flex-row items-center gap-2">
          <Chip
            label="Good"
            accessibilityLabel="This estimate was right"
            onPress={() => onRate('good')}
          />
          <Chip
            label="Off"
            accessibilityLabel="This estimate was off"
            onPress={() => onRate('bad')}
          />
          {view !== null ? trailing('Cancel') : null}
        </View>
      </View>
    );
  }

  if (askingIssue) {
    return (
      <View>
        <View className="flex-row flex-wrap items-center gap-2">
          {label('What was off?')}
          {trailing('Change')}
        </View>
        <View className="flex-row gap-2">
          {RATING_ISSUES.map(({ issue, label: word }) => (
            <Chip
              key={issue}
              label={word}
              accessibilityLabel={`The ${issue} ${issue === 'macros' ? 'were' : 'was'} off`}
              onPress={() => onIssue(issue)}
            />
          ))}
        </View>
      </View>
    );
  }

  const answer =
    view.rating === 'good'
      ? 'Good'
      : [
          'Off',
          RATING_ISSUES.find((i) => i.issue === view.issue)?.label,
          view.corrected ? 'corrected' : null,
        ]
          .filter(Boolean)
          .join(' · ');
  const note =
    view.rating === 'bad' && view.issue
      ? view.corrected
        ? 'Kept as an example for the next estimate.'
        : `${NEXT_STEP[view.issue]} What you change is kept as an example for the next estimate.`
      : null;
  return (
    <View>
      <View className="flex-row flex-wrap items-center gap-2">
        {label('Estimate')}
        <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink">{answer}</Text>
        {trailing('Change')}
      </View>
      {note ? (
        <Text className="font-serif text-[13px] leading-5 text-ink-muted">{note}</Text>
      ) : null}
    </View>
  );
}
