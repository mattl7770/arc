import { useLocalSearchParams, useRouter } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, Text, TextInput, View } from 'react-native';

import { PhotoReadingPanel, SavedReading } from '@/components/photos/reading-panel';
import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useProgressPhoto } from '@/hooks/use-progress-photos';
import { getDb } from '@/lib/db/client';
import {
  deleteProgressPhotoAnalysis,
  insertProgressPhotoAnalysis,
  updateProgressPhoto,
} from '@/lib/db/repositories/progress-photos';
import { downscaleToJpegBase64 } from '@/lib/media/photo-library';
import { deleteProgressPhotoWithFiles } from '@/lib/media/progress-photo-store';
import { parseSavedChanges, parseSavedObservations } from '@/lib/photos/analyze';
import { formatPhotoDate, isRealCalendarDate, poseLabel } from '@/lib/photos/format';
import type { PhotoDateSource, PhotoPose } from '@/lib/photos/types';

/**
 * One progress photo, full size — pushed from the gallery
 * (docs/progress-photos-subapp.md §4).
 *
 * The record and its edits: the shutter day, the pose, a note, the important
 * flag, every saved AI reading, the entry point for a new one, and delete.
 *
 * ## The surface system
 *
 * The picture sits directly on the sheet in a hairline frame — it is the thing
 * the screen is about, not a record filed on the page. **Details** is a ruled
 * plate. The editable fields wear the well's own tokens directly rather than
 * sitting inside a `device="well"`: form (b) of the capture-surface rule, and
 * the reason is that a recess containing a raised input inverts the surface
 * system (src/components/ui/block.tsx).
 *
 * **One accent per phase**, owned by the reading panel — Read, then Send, then
 * Save. Delete is neutral ink with an arm/confirm, like every destructive
 * control in this app.
 *
 * ## The two honest caveats this screen must state
 *
 * 1. **Flagging a photo important now cannot fetch its original.** The
 *    full-resolution copy is only ever made at pick time; v1 has no
 *    `expo-media-library` and therefore no way back to the camera roll. So the
 *    toggle says what it will and will not do, in words, rather than implying a
 *    retro-fetch that will not happen.
 * 2. **Deleting here never touches Photos.** ARC deletes its own working copy.
 */

const POSES: PhotoPose[] = ['front', 'side', 'back', 'other'];

/** What `date_origin` (0036) means, in the owner's words rather than the
 *  schema's. `manual` covers both "no date was in the file" and "you corrected
 *  it", because from the record's point of view they are the same fact. */
const DATE_ORIGIN_LABEL: Record<PhotoDateSource, string> = {
  exif: 'Read from the photo itself.',
  asset: 'Read from the photo file’s own date.',
  manual: 'Set by you.',
};

export default function ProgressPhotoDetailScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ id?: string }>();
  const id = typeof params.id === 'string' ? params.id : undefined;
  const {
    photo,
    originalUri,
    counterparts,
    weighInCaption: weighIn,
    analyses,
    reload,
  } = useProgressPhoto(id);

  const [dateText, setDateText] = useState<string | null>(null);
  const [noteText, setNoteText] = useState<string | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  if (!photo) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Photo" parent="Photos" />
        </View>
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              This photo is gone.
            </Text>
          </Block>
        </View>
      </Screen>
    );
  }

  const date = dateText ?? photo.taken_on;
  const note = noteText ?? photo.notes ?? '';

  const commitDate = () => {
    const trimmed = date.trim();
    // A REAL day, not merely the right shape — `2026-31-12` passes a regex and
    // is not a date (see isRealCalendarDate).
    if (!isRealCalendarDate(trimmed)) {
      setMessage('That isn’t a day on the calendar. A date reads YYYY-MM-DD. Nothing was changed.');
      setDateText(photo.taken_on);
      return;
    }
    if (trimmed === photo.taken_on) return;
    try {
      updateProgressPhoto(getDb(), photo.id, { taken_on: trimmed });
      setMessage(null);
      setDateText(null);
      reload();
    } catch {
      setMessage('That date wasn’t accepted. Nothing was changed.');
      setDateText(photo.taken_on);
    }
  };

  const commitNote = () => {
    const trimmed = note.trim();
    if (trimmed === (photo.notes ?? '')) return;
    updateProgressPhoto(getDb(), photo.id, { notes: trimmed === '' ? null : trimmed });
    setNoteText(null);
    reload();
  };

  const setPose = (pose: PhotoPose) => {
    if (pose === photo.pose) return;
    updateProgressPhoto(getDb(), photo.id, { pose });
    reload();
  };

  const toggleImportant = () => {
    updateProgressPhoto(getDb(), photo.id, { is_important: photo.is_important !== 1 });
    reload();
  };

  const remove = () => {
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    deleteProgressPhotoWithFiles(getDb(), photo.id);
    router.back();
  };

  /** The reading payload: the working copy at the one size every vision path in
   *  this app sends, plus ARC's own numbers — the weigh-in WITH its distance. */
  const buildInput = async () => {
    if (!photo.uri) return null;
    const base64Jpeg = await downscaleToJpegBase64(photo.uri, { width: 1024, quality: 0.6 });
    if (!base64Jpeg) return null;
    return {
      kind: 'single' as const,
      photo: {
        base64Jpeg,
        takenOn: photo.taken_on,
        pose: photo.pose,
        weighIn,
        notes: photo.notes,
      },
    };
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title={formatPhotoDate(photo.taken_on)} parent="Photos" />
      </View>

      {/* a. The photograph. Full width, its own aspect, in a hairline frame. */}
      <View className="mt-4 w-full overflow-hidden border border-hairline bg-paper-dim">
        {photo.uri ? (
          <Image
            source={{ uri: photo.uri }}
            resizeMode="contain"
            accessibilityLabel={`${poseLabel(photo.pose)} photo from ${formatPhotoDate(
              photo.taken_on
            )}`}
            style={{ width: '100%', aspectRatio: 3 / 4 }}
          />
        ) : (
          <View className="w-full items-center justify-center px-6" style={{ aspectRatio: 3 / 4 }}>
            <Text className="text-center font-serif text-[14px] leading-6 text-ink-secondary">
              Image not on this phone.
            </Text>
            <Text className="mt-2 text-center font-serif text-[12px] leading-5 text-ink-muted">
              The record survived — its date, pose, note and any readings — but the file didn’t come
              across. Nothing here was deleted.
            </Text>
          </View>
        )}
      </View>

      <Text className="mt-2 font-mono text-[11px] text-ink-secondary">{weighIn}</Text>

      {/* b. The record. */}
      <View className="mt-6">
        <Block device="plate">
          {/* The note slot is for a MEASUREMENT (section-label.tsx), so the
              provenance word goes under the date field where it belongs, not
              here. It also used to be inferred from `taken_at IS NOT NULL`,
              which was wrong in both directions — a picker-epoch date has an
              instant and is not EXIF; a real DateTimeOriginal with no offset tag
              has no instant and is. `date_origin` (0036) is the persisted fact. */}
          <SectionLabel label="Details" />

          <View className="mt-3">
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Taken on
            </Text>
            <TextInput
              value={date}
              onChangeText={setDateText}
              onBlur={commitDate}
              onSubmitEditing={commitDate}
              autoCapitalize="none"
              autoCorrect={false}
              keyboardType="numbers-and-punctuation"
              accessibilityLabel="The day this photo was taken"
              placeholder="YYYY-MM-DD"
              placeholderTextColor={palette.inkMuted}
              className="mt-1.5 border border-paper-deep bg-paper-dim px-3 py-2 font-mono text-[14px] text-ink"
            />
            {/* The real provenance, from the persisted column — and editing the
                day rewrites it to "you set this", because a hand-typed date
                labelled "from the photo" is the exact lie this feature is about
                not telling. */}
            <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-muted">
              {DATE_ORIGIN_LABEL[photo.date_origin]}
            </Text>
          </View>

          <View className="mt-4">
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Pose
            </Text>
            <View className="mt-1.5 flex-row flex-wrap gap-2">
              {POSES.map((p) => (
                <Pressable
                  key={p}
                  accessibilityRole="button"
                  accessibilityState={{ selected: p === photo.pose }}
                  accessibilityLabel={poseLabel(p)}
                  onPress={() => setPose(p)}
                  className={
                    p === photo.pose
                      ? 'min-h-[36px] justify-center border border-ink px-3 py-1.5 active:opacity-60'
                      : 'min-h-[36px] justify-center border border-hairline px-3 py-1.5 active:opacity-60'
                  }>
                  <Text
                    className={
                      p === photo.pose
                        ? 'font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink'
                        : 'font-label text-[11px] uppercase tracking-[1px] text-ink-muted'
                    }>
                    {poseLabel(p)}
                  </Text>
                </Pressable>
              ))}
            </View>
          </View>

          <View className="mt-4">
            <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-ink-muted">
              Note
            </Text>
            <TextInput
              value={note}
              onChangeText={setNoteText}
              onBlur={commitNote}
              multiline
              accessibilityLabel="A note about this photo"
              placeholder="Morning, fasted, same window…"
              placeholderTextColor={palette.inkMuted}
              className="mt-1.5 min-h-[44px] border border-paper-deep bg-paper-dim px-3 py-2 font-serif text-[14px] leading-5 text-ink"
            />
          </View>

          <Divider />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ checked: photo.is_important === 1 }}
            accessibilityLabel={
              photo.is_important === 1 ? 'Unmark as important' : 'Mark as important'
            }
            onPress={toggleImportant}
            className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
            <View
              className={
                photo.is_important === 1
                  ? 'h-4 w-4 border border-ink bg-ink'
                  : 'h-4 w-4 border border-hairline'
              }
            />
            <Text className="flex-1 font-serif text-[14px] text-ink">Important</Text>
          </Pressable>
          {/* The honest retro-flag caveat, stated on the row that can mislead.
              It branches on `originalUri`, NOT on `original_file_name`: the name
              survives a restore that did not carry the media, and testing the
              name would print "a full-size original is kept inside ARC" directly
              beneath the authored "Image not on this phone" — two contradictory
              claims in one viewport, in exactly the scenario the sweep exists to
              produce. Found by adversarial review, 2026-08-12. */}
          <Text className="font-serif text-[12px] leading-5 text-ink-muted">
            {originalUri
              ? 'A full-size original is kept inside ARC for this one.'
              : photo.original_file_name
                ? 'A full-size original was kept for this one, but that file isn’t on this phone either.'
                : photo.is_important === 1
                  ? 'Flagged — but only the working copy is kept. ARC can only take a full-size copy at the moment a photo is imported; it can’t fetch one back out of Photos.'
                  : 'Marks the photo. A full-size copy can only be kept at import time, so flagging one later keeps the working copy alone.'}
          </Text>
        </Block>
      </View>

      {message ? (
        <Text className="mt-3 font-serif text-[13px] leading-5 text-ink-secondary">{message}</Text>
      ) : null}

      {/* c. The AI reading — the one online step on this screen, and never
          automatic. */}
      <PhotoReadingPanel
        action="Read this photo"
        what="this photo"
        buildInput={buildInput}
        onSave={(reading, model) => {
          insertProgressPhotoAnalysis(getDb(), {
            photo_id: photo.id,
            model,
            summary: reading.summary,
            observations: JSON.stringify(reading.observations),
            changes: null,
            caveats: reading.caveats,
            confidence: reading.confidence,
          });
          reload();
        }}
      />

      {analyses.length > 0 ? (
        <View className="mt-6">
          <Block device="plate">
            <SectionLabel
              label="Saved readings"
              note={`${analyses.length} ${analyses.length === 1 ? 'reading' : 'readings'}`}
            />
            <View className="mt-1">
              {analyses.map((analysis, index) => {
                // Which half of a pair THIS photo is, and what the other one
                // was. A reading shown on the January photo describes a change
                // measured against August; saying only "a comparison" leaves the
                // arrow pointing nowhere the reader can see.
                const otherId =
                  analysis.photo_id === photo.id ? analysis.compare_photo_id : analysis.photo_id;
                const other = otherId ? counterparts[otherId] : undefined;
                const pairLabel = otherId
                  ? other
                    ? analysis.photo_id === photo.id
                      ? `Compared with ${formatPhotoDate(other.taken_on)} — this photo is the earlier one.`
                      : `Compared with ${formatPhotoDate(other.taken_on)} — this photo is the later one.`
                    : 'A comparison; the other photo could not be loaded.'
                  : undefined;
                return (
                  <SavedReading
                    key={analysis.id}
                    first={index === 0}
                    summary={analysis.summary}
                    caveats={analysis.caveats}
                    model={analysis.model}
                    createdAt={analysis.created_at}
                    observations={parseSavedObservations(analysis.observations)}
                    changes={parseSavedChanges(analysis.changes)}
                    pairLabel={pairLabel}
                    onDelete={() => {
                      deleteProgressPhotoAnalysis(getDb(), analysis.id);
                      reload();
                    }}
                  />
                );
              })}
            </View>
          </Block>
        </View>
      ) : null}

      {/* d. Delete — armed, and honest about its blast radius. */}
      {deleteArmed ? (
        <Text className="mt-6 text-center font-serif text-[13px] leading-5 text-ink-secondary">
          This removes ARC’s copy and any readings saved on it. Your photo in the iOS Photos app is
          untouched.
        </Text>
      ) : null}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={deleteArmed ? 'Tap again to delete this photo' : 'Delete this photo'}
        onPress={remove}
        className={
          deleteArmed
            ? 'mt-2 min-h-[46px] items-center justify-center active:opacity-60'
            : 'mt-8 min-h-[46px] items-center justify-center active:opacity-60'
        }>
        <Text
          className={
            deleteArmed
              ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink'
              : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
          }>
          {deleteArmed ? 'Confirm delete' : 'Delete photo'}
        </Text>
      </Pressable>
    </Screen>
  );
}
