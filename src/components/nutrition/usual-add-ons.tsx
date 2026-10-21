import { Pressable, Text, View } from 'react-native';

import { fmtAmount } from '@/lib/nutrition/format';
import type { UsualAddOn } from '@/lib/nutrition/repeats';
import type { VolumeUnit } from '@/lib/user/types';

/**
 * A drink's usual add-ons — owner, device round 3, item 64: *"faster button for
 * add milk"*. Under a logged drink on the meal screen, at most three chips, each
 * something he has added to THAT drink before (src/lib/nutrition/repeats.ts,
 * `rankAddOns`); one tap logs it into the same meal, as it was last logged.
 * Nothing is drawn on a cold start, so the row appears only once there is
 * something to say.
 *
 * Conformed Set: no device of its own — it is a line of the Items plate,
 * indented under the drink it belongs to, like the ½ ⅓ ¼ chips under a dish.
 * The chips are outlined in hairline, label voice for the name and mono for
 * the portion, never the accent: a one-tap add is a convenience, and the
 * screen's pine stays where it is. The 44 pt floor is on every chip.
 */
export function UsualAddOns({
  drink,
  addOns,
  volume,
  onAdd,
}: {
  drink: string;
  addOns: UsualAddOn[];
  volume: VolumeUnit;
  onAdd: (addOn: UsualAddOn) => void;
}) {
  if (addOns.length === 0) return null;
  return (
    <View className="flex-row flex-wrap items-center gap-2 pb-3 pl-6">
      <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
        Usual
      </Text>
      {addOns.map((addOn) => {
        const portion =
          addOn.latest.amount != null && addOn.latest.amount > 0
            ? fmtAmount(addOn.latest.amount, addOn.latest.unit, volume)
            : null;
        return (
          <Pressable
            key={addOn.key}
            accessibilityRole="button"
            accessibilityLabel={`Add ${addOn.name}${portion ? `, ${portion}` : ''}, to this meal with the ${drink}`}
            onPress={() => onAdd(addOn)}
            className="min-h-[44px] flex-row items-center gap-2 rounded-btn border border-hairline px-3 active:bg-paper-dim">
            <Text className="font-label text-[12px] font-semibold text-ink">{`+ ${addOn.name}`}</Text>
            {portion ? (
              <Text className="font-mono text-[10px] text-ink-muted">{portion}</Text>
            ) : null}
          </Pressable>
        );
      })}
    </View>
  );
}
