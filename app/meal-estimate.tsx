import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import {
  QuestionsPlate,
  ReviewItemsPlate,
  rowsFromEstimate,
  rowsToMealItems,
} from '@/components/nutrition/estimate-review';
import { Block } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { findFoodByBarcode } from '@/lib/db/repositories/foods';
import { logMealWithItems } from '@/lib/db/repositories/nutrition';
import { placeholderMealName, queueNewMealEstimate } from '@/lib/db/repositories/pending-estimates';
import { writePendingEstimatePhoto } from '@/lib/media/pending-estimate-store';
import { isQueueableFailure } from '@/lib/nutrition/estimate-queue';
import { useEstimateQuestions } from '@/hooks/use-estimate-questions';
import { useReviewDraft } from '@/hooks/use-review-draft';
import {
  ArcCameraView,
  type CameraHandle,
  FOOD_BARCODE_TYPES,
  isCameraAvailable,
  useCameraPermission,
} from '@/lib/media/camera';
import { normalizeBarcode } from '@/lib/nutrition/openfoodfacts';
import {
  type EstimateInput,
  estimateMeal,
  groundMealEstimate,
  isMealEstimationAvailable,
  type MealEstimate,
  MealEstimationUnavailableError,
} from '@/lib/nutrition/estimate';
import {
  attachMealPhoto,
  MEAL_PHOTO_RETENTION_DAYS,
  type CapturedPhoto,
} from '@/lib/media/meal-photo-store';
import { downscaleJpeg, pickPhotoBase64 } from '@/lib/media/photo-library';
import type { NewMealItem } from '@/lib/nutrition/types';

/**
 * AI meal estimation → editable review (docs/nutrition-subapp.md §6). Describe a
 * meal in words or photograph it; the Coach's model client itemizes it (one
 * turn, no tools), the result is GROUNDED against the catalog, and it lands here
 * as an editable review the user confirms. NOTHING is logged until Save — an
 * estimate is a labelled estimate (≈, per-item confidence), never a measurement.
 *
 * ONLINE-EXCEPT-AI: the model call is the exception; grounding, editing and
 * logging are offline. Photo capture is NATIVE (expo-camera + image-manipulator,
 * both in the binary since the owner's 2026-08-25 EAS build) and falls back
 * honestly on a build predating them; describe-in-words works as soon as a
 * key is set.
 *
 * ## The photo is kept now (owner, 2026-08-12)
 *
 * This screen used to downscale the shot, post it to the model and drop it. It
 * now rides through the review in state and is written to disk when — and only
 * when — the meal is saved, so a discarded estimate leaves no file behind. Both
 * capture paths hand back the same {@link CapturedPhoto} from the same
 * downscale (`downscaleJpeg`), and both are attached by the same single call in
 * {@link save}: there is exactly one place a meal photo is written, which is why
 * the camera and the library cannot drift apart. Storage, retention and the
 * row/file invariant live in src/lib/media/meal-photo-store.ts.
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
 * beneath it, recomputed from each row's live amount — edit or remove a row and
 * the total moves with it, because it is derived from exactly the items that
 * will be written.
 *
 * **Accent budget: one per phase.** Estimate (input), Capture (camera), Allow
 * camera (permission), Save meal (review). The phases are exclusive.
 *
 * ## One camera, two readings (owner, 2026-08-14)
 *
 * *"Can we put the barcode detection in the photo logging and combine the two?"*
 * — yes, and it is one `AVCaptureSession`, not two surfaces stitched together.
 * `CameraView` derives its native `barcodeScannerEnabled` from the presence of
 * `onBarcodeScanned`, and expo-camera adds the scanner as an
 * `AVCaptureMetadataOutput` **alongside** the `AVCapturePhotoOutput` it already
 * has. So the viewfinder that photographs a plate also reads a package, with no
 * mode switch and nothing new in the build.
 *
 * **Offered, never forced.** A packet in shot behind a plate must not hijack the
 * capture: `Capture` stays the one accent, in the same place, doing the same
 * thing, whether or not a code is in frame. A detected code appears as a row
 * BELOW that button — below, so nothing the thumb is already reaching for ever
 * moves under it — and it is a row you may ignore.
 *
 * **The two outcomes are different records, and the offer says which.** A
 * photograph becomes an AI estimate the user reviews; a barcode becomes a
 * catalog food at a chosen portion. Taking the offer therefore LEAVES this
 * screen for `/barcode-scan`, carrying the code: that screen already owns the
 * resolve ladder (local cache → Open Food Facts → manual) and the portion sheet
 * that states what the portion comes to. Duplicating either here would be a
 * second confirmation surface for the same write.
 *
 * Handing off also drops this screen back to `input`, which unmounts the
 * viewfinder — two live camera sessions stacked in one navigation stack is a
 * battery cost and an iOS interruption waiting to happen.
 *
 * The lookup behind the offer is **local only** (`findFoodByBarcode`, offline,
 * synchronous). Reaching Open Food Facts for a code nobody has accepted yet
 * would spend the network on a packet that merely wandered into frame.
 */

type Phase =
  | { kind: 'input' }
  | { kind: 'camera' }
  | { kind: 'estimating' }
  | { kind: 'review'; title: string; notes: string | null }
  /** The request never left the phone, so it was kept (0057, backlog C3). The
   *  meal is already in today's list under `name`; this phase says so. */
  | { kind: 'queued'; name: string; photoKept: boolean }
  | { kind: 'error'; message: string };

/** A code sitting in the viewfinder, with whatever the local catalog knows. */
type SeenCode = { code: string; name: string | null; brand: string | null };

export default function MealEstimateScreen() {
  const router = useRouter();
  // `start=camera` opens straight into the viewfinder — the Eat tab's Photo
  // quick-log (app/nutrition.tsx). Without it the screen opens on the field,
  // which is the Describe quick-log and the default.
  const { start } = useLocalSearchParams<{ start?: string }>();
  const [permission, requestPermission] = useCameraPermission();
  const cameraRef = useRef<CameraHandle | null>(null);
  const cameraInstalled = isCameraAvailable();
  const Camera = ArcCameraView;

  const available = isMealEstimationAvailable();
  const [phase, setPhase] = useState<Phase>(() =>
    start === 'camera' ? { kind: 'camera' } : { kind: 'input' }
  );
  const [seen, setSeen] = useState<SeenCode | null>(null);
  const [description, setDescription] = useState('');
  // The review's rows, every edit the table can make, and the Undo for its ×
  // (src/hooks/use-review-draft.ts) — shared with app/meal-revise.tsx.
  const draft = useReviewDraft();
  const rows = draft.rows;
  // The image behind the current estimate, held until Save writes it to disk.
  // Nothing is on the file system until then: a discarded review must leave no
  // trace, and the same shot re-estimated must not leave two.
  const [photo, setPhoto] = useState<CapturedPhoto | null>(null);
  // The model call is a live stream. Leaving mid-estimate must stop it, or it
  // runs to completion and is billed in full while its results land on an
  // unmounted screen. app/recipe-import.tsx does exactly this.
  const abortRef = useRef<AbortController | null>(null);
  useEffect(() => () => abortRef.current?.abort(), []);
  // The clarifying questions this estimate came back with (backlog C5). Shared
  // with app/meal-revise.tsx, so the two screens answer identically. Its rows
  // go through the CLOSING setter: an answer closes an open Undo, so a lit
  // chip always has its effect on the rows (src/lib/nutrition/review-undo.ts).
  const asking = useEstimateQuestions({
    rows,
    setRows: draft.replace,
    mealName: () => (phase.kind === 'review' ? phase.title : 'Meal'),
    onError: (message) => setPhase({ kind: 'error', message }),
  });

  /** Turn a grounded estimate into editable review rows — the shared builder,
   * so this screen and app/meal-revise.tsx price and nest identically
   * (src/components/nutrition/estimate-review.tsx). */
  const toReview = (estimate: MealEstimate) => {
    draft.replace(rowsFromEstimate(getDb(), estimate));
    asking.begin(estimate.questions);
    setPhase({ kind: 'review', title: estimate.title, notes: estimate.notes });
  };

  /**
   * Run one estimate. `captured` is the image it was made from, or null for the
   * describe-in-words path — passed in rather than set by each caller so that
   * re-estimating from text always CLEARS a stale photo instead of attaching
   * the last picture to a meal that was typed.
   */
  const run = async (input: EstimateInput, captured: CapturedPhoto | null = null) => {
    abortRef.current?.abort();
    const controller = new AbortController();
    abortRef.current = controller;
    setPhoto(captured);
    setPhase({ kind: 'estimating' });
    try {
      const grounded = groundMealEstimate(getDb(), await estimateMeal(input, controller.signal));
      toReview(grounded);
    } catch (error) {
      // A cancel is not a failure and gets no message — the screen is gone.
      if (controller.signal.aborted) return;
      // OFFLINE: the request never reached the model, so it is KEPT rather than
      // lost (0057, backlog C3). ARC data has one copy — a plate photographed on
      // a plane and thrown away is a meal that never happened.
      if (isQueueableFailure(error) && queue(input, captured)) return;
      const message =
        error instanceof MealEstimationUnavailableError
          ? error.message
          : 'Couldn’t estimate that meal. Check your connection and try again, or log it manually.';
      setPhase({ kind: 'error', message });
    }
  };

  /**
   * Keep an estimate that could not be made: park the photo, write a visible
   * placeholder meal and the queue entry in one transaction, and say so.
   *
   * Returns false if even that fails, in which case the caller falls back to the
   * ordinary error — a promise that was not actually kept must not be printed.
   */
  const queue = (input: EstimateInput, captured: CapturedPhoto | null): boolean => {
    const words = input.kind === 'text' ? input.description : (input.description ?? '');
    try {
      // The bytes first: a file with no row is reclaimed by the pending
      // directory's orphan pass, while a row pointing at nothing is a request
      // that silently degrades to its words.
      const fileName = captured ? writePendingEstimatePhoto(captured.base64Jpeg) : null;
      const name = placeholderMealName(words);
      const now = new Date();
      queueNewMealEstimate(
        getDb(),
        { date: todayISODate(), time: clockFromISO(now.toISOString()), name },
        {
          kind: input.kind === 'photo' ? 'photo' : 'text',
          description: words.trim() === '' ? null : words.trim(),
          file_name: fileName,
          width: captured?.width ?? null,
          height: captured?.height ?? null,
        }
      );
      // The photo now belongs to the queue, not to this screen: leaving Save
      // unreachable is the point, and a stale CapturedPhoto here could attach
      // the same image twice when the drain lands.
      setPhoto(null);
      setPhase({ kind: 'queued', name, photoKept: fileName !== null });
      return true;
    } catch (error) {
      console.warn('[meal-estimate] could not queue the estimate', error);
      return false;
    }
  };

  /**
   * The photo-library path (owner request, 2026-08-11). It is a third INPUT to
   * the pipeline that already exists — pick, downscale, then the same
   * estimate → ground → editable review as the camera and the description. A
   * typed description, if there is one, rides along as context.
   *
   * Like the camera, it is native and therefore falls back honestly on a
   * build predating the module; unlike a crash, `unavailable` is a sentence.
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
    await estimateFromPhoto({ ...picked, source: 'library' });
  };

  /**
   * The join point. Both capture paths converge here, so the bytes the model
   * sees and the bytes stored on the meal are the same object by construction —
   * not by two call sites agreeing to downscale the same way.
   */
  const estimateFromPhoto = async (captured: CapturedPhoto) => {
    await run(
      {
        kind: 'photo',
        base64Jpeg: captured.base64Jpeg,
        mediaType: 'image/jpeg',
        description: description.trim() || undefined,
      },
      captured
    );
  };

  /**
   * A code in the viewfinder. Fires on every frame it stays in view, so this
   * ignores the code it is already showing rather than re-reading the catalog
   * sixty times a second. Nothing navigates and nothing is written: the offer is
   * drawn below the capture button and the user decides.
   */
  const onBarcodeSeen = (raw: string) => {
    const code = normalizeBarcode(raw);
    if (code === '' || code === seen?.code) return;
    const known = findFoodByBarcode(getDb(), code);
    setSeen({ code, name: known?.name ?? null, brand: known?.brand ?? null });
  };

  /**
   * Take the offer: hand the code to the scanner screen, which owns the resolve
   * ladder and the portion sheet, and drop back to `input` so this screen's
   * viewfinder unmounts rather than running under the pushed one.
   */
  const followBarcode = (code: string) => {
    setSeen(null);
    setPhase({ kind: 'input' });
    router.push({ pathname: '/barcode-scan', params: { code } });
  };

  const capturePhoto = async () => {
    try {
      const shot = await cameraRef.current?.takePictureAsync({ quality: 0.7 });
      if (!shot?.uri) return setPhase({ kind: 'input' });
      // Downscale + recompress so only a small JPEG leaves the device — through
      // the shared pass in src/lib/media/photo-library.ts, which is also what
      // pulls `expo-image-manipulator` out of this ROUTE file's static imports.
      // The capture reports its own dimensions, so the shared pass bounds the
      // LONG edge in one go rather than bounding the width (which on a portrait
      // plate shot is ~3× the visual tokens for the same picture).
      const shrunk = await downscaleJpeg(shot.uri, {
        source: { width: shot.width, height: shot.height },
      });
      if (!shrunk) return setPhase({ kind: 'error', message: 'Couldn’t process the photo.' });
      await estimateFromPhoto({ ...shrunk, source: 'camera' });
    } catch {
      setPhase({
        kind: 'error',
        message: 'Couldn’t take the photo. Try describing the meal instead.',
      });
    }
  };

  const save = () => {
    if (rows.length === 0) return;
    const items: NewMealItem[] = rowsToMealItems(rows);
    const now = new Date();
    const title = phase.kind === 'review' ? phase.title : 'Meal';
    try {
      const { mealId } = logMealWithItems(getDb(), {
        date: todayISODate(),
        time: clockFromISO(now.toISOString()),
        name: title,
        notes: phase.kind === 'review' ? phase.notes : null,
        source: 'ai_suggested',
        items,
      });
      // The ONE place a meal photo is written. It cannot throw and it cannot
      // fail the meal: an unattachable picture (no file system module, a full
      // disk) leaves a saved meal with no photo, which is a state the meal
      // screen already draws — nothing.
      if (photo) attachMealPhoto(getDb(), mealId, photo);
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
              Add a key in the Coach tab. Add food and manual entry work offline.
            </Text>
          </Block>
        </View>
      </Screen>
    );
  }

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
              // A stale offer from the last visit to the viewfinder must not be
              // waiting under the button when it reopens.
              onPress={() => {
                setSeen(null);
                setPhase({ kind: 'camera' });
              }}
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
                Every item is reviewed and adjustable before anything is logged.
              </Text>
            </Block>
          </View>
        </View>
      ) : null}

      {phase.kind === 'camera' ? (
        /* The absent module is a SENTENCE, not a spinner. `permission` stays
           null forever without the native module, so reading null as "still
           loading" would print "Preparing the camera…" until the end of time. */
        !cameraInstalled || Camera === null ? (
          <View className="mt-6">
            <Block device="margin">
              <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
                The camera needs the next app build — it isn’t in this one yet. Choose a photo from
                your library, or describe the meal.
              </Text>
            </Block>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Back to describing the meal"
              onPress={() => setPhase({ kind: 'input' })}
              className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
              <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
                Describe it instead
              </Text>
            </Pressable>
          </View>
        ) : !permission ? (
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
              onPress={() => void requestPermission()}
              className="mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine py-3 active:opacity-70">
              <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
                Allow camera
              </Text>
            </Pressable>
          </View>
        ) : (
          <View className="mt-4">
            <View className="aspect-square w-full overflow-hidden border border-hairline bg-ink">
              {/* Barcode detection rides the SAME view and the same session —
                  passing `onBarcodeScanned` is what switches the native scanner
                  on. Nothing about the photo path changes. */}
              <Camera
                ref={cameraRef}
                style={{ flex: 1 }}
                facing="back"
                barcodeScannerSettings={{ barcodeTypes: FOOD_BARCODE_TYPES }}
                onBarcodeScanned={({ data }) => onBarcodeSeen(data)}
              />
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

            {/* The offer. BELOW Capture, deliberately: a packet that wanders
                into shot behind a plate must never move the button the thumb is
                already travelling to. It is an alternative, so it takes no
                accent — the accent is spent on Capture in this phase. */}
            {seen ? (
              <View className="mt-5">
                <SectionLabel label="Barcode in frame" />
                <View className="mt-2">
                  <Block device="plate">
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel={
                        seen.name
                          ? `Log ${seen.name} from its barcode instead of photographing the meal`
                          : `Look up barcode ${seen.code}`
                      }
                      onPress={() => followBarcode(seen.code)}
                      className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
                      <Ionicons name="barcode-outline" size={19} color={palette.inkSecondary} />
                      <View className="flex-1">
                        {/* The product name if we have one — a barcode number
                            means nothing to a human. The digits are the fallback
                            and only the fallback, and they are a measured value,
                            so they take mono. */}
                        {seen.name ? (
                          <Text className="font-serif text-[16px] leading-5 text-ink">
                            {seen.name}
                            {seen.brand ? (
                              <Text className="font-serif text-ink-muted"> · {seen.brand}</Text>
                            ) : null}
                          </Text>
                        ) : (
                          <Text className="font-mono text-[15px] text-ink">{seen.code}</Text>
                        )}
                        <Text className="mt-0.5 font-serif text-[13px] leading-5 text-ink-secondary">
                          {seen.name ? 'Saved earlier — log a portion' : 'Not scanned before'}
                        </Text>
                      </View>
                      <Ionicons name="chevron-forward" size={16} color={palette.inkSecondary} />
                    </Pressable>
                  </Block>
                </View>
              </View>
            ) : null}
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

      {/* QUEUED — the offline outcome, stated as what HAPPENED and what will
          happen, in that order. It is not an error and does not wear an error's
          words: the meal exists, it is in today's list, and the numbers are
          owed. The accent is not spent here — nothing on this screen is the
          next action any more. */}
      {phase.kind === 'queued' ? (
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-serif text-[15px] leading-6 text-ink">
              No connection, so the estimate is waiting.
            </Text>
            <Text className="mt-2 font-serif text-[14px] leading-6 text-ink-secondary">
              “{phase.name}” is logged on today with no numbers yet.
              {phase.photoKept ? ' The photo is kept with it.' : ''} ARC estimates it the next time
              you open the app with a connection, and fills the items in.
            </Text>
            <Text className="mt-2 font-serif text-[13px] leading-5 text-ink-muted">
              Until then the day counts what it knows rather than what is left. Delete the meal to
              drop the request.
            </Text>
          </Block>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Done"
            onPress={() => router.back()}
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn border border-ink py-3 active:opacity-60">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-ink">
              Done
            </Text>
          </Pressable>
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

          {/* A FEW THINGS — above the item table, deliberately (backlog C5).
              The rows ARE the answer: tapping a chip re-prices them, and on a
              phone a control below the thing it changes makes the change happen
              off-screen. Absent on most meals, which is the point. */}
          {asking.questions.length > 0 ? (
            <View className="mt-4">
              <QuestionsPlate
                questions={asking.questions}
                answers={asking.answers}
                otherFor={asking.otherFor}
                otherText={asking.otherText}
                otherBusy={asking.otherBusy}
                handlers={asking.handlers}
              />
            </View>
          ) : null}

          {/* The plate holds in both states: with every row removed the block
              still stands where the draft record stands. (The sweep of
              2026-08-10 made it conditional; reverted at the owner's
              instruction.) The tree, the disclosure and the fraction chips are
              the SHARED review table — one copy, so this screen and
              app/meal-revise.tsx cannot drift apart on what a composite means. */}
          <View className="mt-4">
            <ReviewItemsPlate
              rows={rows}
              label="Items"
              emptyNote="No items left. Discard, or go back and re-estimate."
              handlers={draft.handlers}
              undo={draft.offer ? { offer: draft.offer, onUndo: draft.undo } : null}
            />
          </View>

          {/* The decision, in future tense, immediately above the control that
              makes it — and nothing after it but its other branch. The photo
              clause appears only when there IS one, and it states the retention
              out loud: a picture that vanishes in a week without warning is a
              surprise, and the window is policy, not an accident. */}
          <Text className="mt-5 font-serif text-[13px] leading-5 text-ink-muted">
            On save: logged onto today at the current time, labelled as an AI estimate.
            {photo
              ? ` The photo is kept with the meal for ${MEAL_PHOTO_RETENTION_DAYS} days, then cleared.`
              : ''}{' '}
            Discarding writes nothing.
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
