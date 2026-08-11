import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { manipulateAsync, SaveFormat } from 'expo-image-manipulator';
import { useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { getFood } from '@/lib/db/repositories/foods';
import { logMealWithItems } from '@/lib/db/repositories/nutrition';
import {
  type EstimateInput,
  estimateMeal,
  groundMealEstimate,
  isMealEstimationAvailable,
  type MealEstimate,
  MealEstimationUnavailableError,
} from '@/lib/nutrition/estimate';
import { fmtInt } from '@/lib/nutrition/format';
import { pickPhotoBase64 } from '@/lib/media/photo-library';
import { itemForPortion, rescaleLoggedItem } from '@/lib/nutrition/servings';
import type { FoodRow, NewMealItem } from '@/lib/nutrition/types';

/**
 * AI meal estimation → editable review (docs/nutrition-subapp.md §6). Describe a
 * meal in words or photograph it; the Coach's model client itemizes it (one
 * turn, no tools), the result is GROUNDED against the catalog, and it lands here
 * as an editable review the user confirms. NOTHING is logged until Save — an
 * estimate is a labelled estimate (≈, per-item confidence), never a measurement.
 *
 * ONLINE-EXCEPT-AI: the model call is the exception; grounding, editing and
 * logging are offline. Photo capture is NATIVE (expo-camera + image-manipulator)
 * → needs the EAS rebuild; describe-in-words works as soon as a key is set.
 *
 * ## Conformed Set surface system
 *
 *   Description   → **recessed well**: a capture surface is stock you write on,
 *                   so the well IS the field and the `TextInput` inside it is
 *                   bare — form (a) of the capture-surface rule in
 *                   src/components/ui/block.tsx. Giving the input its own fill
 *                   would stack a recess on a recess and force it up onto plate
 *                   stock: an input is never `bg-paper-hi`.
 *   Prose         → **margin annotation** (the model's note, the error reason,
 *                   the standing caveat about estimates).
 *   Review items  → **ruled plate**: the proposed record is a table.
 *
 * **This screen's review IS a pending write, so it is drawn as a live decision**
 * (00-design-spec.md §5): the consequence is stated in future tense, it sits
 * directly above the control that performs it, and nothing but the two branches
 * of the decision follows. The outcome is never drawn alongside the proposal.
 *
 * **The ledger rule.** The Items label carries the total of the rows visible
 * beneath it, recomputed from each row's live grams — edit or remove a row and
 * the total moves with it, because it is derived from exactly the items that
 * will be written.
 *
 * **Accent budget: one per phase.** Estimate (input), Capture (camera), Allow
 * camera (permission), Save meal (review). The phases are exclusive.
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'camera' }
  | { kind: 'estimating' }
  | { kind: 'review'; title: string; notes: string | null }
  | { kind: 'error'; message: string };

/** One editable review row: the model's item, grounded, with a live grams edit. */
type ReviewItem = {
  key: string;
  name: string;
  foodId: string | null;
  food: FoodRow | undefined;
  confidence: 'high' | 'medium' | 'low';
  /** The base snapshot the grams edit re-scales from. */
  base: {
    grams: number | null;
    kcal: number | null;
    protein_g: number | null;
    carbs_g: number | null;
    fat_g: number | null;
    fiber_g: number | null;
    micros: string | null;
  };
  gramsText: string;
};

function parseGrams(text: string): number | null {
  const g = Number(text.trim());
  return Number.isFinite(g) && g > 0 && g <= 5000 ? g : null;
}

/** Current macros/micros for a review row at its edited grams — via the same
 * tested rescale used everywhere; falls back to the base when it can't scale. */
function currentPortion(row: ReviewItem) {
  const grams = parseGrams(row.gramsText);
  if (grams != null) {
    const scaled = rescaleLoggedItem(row.base, row.food, { grams });
    if (scaled) return scaled;
  }
  return {
    grams: row.base.grams,
    serving_qty: null,
    kcal: row.base.kcal,
    protein_g: row.base.protein_g,
    carbs_g: row.base.carbs_g,
    fat_g: row.base.fat_g,
    fiber_g: row.base.fiber_g,
    micros: row.base.micros,
  };
}

export default function MealEstimateScreen() {
  const router = useRouter();
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef<CameraView>(null);

  const available = isMealEstimationAvailable();
  const [phase, setPhase] = useState<Phase>({ kind: 'input' });
  const [description, setDescription] = useState('');
  const [rows, setRows] = useState<ReviewItem[]>([]);

  /** Turn a grounded estimate into editable review rows (loads each grounded
   * food so grams edits re-price from it). */
  const toReview = (estimate: MealEstimate) => {
    const db = getDb();
    const reviewRows: ReviewItem[] = estimate.items.map((item, i) => {
      const food = item.foodId ? getFood(db, item.foodId) : undefined;
      // A grounded item's base is derived from the food so macros AND micros are
      // consistent — including when the user clears the grams field (currentPortion
      // falls back to base). An ungrounded item keeps the model's numbers; the
      // model returns no micros, so those stay null.
      const grounded =
        food && item.grams != null && item.grams > 0
          ? itemForPortion(food, { grams: item.grams })
          : null;
      return {
        key: `${i}-${item.name}`,
        name: item.name,
        foodId: item.foodId,
        food,
        confidence: item.confidence,
        base: {
          grams: item.grams,
          kcal: grounded?.kcal ?? item.kcal,
          protein_g: grounded?.protein_g ?? item.protein_g,
          carbs_g: grounded?.carbs_g ?? item.carbs_g,
          fat_g: grounded?.fat_g ?? item.fat_g,
          fiber_g: grounded?.fiber_g ?? item.fiber_g,
          micros: grounded?.micros ?? null,
        },
        gramsText: item.grams != null ? String(Math.round(item.grams)) : '',
      };
    });
    setRows(reviewRows);
    setPhase({ kind: 'review', title: estimate.title, notes: estimate.notes });
  };

  const run = async (input: EstimateInput) => {
    setPhase({ kind: 'estimating' });
    try {
      const grounded = groundMealEstimate(getDb(), await estimateMeal(input));
      toReview(grounded);
    } catch (error) {
      const message =
        error instanceof MealEstimationUnavailableError
          ? error.message
          : 'Couldn’t estimate that meal. Check your connection and try again, or log it manually.';
      setPhase({ kind: 'error', message });
    }
  };

  /**
   * The photo-library path (owner request, 2026-08-11). It is a third INPUT to
   * the pipeline that already exists — pick, downscale, then the same
   * estimate → ground → editable review as the camera and the description. A
   * typed description, if there is one, rides along as context.
   *
   * Like the camera, it is native and therefore dormant until the next EAS
   * build; unlike a crash, `unavailable` is a sentence.
   */
  const choosePhoto = async () => {
    const picked = await pickPhotoBase64();
    if (picked.kind === 'canceled') return;
    if (picked.kind === 'unavailable') {
      return setPhase({
        kind: 'error',
        message:
          'Choosing a photo needs the next app build (the photo-library module isn’t in this one yet). Photograph it, or describe the meal instead.',
      });
    }
    if (picked.kind === 'failed') {
      return setPhase({ kind: 'error', message: 'Couldn’t read that photo. Try another one.' });
    }
    await run({
      kind: 'photo',
      base64Jpeg: picked.base64Jpeg,
      mediaType: 'image/jpeg',
      description: description.trim() || undefined,
    });
  };

  const capturePhoto = async () => {
    try {
      const photo = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
      if (!photo?.uri) return setPhase({ kind: 'input' });
      // Downscale + recompress so only a small JPEG leaves the device.
      const shrunk = await manipulateAsync(photo.uri, [{ resize: { width: 1024 } }], {
        compress: 0.6,
        format: SaveFormat.JPEG,
        base64: true,
      });
      if (!shrunk.base64)
        return setPhase({ kind: 'error', message: 'Couldn’t process the photo.' });
      await run({
        kind: 'photo',
        base64Jpeg: shrunk.base64,
        mediaType: 'image/jpeg',
        description: description.trim() || undefined,
      });
    } catch {
      setPhase({
        kind: 'error',
        message: 'Couldn’t take the photo. Try describing the meal instead.',
      });
    }
  };

  const setGrams = (key: string, text: string) => {
    setRows((prev) => prev.map((r) => (r.key === key ? { ...r, gramsText: text } : r)));
  };
  const removeRow = (key: string) => {
    setRows((prev) => prev.filter((r) => r.key !== key));
  };

  const save = () => {
    if (rows.length === 0) return;
    const items: NewMealItem[] = rows.map((row) => {
      const p = currentPortion(row);
      return {
        food_id: row.foodId,
        name: row.name,
        grams: p.grams,
        serving_qty: null,
        kcal: p.kcal,
        protein_g: p.protein_g,
        carbs_g: p.carbs_g,
        fat_g: p.fat_g,
        fiber_g: p.fiber_g,
        confidence: row.confidence,
        micros: p.micros,
      };
    });
    const now = new Date();
    const title = phase.kind === 'review' ? phase.title : 'Meal';
    try {
      logMealWithItems(getDb(), {
        date: todayISODate(),
        time: clockFromISO(now.toISOString()),
        name: title,
        notes: phase.kind === 'review' ? phase.notes : null,
        source: 'ai_suggested',
        items,
      });
      router.back();
    } catch (error) {
      console.warn('[meal-estimate] save failed', error);
      setPhase({ kind: 'error', message: 'Couldn’t save the meal. Try again.' });
    }
  };

  // --- Not configured -------------------------------------------------------
  if (!available) {
    return (
      <Screen scroll>
        <View className="pt-2">
          <StackHeader title="Describe or snap" />
        </View>
        <View className="mt-4">
          <Block device="margin">
            <Text className="font-serif text-[15px] leading-6 text-ink-secondary">
              AI meal estimation needs a model key — the same one the Coach uses.
            </Text>
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-muted">
              Add a key in the Coach tab, then come back. Meanwhile, Add food and Manual entry work
              offline.
            </Text>
          </Block>
        </View>
      </Screen>
    );
  }

  // The total of the rows actually on screen, at their live grams — a ledger
  // sums to its own total, so this moves with every edit and removal.
  const reviewKcal = rows.reduce<number | null>((sum, row) => {
    const kcal = currentPortion(row).kcal;
    return kcal == null ? sum : (sum ?? 0) + kcal;
  }, null);

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Describe or snap" />
      </View>

      {phase.kind === 'input' ? (
        <View className="mt-2">
          <Block device="well">
            <SectionLabel label="Describe the meal" />
            <TextInput
              value={description}
              onChangeText={setDescription}
              placeholder="e.g. grilled salmon, ½ cup rice, steamed broccoli"
              placeholderTextColor={palette.inkMuted}
              multiline
              accessibilityLabel="Describe the meal"
              className="mt-2 min-h-[88px] font-serif text-[15px] leading-6 text-ink"
            />
          </Block>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Estimate from description"
            accessibilityState={{ disabled: description.trim() === '' }}
            disabled={description.trim() === ''}
            onPress={() => void run({ kind: 'text', description: description.trim() })}
            className={
              description.trim() === ''
                ? 'mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn border border-paper-deep py-3'
                : 'mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70'
            }>
            <Ionicons
              name="sparkles-outline"
              size={18}
              color={description.trim() === '' ? palette.inkMuted : palette.pineOn}
            />
            <Text
              className={
                description.trim() === ''
                  ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                  : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on'
              }>
              Estimate
            </Text>
          </Pressable>

          {/* Two photo paths, equal weight: the camera for the plate in front
              of you, the library for the one you already took. Both outlined —
              the accent on this screen belongs to Estimate. */}
          <View className="mt-2 flex-row gap-2">
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Take a photo of the meal"
              onPress={() => setPhase({ kind: 'camera' })}
              className="min-h-[44px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:opacity-60">
              <Ionicons name="camera-outline" size={18} color={palette.inkSecondary} />
              <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
                Take a photo
              </Text>
            </Pressable>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Choose a photo from the library"
              onPress={() => void choosePhoto()}
              className="min-h-[44px] flex-1 flex-row items-center justify-center gap-2 rounded-btn border border-hairline py-3 active:opacity-60">
              <Ionicons name="images-outline" size={18} color={palette.inkSecondary} />
              <Text className="font-label text-[13px] uppercase tracking-[1.2px] text-ink">
                Choose a photo
              </Text>
            </Pressable>
          </View>

          <View className="mt-4">
            <Block device="margin">
              <Text className="font-serif text-[13px] leading-5 text-ink-muted">
                Estimates are just that — you’ll review and adjust every item before anything is
                logged.
              </Text>
            </Block>
          </View>
        </View>
      ) : null}

      {phase.kind === 'camera' ? (
        !permission ? (
          <Text className="mt-6 font-serif text-[14px] text-ink-secondary">
            Preparing the camera…
          </Text>
        ) : !permission.granted ? (
          <View className="mt-6">
            <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
              Photographing a meal needs camera access.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Allow camera"
              onPress={requestPermission}
              className="mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70">
              <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
                Allow camera
              </Text>
            </Pressable>
          </View>
        ) : (
          <View className="mt-4">
            <View className="aspect-square w-full overflow-hidden border border-hairline bg-ink">
              <CameraView ref={cameraRef} style={{ flex: 1 }} facing="back" />
            </View>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Capture photo"
              onPress={() => void capturePhoto()}
              className="mt-3 min-h-[44px] flex-row items-center justify-center gap-2 rounded-btn bg-pine py-3 active:opacity-70">
              <Ionicons name="camera" size={18} color={palette.pineOn} />
              <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
                Capture
              </Text>
            </Pressable>
          </View>
        )
      ) : null}

      {phase.kind === 'estimating' ? (
        <View className="mt-10 items-center">
          <ActivityIndicator color={palette.ink} />
          <Text className="mt-3 font-serif text-[14px] text-ink-secondary">
            Estimating the meal…
          </Text>
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
            accessibilityLabel="Try again"
            onPress={() => setPhase({ kind: 'input' })}
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Try again
            </Text>
          </Pressable>
        </View>
      ) : null}

      {phase.kind === 'review' ? (
        <View className="mt-2">
          <View className="flex-row items-baseline gap-2">
            <Text className="flex-1 font-serif text-lg font-semibold text-ink">{phase.title}</Text>
            <Text className="font-mono text-[10px] uppercase tracking-[1px] text-ink-muted">
              est · AI
            </Text>
          </View>

          {phase.notes ? (
            <View className="mt-2">
              <Block device="margin">
                <Text className="font-serif text-[13px] leading-5 text-ink-secondary">
                  {phase.notes}
                </Text>
              </Block>
            </View>
          ) : null}

          {/* The plate holds in both states: with every row removed the block
              still stands where the draft record stands. (The sweep of
              2026-08-10 made it conditional; reverted at the owner's
              instruction.) */}
          <View className="mt-4">
            <Block device="plate">
              <SectionLabel
                label="Items"
                note={reviewKcal !== null ? `${fmtInt(reviewKcal)} kcal` : undefined}
              />

              {rows.length === 0 ? (
                <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-secondary">
                  No items left. Discard, or go back and re-estimate.
                </Text>
              ) : (
                <View className="mt-1">
                  {rows.map((row, index) => {
                    const p = currentPortion(row);
                    return (
                      <View key={row.key}>
                        <Divider first={index === 0} />
                        <View className="py-3">
                          <View className="min-h-[44px] flex-row items-center gap-3">
                            <View className="flex-1">
                              <Text className="font-serif text-[15px] leading-5 text-ink">
                                {row.name}
                                <Text className="font-mono text-[10px] text-ink-muted">
                                  {'  '}≈ {row.confidence}
                                  {row.foodId ? ' · matched' : ''}
                                </Text>
                              </Text>
                            </View>
                            <View className="flex-row items-center gap-1">
                              <TextInput
                                value={row.gramsText}
                                onChangeText={(t) => setGrams(row.key, t)}
                                keyboardType="decimal-pad"
                                accessibilityLabel={`${row.name} grams`}
                                className="w-14 border border-paper-deep bg-paper-dim px-2 py-1.5 text-right font-mono text-[13px] text-ink"
                              />
                              <Text className="font-mono text-[11px] text-ink-secondary">g</Text>
                            </View>
                            <Text className="w-12 text-right font-mono text-[13px] text-ink-secondary">
                              {p.kcal != null ? fmtInt(p.kcal) : '—'}
                            </Text>
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Remove ${row.name}`}
                              hitSlop={12}
                              onPress={() => removeRow(row.key)}
                              className="h-8 w-8 items-center justify-center rounded-btn active:opacity-60">
                              <Ionicons name="close" size={16} color={palette.inkMuted} />
                            </Pressable>
                          </View>
                          <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
                            {p.protein_g != null ? `P ${Math.round(p.protein_g)}g` : ''}
                            {p.carbs_g != null ? ` · C ${Math.round(p.carbs_g)}g` : ''}
                            {p.fat_g != null ? ` · F ${Math.round(p.fat_g)}g` : ''}
                          </Text>
                        </View>
                      </View>
                    );
                  })}
                </View>
              )}
            </Block>
          </View>

          {/* The decision, in future tense, immediately above the control that
              makes it — and nothing after it but its other branch. */}
          <Text className="mt-5 font-serif text-[13px] leading-5 text-ink-muted">
            On save: logged onto today at the current time, labelled as an AI estimate. Discarding
            writes nothing.
          </Text>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Save this meal"
            accessibilityState={{ disabled: rows.length === 0 }}
            disabled={rows.length === 0}
            onPress={save}
            className={
              rows.length === 0
                ? 'mt-3 min-h-[44px] items-center justify-center rounded-btn border border-paper-deep py-3'
                : 'mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70'
            }>
            <Text
              className={
                rows.length === 0
                  ? 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                  : 'font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on'
              }>
              Save meal
            </Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Discard"
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
