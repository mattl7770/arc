import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';

import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { palette } from '@/constants/theme';
import type { CaptureRecord } from '@/lib/db/repositories/logs';
import { captureDraft, captureSpec, type CaptureDraft } from '@/lib/log/capture-edit';
import type { UnitPreferences } from '@/lib/user/types';

/**
 * One Log-tab row, opened for correction (owner, 2026-09-26: *"Yes, an edit on
 * the Log tab, and the Coach too."*). It opens beneath its row, inside the same
 * ruled plate — part of the row, never a device of its own — and holds exactly
 * what the row shows:
 *
 *   - a note or a supplement / medication / therapy line: its words;
 *   - a measurement (a weight, a glass, HRV, a dose): its figure in the unit
 *     the row prints, with that unit beside it;
 *   - a symptom: its name and its 1–10.
 *
 * The time stays as logged. It is the moment the row was written, and for a
 * glass it is also the instant Apple Health holds, so the editor does not
 * offer it (src/lib/db/repositories/logs.ts, `CaptureEdit`).
 *
 * The draft is checked and written by the parent through `saveCaptureEdit`
 * (src/lib/log/capture-edit.ts), which answers with the line to show when it
 * cannot save. **No accent**: the Log tab's one accent is the command field's
 * send action, so Save is ink, like Settings' Save key.
 *
 * Inputs are recessed stock (`paper-dim` on `paper-deep`), as every capture
 * surface is. A numeric field carries `KEYPAD_DONE`, because an iOS number pad
 * has no return key of its own (src/components/ui/keyboard.ts).
 */
export function CaptureEditor({
  capture,
  units,
  onSave,
  onCancel,
}: {
  capture: CaptureRecord;
  units: UnitPreferences;
  /** Save the draft; returns the line to show when it could not, else null. */
  onSave: (draft: CaptureDraft) => string | null;
  onCancel: () => void;
}) {
  const [draft, setDraft] = useState<CaptureDraft>(() => captureDraft(capture, units));
  const [error, setError] = useState<string | null>(null);
  const edit = capture.edit;
  if (!edit) return null;

  const save = () => setError(onSave(draft));
  const set = (patch: Partial<CaptureDraft>) => {
    setDraft((was) => ({ ...was, ...patch }));
    setError(null);
  };
  const well = 'min-h-[44px] rounded-btn border border-paper-deep bg-paper-dim px-3 py-2 text-ink';
  const spec = captureSpec(edit, units);

  return (
    <View className="pb-3">
      {edit.kind === 'measure' ? (
        <View className="flex-row items-center gap-2">
          <TextInput
            accessibilityLabel={`Corrected ${capture.category.toLowerCase()}${spec ? ` in ${spec.unit}` : ''}`}
            value={draft.value}
            onChangeText={(value) => set({ value })}
            keyboardType="numeric"
            returnKeyType={KEYPAD_DONE}
            onSubmitEditing={save}
            className={`${well} flex-1 font-mono text-[15px]`}
          />
          {spec ? <Text className="font-mono text-[13px] text-ink-muted">{spec.unit}</Text> : null}
        </View>
      ) : edit.kind === 'text' ? (
        <TextInput
          accessibilityLabel={capture.note ? 'Corrected note' : `Corrected ${capture.title}`}
          value={draft.text}
          onChangeText={(text) => set({ text })}
          multiline={capture.note === true}
          onSubmitEditing={capture.note ? undefined : save}
          placeholderTextColor={palette.inkMuted}
          className={`${well} ${
            capture.note ? 'font-serif text-[15px] leading-5' : 'font-mono text-[14px]'
          }`}
        />
      ) : (
        <View className="gap-2">
          <TextInput
            accessibilityLabel="Symptom"
            value={draft.text}
            onChangeText={(text) => set({ text })}
            onSubmitEditing={save}
            className={`${well} font-mono text-[14px]`}
          />
          <View className="flex-row items-center gap-2">
            <Text className="flex-1 font-serif text-[13px] text-ink-secondary">Severity</Text>
            <TextInput
              accessibilityLabel="Severity, 1 to 10, or blank"
              value={draft.severity}
              onChangeText={(severity) => set({ severity })}
              keyboardType="number-pad"
              returnKeyType={KEYPAD_DONE}
              onSubmitEditing={save}
              placeholder="–"
              placeholderTextColor={palette.inkMuted}
              maxLength={2}
              className={`${well} w-16 text-center font-mono text-[15px]`}
            />
            <Text className="font-mono text-[13px] text-ink-muted">/10</Text>
          </View>
        </View>
      )}

      {error ? (
        <Text className="mt-2 font-serif text-[12px] leading-4 text-ink-secondary">{error}</Text>
      ) : null}

      <View className="mt-2 flex-row gap-2">
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Save the correction"
          onPress={save}
          className="min-h-[44px] flex-1 items-center justify-center rounded-btn bg-ink py-2 active:opacity-70">
          <Text className="font-label text-[14px] font-semibold text-paper-hi">Save</Text>
        </Pressable>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Close without saving"
          onPress={onCancel}
          className="min-h-[44px] items-center justify-center rounded-btn border border-hairline px-4 py-2 active:bg-paper-dim">
          <Text className="font-label text-[14px] text-ink">Cancel</Text>
        </Pressable>
      </View>
    </View>
  );
}
