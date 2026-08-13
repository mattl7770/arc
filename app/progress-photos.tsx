import Ionicons from '@expo/vector-icons/Ionicons';
import { useRouter } from 'expo-router';
import { useState } from 'react';
import { Image, Pressable, Text, View } from 'react-native';

import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useProgressGallery, type GalleryPhoto } from '@/hooks/use-progress-photos';
import { poseCount } from '@/lib/db/repositories/progress-photos';
import { isPhotoLibraryAvailable } from '@/lib/media/photo-library';
import { photoDayNumber, poseLabel, poseLetter } from '@/lib/photos/format';
import type { PhotoPose } from '@/lib/photos/types';

/**
 * Progress photos — the gallery hub, pushed from the Data tab
 * (docs/progress-photos-subapp.md §4).
 *
 * ## The surface system
 *
 * **One accent, and it is "Add photos".** A stamped plate at the head of the
 * sheet, hatched cap and all — the labs import-stamp pattern, because this is
 * the same kind of object: the one directive thing on an otherwise
 * reference-shaped screen. Everything else here is ink weight and rule.
 *
 * **Each month is a ruled plate** whose label carries a true tally in the mono
 * note slot (`4 photos · 2 poses`), derived from exactly the rows drawn beneath
 * it. The grid of cells inside is plain `View`s: devices never nest, so the
 * plate is the device and the grid is layout.
 *
 * **The pose filter is neutral chrome.** It is interface state, not biology, so
 * no signal colour touches it (the firewall rule, 00-design-spec.md §2).
 *
 * ## Empty and degraded are authored, never blank
 *
 * Three distinct states, and they say three different things:
 *   - no photos yet → what to do, and where the originals stay;
 *   - no picker in this binary → the honest "rides the next app build"
 *     sentence, with the control disabled rather than dead;
 *   - a row whose file is missing → "Not on this phone", drawn in the cell.
 *     Never a broken image, and never a deleted row (the sweep leaves those
 *     rows alone on purpose — see src/lib/media/progress-photo-store.ts).
 *
 * ## Compare is a selection mode, not a second screen
 *
 * Tapping Compare turns the cells into a two-slot picker. The slots are ordered
 * by DATE, not by tap order, so `a` is always the earlier photo — the compare
 * screen and the model prompt both depend on that being true without asking.
 */

/** How the cell's frame is proportioned. A standing body photo is portrait, and
 *  a square crop would cut the head or the feet off every one of them. */
const CELL_ASPECT = 3 / 4;

function PhotoCell({
  photo,
  onPress,
  selectedIndex,
}: {
  photo: GalleryPhoto;
  onPress: () => void;
  /** 1 or 2 when this cell is a compare slot; null when not selecting. */
  selectedIndex: number | null;
}) {
  const caption = `${photoDayNumber(photo.taken_on)} ${poseLetter(photo.pose)}`;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={selectedIndex ? { selected: true } : undefined}
      accessibilityLabel={`${poseLabel(photo.pose)}, ${photo.taken_on}${
        photo.uri ? '' : ', image not on this phone'
      }${selectedIndex ? `, selected as photo ${selectedIndex}` : ''}`}
      onPress={onPress}
      className="w-1/3 p-1 active:opacity-70">
      <View
        className="w-full overflow-hidden border border-hairline bg-paper-dim"
        style={{ aspectRatio: CELL_ASPECT }}>
        {photo.uri ? (
          <Image source={{ uri: photo.uri }} resizeMode="cover" style={{ flex: 1 }} />
        ) : (
          <View className="flex-1 items-center justify-center px-1">
            <Text className="text-center font-serif text-[10px] leading-3 text-ink-muted">
              Not on this phone
            </Text>
          </View>
        )}
        {/* The selection mark is a FILLED view, not a border — the one way a
            mark is ever drawn in this app (src/components/ui/block.tsx). */}
        {selectedIndex ? (
          <View className="absolute left-0 top-0 h-5 w-5 items-center justify-center bg-pine">
            <Text className="font-mono text-[11px] text-pine-on">{selectedIndex}</Text>
          </View>
        ) : null}
      </View>
      <Text className="mt-1 font-mono text-[10px] text-ink-muted">{caption}</Text>
    </Pressable>
  );
}

/** The neutral filter chip. Interface state, so no signal colour and no accent —
 *  the current one is marked by ink weight and the hairline alone. */
function FilterChip({
  label,
  active,
  onPress,
}: {
  label: string;
  active: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ selected: active }}
      accessibilityLabel={`Show ${label}`}
      onPress={onPress}
      className={
        active
          ? 'min-h-[36px] justify-center border border-ink bg-paper-hi px-3 py-1.5 active:opacity-60'
          : 'min-h-[36px] justify-center border border-hairline px-3 py-1.5 active:opacity-60'
      }>
      <Text
        className={
          active
            ? 'font-label text-[11px] font-semibold uppercase tracking-[1px] text-ink'
            : 'font-label text-[11px] uppercase tracking-[1px] text-ink-muted'
        }>
        {label}
      </Text>
    </Pressable>
  );
}

export default function ProgressPhotosScreen() {
  const router = useRouter();
  const [pose, setPose] = useState<PhotoPose | null>(null);
  const [selecting, setSelecting] = useState(false);
  const [selected, setSelected] = useState<string[]>([]);
  const { photos, months, total, posesPresent } = useProgressGallery(pose);
  const pickerReady = isPhotoLibraryAvailable();

  const tapCell = (photo: GalleryPhoto) => {
    if (!selecting) {
      router.push({ pathname: '/progress-photo-detail', params: { id: photo.id } });
      return;
    }
    setSelected((prev) => {
      if (prev.includes(photo.id)) return prev.filter((id) => id !== photo.id);
      // Two slots. A third tap replaces the older selection rather than being
      // silently ignored — a control that does nothing is worse than one that
      // does the obvious thing.
      return prev.length < 2 ? [...prev, photo.id] : [prev[1]!, photo.id];
    });
  };

  const leaveSelection = () => {
    setSelecting(false);
    setSelected([]);
  };

  const openCompare = () => {
    // Ordered by DATE, never by tap order: the compare screen captions them
    // "earlier" and "later", and the model prompt states that direction.
    const chosen = selected
      .map((id) => photos.find((p) => p.id === id))
      .filter((p): p is GalleryPhoto => p != null)
      .sort((x, y) => (x.taken_on < y.taken_on ? -1 : x.taken_on > y.taken_on ? 1 : 0));
    if (chosen.length !== 2) return;
    leaveSelection();
    router.push({
      pathname: '/progress-photo-compare',
      params: { a: chosen[0]!.id, b: chosen[1]!.id },
    });
  };

  const filterNote = pose ? `${photos.length} of ${total}` : `${total}`;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Progress photos" parent="Data" />
      </View>

      {/* a. The one accent. Disabled — with the reason in words — on a binary
          that has no picker in it yet. */}
      <View className="mt-5">
        <Block device="stamp" cap>
          <Text className="font-label text-[10px] font-semibold uppercase tracking-[1.2px] text-pine-deep">
            New photos
          </Text>
          <Text className="mt-2 font-serif text-[19px] font-semibold leading-6 text-ink">
            Bring in your progress photos
          </Text>
          <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
            Photograph yourself in the iOS Camera app — front, side, back — then bring them in here.
            ARC keeps a working copy; your originals stay in Photos.
          </Text>
          {pickerReady ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Add photos"
              onPress={() => router.push('/progress-photo-add')}
              className="mt-4 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine px-4 py-3 active:opacity-70">
              <Ionicons name="images-outline" size={18} color={palette.pineOn} />
              <Text className="font-label text-[15px] font-semibold text-pine-on">Add photos</Text>
            </Pressable>
          ) : (
            <View className="mt-4">
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Add photos, unavailable in this build"
                accessibilityState={{ disabled: true }}
                disabled
                className="min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-paper-deep px-4 py-3">
                <Ionicons name="images-outline" size={18} color={palette.inkMuted} />
                <Text className="font-label text-[15px] text-ink-muted">Add photos</Text>
              </Pressable>
              <Text className="mt-2 font-serif text-[12px] leading-5 text-ink-muted">
                Choosing photos rides the next app build — the photo-library module isn’t in this
                one yet. Everything already imported still opens.
              </Text>
            </View>
          )}
        </Block>
      </View>

      {total === 0 ? (
        <View className="mt-7">
          <Block device="margin">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              No photos yet. Three poses on the same morning, in the same light, is the set that
              compares well months later.
            </Text>
          </Block>
        </View>
      ) : (
        <>
          {/* b. Filter and compare — both neutral chrome, on one line. */}
          <View className="mt-6 flex-row flex-wrap items-center gap-2">
            <FilterChip label="All" active={pose === null} onPress={() => setPose(null)} />
            {posesPresent.map((p) => (
              <FilterChip
                key={p}
                label={poseLabel(p)}
                active={pose === p}
                onPress={() => setPose(p)}
              />
            ))}
          </View>

          <View className="mt-3 flex-row items-center gap-3">
            <Pressable
              accessibilityRole="button"
              accessibilityState={{ selected: selecting }}
              accessibilityLabel={selecting ? 'Cancel comparing' : 'Compare two photos'}
              onPress={() => (selecting ? leaveSelection() : setSelecting(true))}
              className="min-h-[44px] flex-row items-center gap-2 active:opacity-60">
              <Ionicons
                name={selecting ? 'close' : 'git-compare-outline'}
                size={16}
                color={palette.inkSecondary}
              />
              <Text className="font-label text-[12px] uppercase tracking-[1.2px] text-ink-secondary">
                {selecting ? 'Cancel' : 'Compare'}
              </Text>
            </Pressable>
            <View className="flex-1" />
            <Text className="font-mono text-[10px] text-ink-muted">{filterNote}</Text>
          </View>

          {selecting ? (
            <View className="mt-1">
              <Block device="margin">
                <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                  {selected.length === 0
                    ? 'Pick two photos to compare. Same pose reads best.'
                    : selected.length === 1
                      ? 'One picked. Pick a second.'
                      : 'Two picked — they’ll be shown oldest first.'}
                </Text>
              </Block>
              {selected.length === 2 ? (
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel="Compare the two selected photos"
                  onPress={openCompare}
                  className="mt-3 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
                  <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
                    Compare these two
                  </Text>
                </Pressable>
              ) : null}
            </View>
          ) : null}

          {/* c. One plate per month, newest first. */}
          {photos.length === 0 ? (
            <View className="mt-6">
              <Block device="margin">
                <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
                  No {pose ? poseLabel(pose).toLowerCase() : ''} photos yet. The other poses are
                  still there — tap All.
                </Text>
              </Block>
            </View>
          ) : (
            months.map((month) => (
              <View key={month.key} className="mt-6">
                <Block device="plate">
                  <SectionLabel
                    label={month.label}
                    note={`${month.photos.length} ${
                      month.photos.length === 1 ? 'photo' : 'photos'
                    } · ${poseCount(month.photos)} ${
                      poseCount(month.photos) === 1 ? 'pose' : 'poses'
                    }`}
                  />
                  <View className="-mx-1 mt-2 flex-row flex-wrap">
                    {month.photos.map((photo) => (
                      <PhotoCell
                        key={photo.id}
                        photo={photo}
                        selectedIndex={
                          selecting && selected.includes(photo.id)
                            ? selected.indexOf(photo.id) + 1
                            : null
                        }
                        onPress={() => tapCell(photo)}
                      />
                    ))}
                  </View>
                </Block>
              </View>
            ))
          )}
        </>
      )}
    </Screen>
  );
}
