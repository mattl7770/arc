/**
 * The recessed field the protocol forms are built from. The neutral Chip moved
 * to src/components/ui/chip.tsx on 2026-09-19, when the Coach’s status rail
 * became a caller from outside these forms; the three controls here import it
 * back.
 *
 * Extracted verbatim from app/protocol-edit.tsx on 2026-09-19, when the per-item
 * editor and the settings sheet became second and third callers. Both folded
 * back into the one editor on 2026-09-25 (docs/spikes/protocol-menus-compact.md,
 * option A), and the field stayed here: nothing about it changed in either
 * move, and its docblock records a defect this app shipped and the reason a
 * rule exists.
 *
 * Conformed Set: a capture surface is a **well** — paper-dim on a paper-deep
 * edge, square — and a form carries **no block** (form (b) of the capture-surface
 * rule, src/components/ui/block.tsx). Every screen that imports these is a form,
 * so none of them may put a plate around them.
 */
import Ionicons from '@expo/vector-icons/Ionicons';
import { Pressable, Text, TextInput, type TextInputProps } from 'react-native';

import { keypadDoneKey } from '@/components/ui/keyboard';
import { palette } from '@/constants/theme';

/*
 * `normalizeTime` moved to src/lib/protocols/clock-time.ts on 2026-09-21, when
 * the time control became an iOS wheel. It is one half of the `HH:MM` write
 * contract the wheel has to honour, and a parser sitting in a component file
 * cannot be tested by a suite that never loads a component. Import it from
 * there; it is NOT re-exported here, because two import paths to one symbol is
 * how the app grows two ideas of what a clock time is.
 */

/*
 * `parseDays` moved to src/lib/protocols/edit-form.ts on 2026-09-25, beside the
 * form state that builds a document from it, so the headless suite can load it
 * without a component. The same rule as `normalizeTime` above: one import path.
 */

type FieldProps = {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  keyboardType?: TextInputProps['keyboardType'];
  mono?: boolean;
  maxLength?: number;
  multiline?: boolean;
  /**
   * Set ONLY when this field is a child of a `flex-row` and should take the
   * remaining width. See the note on {@link FormField} — passing it in a column
   * is the bug that made the editor draw boxes over other boxes.
   */
  fill?: boolean;
  accessibilityLabel: string;
};

/**
 * One recessed field.
 *
 * ## `flex-1` in a column is what drew "boxes covering other boxes"
 *
 * Every field used to be wrapped in `<View className="flex-1">`, unconditionally
 * — and most of a protocol form's fields are children of a **column**, not a row.
 *
 * In a column container the main axis is vertical, so `flex-1` resolves to
 * `flexBasis: 0%` **on the height**. The parent (`<View className="mt-2">`) has
 * no height of its own and sizes to its content, so there is no free space for
 * `flexGrow` to claim, and the wrapper lays out at **zero height**. Views do not
 * clip by default, so the `TextInput` inside it still drew at its natural
 * height — on top of whatever section came next. The description field is the
 * worst case, because it is `multiline` with a 64pt floor: 64pt of bordered
 * input painted over the block below it.
 *
 * That is the report, exactly: boxes covering other boxes, on the New Protocol
 * screen specifically — which is the path where the fields are empty and the
 * collapse is total.
 *
 * So the flex is opt-in and named for what it is: `fill` belongs to a field
 * sharing a **row**, and nowhere else. The wrapper view is gone entirely — a
 * `TextInput` takes the flex directly, one view less per field.
 */
export function FormField({
  value,
  onChange,
  placeholder,
  keyboardType,
  mono,
  maxLength,
  multiline,
  fill,
  accessibilityLabel,
}: FieldProps) {
  return (
    <TextInput
      value={value}
      onChangeText={onChange}
      placeholder={placeholder}
      placeholderTextColor={palette.inkMuted}
      keyboardType={keyboardType}
      returnKeyType={keypadDoneKey(keyboardType)}
      maxLength={maxLength}
      multiline={multiline}
      accessibilityLabel={accessibilityLabel}
      className={`border border-paper-deep bg-paper-dim px-3.5 py-3 text-[15px] text-ink ${
        fill ? 'flex-1' : ''
      } ${mono ? 'font-mono' : ''} ${multiline ? 'max-h-28 min-h-[64px] leading-5' : ''}`}
    />
  );
}

/**
 * A form's single problem line — one sentence in the reading voice, never a
 * colour. A refusal is information, not a signal state, and `signal-*` marks
 * biology only (00-design-spec.md §2).
 */
export function ProblemLine({ text }: { text: string | null }) {
  if (!text) return null;
  return <Text className="mt-4 font-serif text-[12px] leading-5 text-ink-muted">{text}</Text>;
}

/**
 * **The form's one accent.** Every protocol form spends its entire accent
 * budget here and nowhere else: the chips, the add rows and Delete are all
 * neutral ink. Taken verbatim from the editor's Save so the three forms cannot
 * drift into three different primary buttons.
 *
 * `children` rather than a string, because the version number inside the label
 * — `Save as v5` — is a measured value and stays **mono** inside label-voice
 * text (00-design-spec.md §3).
 *
 * The disabled state is a full border plus recessed stock. Never a one-sided
 * border width beside a border colour: that is the combination that drops React
 * Native off its CoreAnimation path and paints a filled rectangle.
 */
export function SaveButton({
  accessibilityLabel,
  onPress,
  disabled,
  children,
}: {
  accessibilityLabel: string;
  onPress: () => void;
  disabled: boolean;
  children: React.ReactNode;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={onPress}
      className={`mt-6 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn py-3.5 ${
        disabled ? 'border border-hairline bg-paper-dim' : 'bg-pine active:opacity-70'
      }`}>
      <Ionicons
        name="git-branch-outline"
        size={18}
        color={disabled ? palette.inkMuted : palette.pineOn}
      />
      <Text
        className={`font-label text-[15px] font-semibold ${
          disabled ? 'text-ink-muted' : 'text-pine-on'
        }`}>
        {children}
      </Text>
    </Pressable>
  );
}

/**
 * Where a save lands, said once. The same sentence the full editor has carried
 * since the owner's 2026-08-25 call that an edit reaches TODAY — every form
 * that writes a version repeats it, because every one of them does.
 */
export function SaveFootnote() {
  return (
    <Text className="mt-3 text-center font-serif text-[11.5px] leading-4 text-ink-muted">
      Saving updates today&rsquo;s mission. Anything already done or skipped stays as it is.
    </Text>
  );
}
