import { TextInput, View } from 'react-native';

import { SectionLabel } from '@/components/ui/section-label';
import { palette } from '@/constants/theme';

/**
 * The name of a meal a logging session has built from several foods — the
 * barcode scanner's (owner, device, 2026-09-23: *"meal name for scanning
 * multiple foods"*) and, since 2026-10-21, Add food's, whose first add now names
 * the meal after the food the same way a scan does.
 *
 * Form (b) of the capture rule, as the meal screen's rename is: a
 * `SectionLabel` and a field wearing `border-paper-deep bg-paper-dim` itself,
 * no device around it — a form is controls, not content. Serif, because a
 * meal's name is speech. The note is the count it names, in mono.
 *
 * **Not focused, and prefilled with the name the meal has**, so the quick path
 * — add, add, Done — never stops here: Done writes nothing unless something
 * was typed. The field commits when editing ends; the screen also commits on
 * Done and when it goes (`commitScanMealName`, src/lib/nutrition/
 * scan-meal-name.ts). No Save button of its own, and so no accent: there is
 * nothing to confirm that Done does not already confirm.
 *
 * Its own module so both screens draw one field, and so the headless render
 * suite can draw it — a screen only mounts it after two adds, which a server
 * render cannot make.
 */
export function SessionMealName({
  value,
  current,
  count,
  onChange,
  onCommit,
}: {
  value: string;
  /** The name the meal has now — the placeholder once the field is emptied. */
  current: string;
  /** How many foods this session has put into the meal. */
  count: number;
  onChange: (text: string) => void;
  onCommit: () => void;
}) {
  return (
    <View className="mt-7">
      <SectionLabel label="Meal name" note={`${count} foods`} />
      <TextInput
        value={value}
        onChangeText={onChange}
        onEndEditing={onCommit}
        placeholder={current}
        placeholderTextColor={palette.inkMuted}
        autoCapitalize="sentences"
        returnKeyType="done"
        accessibilityLabel="Meal name"
        className="mt-2 border border-paper-deep bg-paper-dim px-3 py-2.5 font-serif text-[15px] text-ink"
      />
    </View>
  );
}
