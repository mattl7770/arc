import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { ActivityIndicator, Image, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { importedAssetIds } from '@/lib/db/repositories/progress-photos';
import {
  downscaleJpeg,
  encodeJpeg,
  pickPhotoLibraryAssets,
  type PickedLibraryAsset,
} from '@/lib/media/photo-library';
import {
  importProgressPhotos,
  nativeProgressPhotoStore,
  ORIGINAL_COPY_QUALITY,
  WORKING_COPY_EDGE,
  WORKING_COPY_QUALITY,
  type CapturedProgressPhoto,
} from '@/lib/media/progress-photo-store';
import {
  assetLocalId,
  assetPhotoDate,
  workingCopyResize,
  type PhotoDateOrigin,
} from '@/lib/photos/import';
import { poseLabel } from '@/lib/photos/format';
import type { PhotoPose } from '@/lib/photos/types';

/**
 * Importing progress photos — pick, process, **review**, save
 * (docs/progress-photos-subapp.md §3).
 *
 * ```
 * pick    (offline) ── launchImageLibraryAsync, multi-select (~30 a batch)
 * process (offline) ── per asset: EXIF date, 1600px working copy, dedupe check
 * REVIEW  (offline) ── per photo: date · pose · important · include
 * save    (offline) ── files first, then ONE transaction; a throw undoes both
 * ```
 *
 * **Every beat is offline.** There is no model in this flow at all — the AI
 * reading is a separate, later, user-initiated step.
 *
 * ## Date honesty is the whole point of the review
 *
 * A backfill is photos taken months or years ago. So EXIF's `DateTimeOriginal`
 * becomes the shutter's LOCAL day, and when there is no readable date **the
 * field is left empty and the user must fill it** — never a silently-stamped
 * "today" on a photo taken last winter. Every date is editable regardless of
 * where it came from, and each row says which. A row with no valid date cannot
 * be saved, and the Save control states how many are blocking.
 *
 * ## Library-pick only, and that is a decision (owner, 2026-08-12)
 *
 * No in-app camera. Without `expo-media-library` ARC cannot write a capture back
 * to the camera roll, so an in-app camera would make ARC's copy the ONLY
 * original — the exact inversion of the policy that keeps iCloud Photos as the
 * archive. The iOS Camera app is better at this anyway (timer, mirror, grid,
 * volume-button shutter).
 *
 * ## Conformed Set
 *
 * Pick is a **well** (a capture surface — the workout-import phase mapping);
 * review is a **ruled plate** (a proposed record is a table). Accent budget is
 * one per phase, and the phases are exclusive: "Choose photos" then "Save".
 */

const POSES: PhotoPose[] = ['front', 'side', 'back', 'other'];
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const BATCH_LIMIT = 30;

/** One picked photo, as the review edits it. Nothing is on disk yet. */
type Draft = {
  key: string;
  /** The picker's URI — kept so a photo flagged important can be re-encoded at
   *  full resolution at SAVE time rather than for every photo up front. */
  uri: string;
  workingBase64Jpeg: string;
  assetId: string | null;
  dateText: string;
  takenAt: string | null;
  dateOrigin: PhotoDateOrigin;
  pose: PhotoPose;
  important: boolean;
  /** Already in the gallery, by asset id. Excluded by default, not hidden. */
  duplicate: boolean;
  include: boolean;
};

type Phase =
  | { kind: 'pick' }
  | { kind: 'processing'; done: number; total: number }
  | { kind: 'review' }
  | { kind: 'saving' }
  | { kind: 'error'; message: string };

export default function ProgressPhotoAddScreen() {
  const router = useRouter();
  const [phase, setPhase] = useState<Phase>({ kind: 'pick' });
  const [drafts, setDrafts] = useState<Draft[]>([]);

  /** Pick, then decode each asset into a working copy. Sequential rather than
   *  parallel: thirty simultaneous native image decodes is how a phone runs out
   *  of memory mid-import. */
  const choose = async () => {
    const picked = await pickPhotoLibraryAssets({ limit: BATCH_LIMIT });
    if (picked.kind === 'canceled') return;
    if (picked.kind === 'unavailable') {
      setPhase({
        kind: 'error',
        message:
          'Choosing photos needs the next app build — the photo-library module isn’t in this one yet.',
      });
      return;
    }
    if (picked.kind === 'failed') {
      setPhase({ kind: 'error', message: 'Couldn’t open your photo library. Try again.' });
      return;
    }

    const assets = picked.assets;
    setPhase({ kind: 'processing', done: 0, total: assets.length });
    const alreadyHere = importedAssetIds(
      getDb(),
      assets.map((a) => a.assetId).filter((id): id is string => typeof id === 'string')
    );

    const next: Draft[] = [];
    for (let index = 0; index < assets.length; index++) {
      const asset = assets[index]!;
      setPhase({ kind: 'processing', done: index, total: assets.length });
      const draft = await toDraft(asset, index, next[next.length - 1]?.pose, alreadyHere);
      if (draft) next.push(draft);
    }

    if (next.length === 0) {
      setPhase({
        kind: 'error',
        message: 'None of those photos could be read. Try a different selection.',
      });
      return;
    }
    setDrafts(next);
    setPhase({ kind: 'review' });
  };

  const edit = (key: string, change: Partial<Draft>) =>
    setDrafts((prev) => prev.map((d) => (d.key === key ? { ...d, ...change } : d)));

  const included = drafts.filter((d) => d.include);
  const undated = included.filter((d) => !ISO_DATE.test(d.dateText.trim()));
  const canSave = included.length > 0 && undated.length === 0;

  const save = async () => {
    if (!canSave) return;
    setPhase({ kind: 'saving' });
    try {
      const store = nativeProgressPhotoStore();
      if (!store) throw new Error('no store');
      const photos: CapturedProgressPhoto[] = [];
      for (const draft of included) {
        // The full-size copy is made HERE, at save, and only for the photos that
        // asked for one — encoding thirty originals at pick time to keep two is
        // a lot of megabytes and a lot of seconds for nothing.
        const originalBase64Jpeg = draft.important
          ? await encodeJpeg(draft.uri, ORIGINAL_COPY_QUALITY)
          : null;
        photos.push({
          taken_on: draft.dateText.trim(),
          taken_at: draft.takenAt,
          pose: draft.pose,
          source: 'library',
          asset_id: draft.assetId,
          is_important: draft.important,
          workingBase64Jpeg: draft.workingBase64Jpeg,
          originalBase64Jpeg,
        });
      }
      importProgressPhotos(getDb(), photos, store);
      router.back();
    } catch (error) {
      console.warn('[progress-photo-add] save failed', error);
      setPhase({
        kind: 'error',
        message:
          'Couldn’t save those photos, so none of them were saved. Nothing was half-written — try again.',
      });
    }
  };

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Add photos" parent="Photos" />
      </View>

      {phase.kind === 'pick' ? (
        <View className="mt-4">
          <Block device="well">
            <SectionLabel label="From your library" />
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              Pick up to {BATCH_LIMIT} at once — a whole backfill is fine. ARC reads each photo’s
              own date out of it, keeps a working copy at {WORKING_COPY_EDGE} px, and leaves your
              originals in Photos.
            </Text>
          </Block>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Choose photos from the library"
            onPress={() => void choose()}
            className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70">
            <Ionicons name="images-outline" size={18} color={palette.pineOn} />
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
              Choose photos
            </Text>
          </Pressable>
          <View className="mt-4">
            <Block device="margin">
              <Text className="font-serif text-[13px] leading-5 text-ink-muted">
                Nothing is saved until you review each one. Photos with no date inside them come
                through blank — set the day they were actually taken, not today.
              </Text>
            </Block>
          </View>
        </View>
      ) : null}

      {phase.kind === 'processing' ? (
        <View className="mt-10 items-center">
          <ActivityIndicator color={palette.ink} />
          <Text className="mt-3 font-serif text-[14px] text-ink-secondary">
            Reading {phase.done + 1} of {phase.total}…
          </Text>
        </View>
      ) : null}

      {phase.kind === 'saving' ? (
        <View className="mt-10 items-center">
          <ActivityIndicator color={palette.ink} />
          <Text className="mt-3 font-serif text-[14px] text-ink-secondary">Saving…</Text>
        </View>
      ) : null}

      {phase.kind === 'error' ? (
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              {phase.message}
            </Text>
          </Block>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back to choosing photos"
            onPress={() => setPhase(drafts.length > 0 ? { kind: 'review' } : { kind: 'pick' })}
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              {drafts.length > 0 ? 'Back to review' : 'Try again'}
            </Text>
          </Pressable>
        </View>
      ) : null}

      {phase.kind === 'review' ? (
        <View className="mt-2">
          <View className="mt-2">
            <Block device="plate">
              <SectionLabel
                label="Review"
                note={`${included.length} of ${drafts.length} to import`}
              />
              <View className="mt-1">
                {drafts.map((draft, index) => (
                  <View key={draft.key}>
                    <Divider first={index === 0} />
                    <View className="py-3">
                      <View className="flex-row gap-3">
                        {/* The WORKING COPY, not `draft.uri`. The picker's URI
                            points at the untouched original — a 12-megapixel
                            HEIC — and thirty of those decoded for thirty 56×74
                            thumbnails is how an import screen runs a phone out
                            of memory. The downscale has already happened; this
                            just uses it. */}
                        <Image
                          source={{ uri: `data:image/jpeg;base64,${draft.workingBase64Jpeg}` }}
                          resizeMode="cover"
                          accessibilityLabel={`Photo ${index + 1}`}
                          style={{ width: 56, height: 74 }}
                          className="border border-hairline bg-paper-dim"
                        />
                        <View className="flex-1">
                          <TextInput
                            value={draft.dateText}
                            onChangeText={(text) => edit(draft.key, { dateText: text })}
                            autoCapitalize="none"
                            autoCorrect={false}
                            keyboardType="numbers-and-punctuation"
                            accessibilityLabel={`Date for photo ${index + 1}`}
                            placeholder="YYYY-MM-DD"
                            placeholderTextColor={palette.inkMuted}
                            className="border border-paper-deep bg-paper-dim px-2.5 py-1.5 font-mono text-[13px] text-ink"
                          />
                          {/* Where the date came from, on the row. A date ARC
                              read out of the file and a date the user typed are
                              different kinds of fact. */}
                          <Text className="mt-1 font-mono text-[10px] text-ink-muted">
                            {draft.dateOrigin === 'exif'
                              ? 'from the photo'
                              : draft.dateOrigin === 'asset'
                                ? 'from the file'
                                : 'no date in this photo — set it'}
                          </Text>
                        </View>
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ checked: draft.include }}
                          accessibilityLabel={
                            draft.include
                              ? `Leave out photo ${index + 1}`
                              : `Include photo ${index + 1}`
                          }
                          hitSlop={10}
                          onPress={() => edit(draft.key, { include: !draft.include })}
                          className="h-8 w-8 items-center justify-center active:opacity-60">
                          <View
                            className={
                              draft.include
                                ? 'h-4 w-4 border border-ink bg-ink'
                                : 'h-4 w-4 border border-hairline'
                            }
                          />
                        </Pressable>
                      </View>

                      <View className="mt-2 flex-row flex-wrap gap-1.5">
                        {POSES.map((p) => (
                          <Pressable
                            key={p}
                            accessibilityRole="button"
                            accessibilityState={{ selected: p === draft.pose }}
                            accessibilityLabel={`${poseLabel(p)} for photo ${index + 1}`}
                            onPress={() => edit(draft.key, { pose: p })}
                            className={
                              p === draft.pose
                                ? 'min-h-[32px] justify-center border border-ink px-2.5 py-1 active:opacity-60'
                                : 'min-h-[32px] justify-center border border-hairline px-2.5 py-1 active:opacity-60'
                            }>
                            <Text
                              className={
                                p === draft.pose
                                  ? 'font-label text-[10px] font-semibold uppercase tracking-[1px] text-ink'
                                  : 'font-label text-[10px] uppercase tracking-[1px] text-ink-muted'
                              }>
                              {poseLabel(p)}
                            </Text>
                          </Pressable>
                        ))}
                        <View className="flex-1" />
                        <Pressable
                          accessibilityRole="button"
                          accessibilityState={{ checked: draft.important }}
                          accessibilityLabel={`Keep the full-size original of photo ${index + 1}`}
                          onPress={() => edit(draft.key, { important: !draft.important })}
                          className="min-h-[32px] flex-row items-center gap-1.5 active:opacity-60">
                          <View
                            className={
                              draft.important
                                ? 'h-3.5 w-3.5 border border-ink bg-ink'
                                : 'h-3.5 w-3.5 border border-hairline'
                            }
                          />
                          <Text className="font-label text-[10px] uppercase tracking-[1px] text-ink-muted">
                            Full size
                          </Text>
                        </Pressable>
                      </View>

                      {draft.duplicate ? (
                        <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-secondary">
                          Already in the gallery — left out by default.
                        </Text>
                      ) : null}
                      {draft.important ? (
                        <Text className="mt-1 font-serif text-[12px] leading-5 text-ink-muted">
                          Keeps the full-size original inside ARC as well as the working copy. This
                          is the only moment that copy can be taken.
                        </Text>
                      ) : null}
                    </View>
                  </View>
                ))}
              </View>
            </Block>
          </View>

          {/* The decision, in future tense, above the control that performs it. */}
          <Text className="mt-5 font-serif text-[13px] leading-5 text-ink-muted">
            {undated.length > 0
              ? `${undated.length} ${undated.length === 1 ? 'photo has' : 'photos have'} no date yet. Set each one to the day it was taken — a photo filed under the wrong day is worse than one not filed.`
              : included.length === 0
                ? 'Nothing selected. Tick at least one photo to import.'
                : `On save: ${included.length} ${included.length === 1 ? 'photo is' : 'photos are'} copied into ARC at their own dates. Your originals stay in Photos.`}
          </Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save these photos"
            accessibilityState={{ disabled: !canSave }}
            disabled={!canSave}
            onPress={() => void save()}
            className={
              canSave
                ? 'mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70'
                : 'mt-3 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep py-3'
            }>
            <Text
              className={
                canSave
                  ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on'
                  : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
              }>
              Save photos
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard this import"
            onPress={() => router.back()}
            className="mt-2 min-h-[44px] items-center justify-center active:opacity-60">
            <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-muted">
              Discard
            </Text>
          </Pressable>
        </View>
      ) : null}
    </Screen>
  );
}

/**
 * One picked asset → one review row, or null when its pixels could not be read.
 *
 * The working copy is made HERE rather than at save, because it is what the
 * review thumbnail and every later surface use — and because a photo that
 * cannot be decoded should drop out before the user has spent time tagging it.
 */
async function toDraft(
  asset: PickedLibraryAsset,
  index: number,
  previousPose: PhotoPose | undefined,
  alreadyHere: Set<string>
): Promise<Draft | null> {
  const resize = workingCopyResize(asset.width, asset.height, WORKING_COPY_EDGE);
  const working = await downscaleJpeg(asset.uri, { ...resize, quality: WORKING_COPY_QUALITY });
  if (!working) return null;
  const date = assetPhotoDate(asset);
  const assetId = assetLocalId(asset);
  const duplicate = assetId !== null && alreadyHere.has(assetId);
  return {
    key: `${index}-${asset.uri}`,
    uri: asset.uri,
    workingBase64Jpeg: working.base64Jpeg,
    assetId,
    dateText: date.takenOn ?? '',
    takenAt: date.takenAt,
    dateOrigin: date.origin,
    // A batch is usually one session — front, side, back — so the previous
    // photo's pose carries forward. Never an AI guess: a wrong silent pose
    // corrupts the same-pose compare filter, which is the core query.
    pose: previousPose ?? 'front',
    important: false,
    duplicate,
    include: !duplicate,
  };
}
