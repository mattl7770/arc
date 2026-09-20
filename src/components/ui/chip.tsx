/**
 * The neutral selection chip.
 *
 * Moved here from src/components/protocols/form-controls.tsx on 2026-09-19,
 * when the Coach's status rail became a caller from outside the protocol forms.
 * Nothing about the control changed in the move.
 *
 * It lives in `ui/` rather than in a feature folder for the reason a shared
 * control always does: a chip in the cadence editor and a chip on the status
 * rail have to be the same object, or the two drift and the app grows a second
 * idea of what "selected" looks like.
 *
 * Conformed Set: **a row of chips is CONTENT, not a device**
 * (00-design-spec.md §4), so a chip never draws a block and never sits inside
 * one of its own. It spends no accent — selection is a state, not an action —
 * and no `signal-*`, which marks biology only.
 */
import { Pressable, Text, View } from 'react-native';

export function Chip({
  label,
  on,
  onPress,
  accessibilityLabel,
  accessibilityHint,
  compact,
  disabled,
  trailing,
}: {
  label: string;
  on: boolean;
  onPress: () => void;
  accessibilityLabel?: string;
  accessibilityHint?: string;
  /** Tighter padding for the cadence controls, where seven sit on one row. */
  compact?: boolean;
  disabled?: boolean;
  /**
   * A control rendered INSIDE the chip's own outline, to its right — the status
   * rail's end glyph. It is a sibling target, not part of the chip's press
   * area, so it carries its own `Pressable` and its own hit slop.
   */
  trailing?: React.ReactNode;
}) {
  const body = (
    <Text
      className={`font-label ${compact ? 'text-[12px]' : 'text-[13px]'} ${
        on ? 'font-semibold text-ink' : 'text-ink-secondary'
      }`}>
      {label}
    </Text>
  );
  const frame = `min-h-[44px] flex-row items-center justify-center rounded-btn border py-2 ${
    compact ? 'px-2' : 'px-3'
  } ${on ? 'border-ink bg-paper-dim' : 'border-hairline bg-paper-hi'} ${
    disabled ? 'opacity-40' : ''
  }`;

  // With a trailing control the outline belongs to the PAIR, so the pressable
  // shrinks to the label and the frame moves out to the wrapper. Drawing two
  // outlines instead would make one chip read as two.
  if (trailing) {
    return (
      <View className={frame}>
        <Pressable
          accessibilityRole="button"
          accessibilityState={{ selected: on, disabled: !!disabled }}
          accessibilityLabel={accessibilityLabel ?? label}
          accessibilityHint={accessibilityHint}
          disabled={disabled}
          onPress={onPress}
          className="min-h-[40px] justify-center active:opacity-60">
          {body}
        </Pressable>
        {trailing}
      </View>
    );
  }

  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: on, disabled: !!disabled }}
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityHint={accessibilityHint}
      disabled={disabled}
      onPress={onPress}
      className={`${frame} active:bg-paper-dim`}>
      {body}
    </Pressable>
  );
}
