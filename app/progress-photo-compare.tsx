import { useLocalSearchParams, useRouter } from 'expo-router';
import { useMemo, useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';

import { PhotoReadingPanel, SavedReading } from '@/components/photos/reading-panel';
import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import {
  useProgressGallery,
  useWeightFormatter,
  type GalleryPhoto,
} from '@/hooks/use-progress-photos';
import { getDb } from '@/lib/db/client';
import {
  insertProgressPhotoAnalysis,
  listPairAnalyses,
  nearestWeighIn,
} from '@/lib/db/repositories/progress-photos';
import { downscaleToJpegBase64 } from '@/lib/media/photo-library';
import { parseSavedChanges, parseSavedObservations } from '@/lib/photos/analyze';
import { formatPhotoDate, poseLabel, weighInCaption } from '@/lib/photos/format';
import type { PhotoPose } from '@/lib/photos/types';

/**
 * Two photos side by side, and the one AI reading that compares them
 * (docs/progress-photos-subapp.md §4).
 *
 * ## The captions are honest by construction
 *
 * Each photo carries the NEAREST weigh-in within ±3 days and **always states its
 * own distance** — "weighed same day", "weighed 2 days later" — or says there
 * was none. Printing a bare weight under a photo would imply the two were
 * measured together; stating the distance also sidesteps the open UTC-vs-local
 * bucketing caveat entirely, because no bucketing claim is made: the weigh-in's
 * own date is what the distance is measured from. Units honour
 * `UnitPreferences` like every other surface.
 *
 * ## Direction is fixed, everywhere
 *
 * `a` is the EARLIER photo and `b` the later — enforced here rather than trusted
 * from the caller, because the model prompt states that order and a comparison
 * that reads it backwards is worse than no comparison.
 *
 * ## Zero accent until there is something to do with it
 *
 * The pair itself is a reading surface. The one accent belongs to the reading
 * panel's current phase (Compare → Send → Save), which is the only directive
 * thing on the sheet.
 */

function pickDefaultPair(photos: GalleryPhoto[]): [GalleryPhoto, GalleryPhoto] | null {
  // Earliest vs latest of the best-represented pose — the comparison someone
  // opening this screen cold almost always wants.
  const byPose = new Map<PhotoPose, GalleryPhoto[]>();
  for (const photo of photos) {
    const list = byPose.get(photo.pose) ?? [];
    list.push(photo);
    byPose.set(photo.pose, list);
  }
  let best: GalleryPhoto[] | null = null;
  for (const list of byPose.values()) {
    if (list.length >= 2 && (!best || list.length > best.length)) best = list;
  }
  if (!best) return null;
  // `photos` is newest-first, so the last entry of a pose group is its earliest.
  return [best[best.length - 1]!, best[0]!];
}

function Half({ photo, caption }: { photo: GalleryPhoto; caption: string }) {
  return (
    <View className="w-1/2 px-1">
      <View className="w-full overflow-hidden border border-hairline bg-paper-dim" style={{ aspectRatio: 3 / 4 }}>
        {photo.uri ? (
          <Image
            source={{ uri: photo.uri }}
            resizeMode="cover"
            accessibilityLabel={`${poseLabel(photo.pose)} photo from ${formatPhotoDate(
              photo.taken_on
            )}`}
            style={{ flex: 1 }}
          />
        ) : (
          <View className="flex-1 items-center justify-center px-2">
            <Text className="text-center font-serif text-[11px] leading-4 text-ink-muted">
              Image not on this phone
            </Text>
          </View>
        )}
      </View>
      <Text className="mt-2 font-serif text-[13px] text-ink">{formatPhotoDate(photo.taken_on)}</Text>
      <Text className="mt-0.5 font-mono text-[10px] leading-4 text-ink-muted">{caption}</Text>
    </View>
  );
}

export default function ProgressPhotoCompareScreen() {
  const router = useRouter();
  const params = useLocalSearchParams<{ a?: string; b?: string }>();
  const { photos } = useProgressGallery(null);
  const formatWeight = useWeightFormatter();
  const [override, setOverride] = useState<{ a: string; b: string } | null>(null);
  const [allPoses, setAllPoses] = useState(false);
  const [savedTick, setSavedTick] = useState(0);

  const pair = useMemo(() => {
    const wanted = override ?? {
      a: typeof params.a === 'string' ? params.a : '',
      b: typeof params.b === 'string' ? params.b : '',
    };
    const first = photos.find((p) => p.id === wanted.a);
    const second = photos.find((p) => p.id === wanted.b);
    if (first && second && first.id !== second.id) {
      // Order by date, not by which param they arrived in.
      return first.taken_on <= second.taken_on
        ? ([first, second] as const)
        : ([second, first] as const);
    }
    const fallback = pickDefaultPair(photos);
    return fallback ? ([fallback[0], fallback[1]] as const) : null;
  }, [photos, params.a, params.b, override]);

  const captions = useMemo(() => {
    if (!pair) return null;
    const db = getDb();
    return {
      earlier: weighInCaption(nearestWeighIn(db, pair[0].taken_on), formatWeight),
      later: weighInCaption(nearestWeighIn(db, pair[1].taken_on), formatWeight),
    };
  }, [pair, formatWeight]);

  const saved = useMemo(() => {
    void savedTick;
    if (!pair) return [];
    return listPairAnalyses(getDb(), pair[0].id, pair[1].id);
  }, [pair, savedTick]);

  if (!pair || !captions) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Compare" parent="Photos" />
        </View>
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              Two photos of the same pose are what makes a comparison worth looking at. Import a
              second one and come back.
            </Text>
          </Block>
        </View>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Back to the gallery"
          onPress={() => router.back()}
          className="mt-6 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
          <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
            Back to photos
          </Text>
        </Pressable>
      </Screen>
    );
  }

  const [earlier, later] = pair;
  const candidates = photos.filter(
    (p) => p.id !== earlier.id && (allPoses || p.pose === earlier.pose)
  );

  const buildInput = async () => {
    if (!earlier.uri || !later.uri) return null;
    const [one, two] = await Promise.all([
      downscaleToJpegBase64(earlier.uri, { width: 1024, quality: 0.6 }),
      downscaleToJpegBase64(later.uri, { width: 1024, quality: 0.6 }),
    ]);
    if (!one || !two) return null;
    return {
      kind: 'pair' as const,
      earlier: {
        base64Jpeg: one,
        takenOn: earlier.taken_on,
        pose: earlier.pose,
        weighIn: captions.earlier,
        notes: earlier.notes,
      },
      later: {
        base64Jpeg: two,
        takenOn: later.taken_on,
        pose: later.pose,
        weighIn: captions.later,
        notes: later.notes,
      },
    };
  };

  const spanDays = Math.round(
    (Date.parse(`${later.taken_on}T00:00:00Z`) - Date.parse(`${earlier.taken_on}T00:00:00Z`)) /
      86_400_000
  );
  const spanLine =
    `${spanDays} ${spanDays === 1 ? 'day' : 'days'} apart · ` +
    (earlier.pose === later.pose
      ? `both ${poseLabel(earlier.pose).toLowerCase()}`
      : `${poseLabel(earlier.pose).toLowerCase()} vs ${poseLabel(later.pose).toLowerCase()}`);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Compare" parent="Photos" />
      </View>

      <View className="-mx-1 mt-4 flex-row">
        <Half photo={earlier} caption={captions.earlier} />
        <Half photo={later} caption={captions.later} />
      </View>

      {/* Built as ONE string rather than interpolated children: adjacent
          dynamic children are separate text nodes, which react-dom's server
          renderer splits with comment markers — invisible on device, but it
          makes the line unassertable in db/screens-render.test.mjs, and a line
          nothing can assert is a line that quietly rots. */}
      <Text className="mt-3 font-mono text-[10px] text-ink-muted">{spanLine}</Text>
      {earlier.pose !== later.pose ? (
        <View className="mt-3">
          <Block device="margin">
            <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
              These are different poses, so most of what looks like a change is the angle. Compare
              like with like where you can.
            </Text>
          </Block>
        </View>
      ) : null}

      {/* The AI reading — never automatic, and it gets the same captions the
          screen just printed, distance clauses and all. */}
      <PhotoReadingPanel
        action="Compare these two"
        what="this comparison"
        buildInput={buildInput}
        onSave={(reading, model) => {
          insertProgressPhotoAnalysis(getDb(), {
            photo_id: earlier.id,
            compare_photo_id: later.id,
            model,
            summary: reading.summary,
            observations: JSON.stringify(reading.observations),
            changes: JSON.stringify(reading.changes),
            caveats: reading.caveats,
            confidence: reading.confidence,
          });
          setSavedTick((n) => n + 1);
        }}
      />

      {saved.length > 0 ? (
        <View className="mt-6">
          <Block device="plate">
            <SectionLabel
              label="Saved readings"
              note={`${saved.length} ${saved.length === 1 ? 'reading' : 'readings'}`}
            />
            <View className="mt-1">
              {saved.map((analysis, index) => (
                <SavedReading
                  key={analysis.id}
                  first={index === 0}
                  summary={analysis.summary}
                  caveats={analysis.caveats}
                  model={analysis.model}
                  createdAt={analysis.created_at}
                  observations={parseSavedObservations(analysis.observations)}
                  changes={parseSavedChanges(analysis.changes)}
                />
              ))}
            </View>
          </Block>
        </View>
      ) : null}

      {/* Swap the second photo. Same pose by default — comparing a front to a
          back is the fastest way to a meaningless reading. */}
      <View className="mt-7">
        <Block device="plate">
          <SectionLabel
            label="Compare against"
            note={allPoses ? 'all poses' : poseLabel(earlier.pose).toLowerCase()}
          />
          <Pressable
            accessibilityRole="button"
            accessibilityState={{ selected: allPoses }}
            accessibilityLabel={allPoses ? 'Show only the same pose' : 'Show every pose'}
            onPress={() => setAllPoses((v) => !v)}
            className="min-h-[44px] flex-row items-center active:opacity-60">
            <Text className="font-label text-[11px] uppercase tracking-[1px] text-ink-secondary">
              {allPoses ? 'Same pose only' : 'Show every pose'}
            </Text>
          </Pressable>
          <View className="flex-row flex-wrap gap-2 pb-1">
            {candidates.length === 0 ? (
              <Text className="font-serif text-[13px] leading-5 text-ink-muted">
                Nothing else in this pose yet.
              </Text>
            ) : (
              candidates.map((candidate) => (
                <Pressable
                  key={candidate.id}
                  accessibilityRole="button"
                  accessibilityState={{ selected: candidate.id === later.id }}
                  accessibilityLabel={`Compare against ${formatPhotoDate(candidate.taken_on)}`}
                  onPress={() => setOverride({ a: earlier.id, b: candidate.id })}
                  className={
                    candidate.id === later.id
                      ? 'min-h-[36px] justify-center border border-ink px-3 py-1.5 active:opacity-60'
                      : 'min-h-[36px] justify-center border border-hairline px-3 py-1.5 active:opacity-60'
                  }>
                  <Text
                    className={
                      candidate.id === later.id
                        ? 'font-mono text-[11px] text-ink'
                        : 'font-mono text-[11px] text-ink-muted'
                    }>
                    {formatPhotoDate(candidate.taken_on)}
                  </Text>
                </Pressable>
              ))
            )}
          </View>
        </Block>
      </View>
    </Screen>
  );
}
