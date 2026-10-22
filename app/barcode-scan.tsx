import Ionicons from '@expo/vector-icons/Ionicons';
import { useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { SessionMealName } from '@/components/nutrition/session-meal-name';
import { UndoRow } from '@/components/nutrition/undo-row';
import { Block, Divider } from '@/components/ui/block';
import { KEYPAD_DONE } from '@/components/ui/keyboard';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { selectAllOnFocus } from '@/components/ui/select-on-focus';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { useUndoOffer } from '@/hooks/use-undo-offer';
import { useUnitPreferences } from '@/hooks/use-unit-preferences';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import {
  cacheBarcodeFood,
  findFoodByBarcode,
  getFood,
  listRecentBarcodeFoods,
  refreshOffFood,
} from '@/lib/db/repositories/foods';
import { addMealItem, logMealWithItems } from '@/lib/db/repositories/nutrition';
import {
  ArcCameraView,
  FOOD_BARCODE_TYPES,
  isCameraAvailable,
  useCameraPermission,
} from '@/lib/media/camera';
import {
  fmtAmount,
  fmtInt,
  fmtQty,
  foodLabelRows,
  mealNameForProduct,
} from '@/lib/nutrition/format';
import {
  drinkLooksPerServing,
  energyLooksWrong,
  lookupOffProduct,
  normalizeBarcode,
  OffLookupError,
  type OffLabel,
} from '@/lib/nutrition/openfoodfacts';
import { confirmCaffeine } from '@/lib/nutrition/caffeine-confirm';
import { commitScanMealName, offersScanMealName } from '@/lib/nutrition/scan-meal-name';
import { amountForQty, itemForPortion, portionAfterHeal } from '@/lib/nutrition/servings';
import type { FoodRow, NewMealItem, RecentFood } from '@/lib/nutrition/types';
import { joinNearbyMealWithUndo, type JoinedMeal } from '@/lib/nutrition/undo-offers';
import { runUndo } from '@/lib/nutrition/undo-store';
import type { VolumeUnit } from '@/lib/user/types';

/**
 * Barcode scanning (docs/nutrition-subapp.md §7) — the one online-except-AI
 * path. A scan resolves LOCALLY first (findFoodByBarcode over the grown cache),
 * then Open Food Facts when the local cache misses; every OFF hit is cached
 * into `foods` (source='openfoodfacts'), so the pantry converges to offline
 * scanning. A miss (offline or not-in-OFF) falls back to manual entry.
 *
 * NATIVE DEP: expo-camera, reached through the guarded seam in
 * src/lib/media/camera.ts — never a static import in a route file, because Expo
 * Router requires every one of them to build its manifest and a missing native
 * module is then an app-LAUNCH crash. Absence is drawn in words here — on
 * web/node, or a build predating expo-camera (it landed in the owner's
 * 2026-08-25 EAS build). Pushed with an optional `mealId` (add to
 * that meal) or from Nutrition (creates a day-part meal on the first add, like
 * food search), and with an optional `code` — see below.
 *
 * ## Recently logged, for quick tapping (owner, 2026-08-14)
 *
 * *"Under scan a barcode, lets show a running list of the most recently logged
 * barcodes for quick tapping."* It sits under the viewfinder while scanning, and
 * the decisions in it are:
 *
 * - **Six rows.** A running list is the pantry you are actually rotating, not an
 *   archive; anything longer is a search, and the catalog already has one.
 * - **The product name, never the digits.** A barcode number means nothing to a
 *   human. Brand follows the name, and the portion it was last logged at follows
 *   that — mono, because a portion is a measurement.
 * - **Logged, not scanned.** `listRecentBarcodeFoods` joins through `meal_items`,
 *   so a code scanned and then abandoned never lands here, and a code that
 *   resolved to nothing never became a food row to begin with. The list is a
 *   re-log list; a thing nobody ate does not belong on it.
 * - **A tap opens the portion sheet, prefilled with last time's portion — it
 *   does not log.** The sheet already states what the portion comes to, and it
 *   is the same sheet a live scan lands in. One confirmation surface, not two.
 * - **No new table, no migration.** The data was already there: the scan caches
 *   a `foods` row and the log writes a `meal_items` row.
 *
 * ## The meal a scan creates is named after the product (owner, backlog A4)
 *
 * It used to be named after the clock — `daypartName(now)` — so a scan landed
 * as "Snack", which is a worse answer than the one the barcode had just given
 * and is the same fact the meal's own timestamp already carries. The first add
 * that CREATES a meal now titles it `name · brand` from the resolved product
 * (`mealNameForProduct`); a second scan into the same meal leaves the title
 * alone, and a meal arriving by `mealId` is never retitled. The day part
 * survives as the fallback, because `meals.name` is NOT NULL.
 *
 * ## …and a meal of several scans can be named before it is left (2026-09-23)
 *
 * The owner, from the device: *"meal name for scanning multiple foods."* A
 * session that logs a second food into the meal it created has stopped being
 * "the oat milk" and become breakfast, and the title A4 gave it is the first
 * product's. So once this screen has put TWO foods into a meal it created, a
 * **Name** field sits at the foot of the screen, holding the name the meal has
 * — the one it would have kept anyway (`SessionMealName`, shared with Add food
 * since 2026-10-21).
 *
 * - **It never blocks a quick save.** The field is prefilled and not focused;
 *   Done works untouched, and an untouched or emptied field writes nothing
 *   (`mealNameToSave`), so the default stands without a write.
 * - **What is typed is kept however the screen is left** — Done, the return
 *   key, the field losing focus, or the back chevron (an unmount commit), all
 *   through the one `updateMealName` the meal screen's rename uses.
 * - **Only a meal this session created.** A meal arriving by `mealId` is someone
 *   else's record (A4's rule) and is renamed on its own screen, as before.
 *
 * ## The `code` param — the merged camera's handoff
 *
 * `app/meal-estimate.tsx`'s viewfinder now also reads barcodes (owner, same
 * round). It never resolves one itself: taking its offer pushes this screen with
 * `code`, which resolves through the identical ladder below and lands in the
 * identical portion sheet. That is why the merge did not need a second
 * confirmation screen — this one already was it.
 *
 * Conformed Set treatment: the resolved product opens on a **ruled plate** — it
 * is a catalog record (name, brand, energy, provenance), and the portion editor
 * inside it draws no device of its own, exactly as in app/food-search.tsx, which
 * is the same editor. Only its amount input takes the recessed treatment, because
 * an input is a well at control scale; the steppers carry a hairline and no fill.
 * A `<Block device="well">` here would invert the surface system — a recessed
 * container can only hold raised controls, and an input is never `bg-paper-hi`
 * (the rule in src/components/ui/block.tsx). The follow-on choices are their own
 * plate. The miss path is a **margin annotation**, because its reason is prose.
 * The scanned code is a measured value, so it is mono everywhere it appears; it
 * is real data the next scan matches on, not a decorative reference.
 *
 * **Accent budget: one per phase.** Add (portion), Add manually (miss), Allow
 * camera (permission) — never two at once, because the phases are exclusive.
 *
 * ## Done goes back to where the scanning started (owner, 2026-10-21)
 *
 * *"Done button after scanning barcode so you don't have to hit back twice."*
 * Done sat at the foot of the screen, under the viewfinder and the six-row
 * running list — below the fold on a phone — and it went back ONE screen. From
 * Add food or from the photo camera that landed on the screen the scan was
 * started from, which then needed its own back. Now:
 *
 * - **Done is the header's trailing control**, once anything has been added,
 *   so it is on screen the moment the scanner resumes after an Add.
 * - **It closes the flow, not the screen.** A pusher that is itself part of the
 *   flow says so with `via` (`search` — Add food's "Scan a barcode"; `camera` —
 *   the photo logger's barcode offer), and Done dismisses both screens at once
 *   (`router.dismiss(2)`), landing on the Eat tab or the meal the flow began
 *   on. From the Eat tab's own Scan row there is no `via`, and Done goes back
 *   one, as before. The back chevron is untouched: it still goes back one.
 *
 * ## Per 100 and per serving, side by side (owner, 2026-10-21)
 *
 * The portion plate prints the food's figures per 100 of its unit AND per
 * serving (`foodLabelRows`), so a per-serving figure can never pass for a
 * per-100 one. A fresh Open Food Facts reading adds what it had to do: a line
 * when the figures were read per serving and divided here, and the reason when
 * the product's serving was left off (src/lib/nutrition/openfoodfacts.ts). A
 * product whose two sets of figures disagree IS cached, with OFF's per-100
 * figures as given, and the sheet marks it doubtful ("Label data looks
 * inconsistent"). Only a product whose figures cannot be placed at all —
 * per-serving figures with no serving to read them against, or ones that
 * divide past the food itself — is refused: it takes the miss path, with the
 * reason, and Add manually opens with its name and brand filled. **Edit this
 * food** opens the catalog entry itself (app/food-new.tsx, `id`), which is how
 * a product cached wrong before this round is put right.
 *
 * ## A heal that lands late (2026-10-21 review)
 *
 * The background re-read can land after the sheet has moved on. It keeps the
 * portion the user chose (`portionAfterHeal`) rather than resetting it; it is
 * aborted the moment **Edit this food** is tapped (the edit's own Save is a
 * compare-and-swap, and restarts it on return if the row is still OFF's); and
 * when it lands after an Add of that food, one quiet line says the item just
 * added used the old figures, with the meal a tap away. Holding Add until the
 * re-read settles was the alternative and is refused: it would make a local
 * hit wait on the network — up to the 10 s timeout on a stalled connection —
 * which is the one thing the offline-first ladder promises it never does, to
 * spare a rare case one line.
 */

type Phase =
  | { kind: 'scanning' }
  | { kind: 'resolving'; barcode: string }
  | {
      kind: 'portion';
      food: FoodRow;
      fromOff: boolean;
      /** How a fresh Open Food Facts read went; null for a row read locally
       *  and not (yet) re-read. */
      label: OffLabel | null;
      /** A local hit re-read in the background, and the cached row healed. */
      healed?: boolean;
    }
  | {
      kind: 'notfound';
      barcode: string;
      reason: string;
      /** A product Open Food Facts named but whose figures were refused. */
      prefill?: { name: string; brand: string | null };
    };

function daypartName(now: Date): string {
  const h = now.getHours();
  if (h < 11) return 'Breakfast';
  if (h < 16) return 'Lunch';
  if (h < 21) return 'Dinner';
  return 'Snack';
}

function parseAmount(text: string): number | null {
  const n = Number(text.trim());
  return Number.isFinite(n) && n > 0 && n <= 5000 ? n : null;
}

/** expo/fetch isn't needed for a plain GET+json — the global fetch works and
 * keeps this dependency-free. Forwards the abort signal for the request timeout. */
const offFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; signal?: AbortSignal }
) => fetch(url, init);

/**
 * One row of the follow-on plate.
 *
 * It draws no `border-t` — a hairline between rows needs a row above it. The
 * `first` flag the sweep deleted is not reinstated: the second row (Edit this
 * food, 2026-10-21) states its own rule at the call site with a `Divider`.
 */
function ScanRow({
  icon,
  label,
  accessibilityLabel,
  onPress,
}: {
  icon: keyof typeof Ionicons.glyphMap;
  label: string;
  accessibilityLabel: string;
  onPress: () => void;
}) {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      className="min-h-[44px] flex-row items-center gap-3 py-3 active:opacity-60">
      <Ionicons name={icon} size={17} color={palette.inkSecondary} />
      <Text className="flex-1 font-serif text-[15px] text-ink">{label}</Text>
      <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
    </Pressable>
  );
}

/**
 * One row of the running list. The name leads, the brand qualifies it, and the
 * portion it was last logged at is the mono trailing value — the same anatomy
 * as the recents rail in app/food-search.tsx, which is the same idea.
 */
function RecentBarcodeRow({
  recent,
  first,
  volume,
  onPress,
}: {
  recent: RecentFood;
  first: boolean;
  volume: VolumeUnit;
  onPress: () => void;
}) {
  const { food, lastAmount, lastServingQty } = recent;
  const portion =
    lastServingQty != null && food.serving_name
      ? `${fmtQty(lastServingQty)} × ${food.serving_name}`
      : lastAmount != null
        ? fmtAmount(lastAmount, food.basis, volume)
        : null;
  return (
    <View>
      <Divider first={first} />
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`${food.name}${food.brand ? `, ${food.brand}` : ''}. Choose a portion.`}
        onPress={onPress}
        className="min-h-[46px] flex-row items-center gap-3 py-3 active:opacity-60">
        <View className="flex-1">
          <Text className="font-serif text-[15px] leading-5 text-ink">
            {food.name}
            {food.brand ? <Text className="font-serif text-ink-muted"> · {food.brand}</Text> : null}
          </Text>
        </View>
        {/* No portion recorded is an em-dash, never a stand-in number. */}
        <Text className="font-mono text-[12px] text-ink-secondary">{portion ?? '—'}</Text>
        <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
      </Pressable>
    </View>
  );
}

/**
 * The food's label, both ways (2026-10-21): per 100 of its unit, and per
 * serving when it names one. Label voice for the head, mono for the figures —
 * they measure. Exported so the render suite can draw it from a food row.
 */
export function LabelRows({ food }: { food: FoodRow }) {
  return (
    <View className="mt-2">
      {/* Head above figures, not beside them: "Per serving · 250 ml" is
          longer than any fixed column a 375 pt plate can spare. */}
      {foodLabelRows(food).map((row) => (
        <View key={row.head} className="mt-1">
          <Text className="font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
            {row.head}
          </Text>
          <Text className="font-mono text-[11px] text-ink-secondary">{row.figures}</Text>
        </View>
      ))}
    </View>
  );
}

/**
 * What the reading had to do, in quiet serif lines under the label rows — the
 * margin's voice without a margin device, because they sit inside the plate
 * and devices never nest. No colour: an inconsistent label is a fact about the
 * data, not a biological state, so it takes no signal hue and no accent.
 *
 * With a fresh reading, its own verdict is the one shown: it was judged with
 * what only the reading knows (alcohol, polyols, both columns). Without one —
 * a cached food opened offline — the ROW is asked (`energyLooksWrong`,
 * `drinkLooksPerServing`), so a food cached before this round still says so —
 * as a STORED row (`storedRow`), which keeps no polyols: a cached sugar-free
 * sweet whose only excess is carbohydrate is not called inconsistent while the
 * re-read is in flight, or for good offline (2026-10-21 fix round).
 */
export function LabelNotes({
  food,
  label,
  healed,
}: {
  food: FoodRow;
  label: OffLabel | null;
  healed: boolean;
}) {
  const lines: string[] = [];
  if (
    label
      ? label.doubtful
      : energyLooksWrong(food, { storedRow: true }) || drinkLooksPerServing(food)
  ) {
    lines.push(`Label data looks inconsistent — check per 100 ${food.basis}.`);
  }
  if (healed) lines.push('Updated from Open Food Facts just now — the saved figures were different.');
  if (label?.read === 'rescaled') {
    lines.push(
      'Open Food Facts had the per-serving figures in its per-100 column; they were divided by the serving’s size.'
    );
  } else if (label?.read === 'serving') {
    lines.push('Read from the per-serving label and divided by the serving’s size.');
  }
  if (label?.servingDropped) lines.push(label.servingDropped);
  return (
    <>
      {lines.map((line) => (
        <Text key={line} className="mt-1.5 font-serif text-[12px] leading-5 text-ink-muted">
          {line}
        </Text>
      ))}
    </>
  );
}

/**
 * How many screens Done closes: this one, plus the screen that pushed it when
 * that screen is part of the same logging flow (`via`). Exported for the
 * render suite, which cannot tap.
 */
export function doneDismissCount(via: string | undefined): number {
  return via === 'search' || via === 'camera' ? 2 : 1;
}

export default function BarcodeScanScreen() {
  const router = useRouter();
  const {
    mealId,
    code: incomingCode,
    via,
  } = useLocalSearchParams<{
    mealId?: string;
    code?: string;
    /** The pusher, when it is part of this logging flow: `search` | `camera`. */
    via?: string;
  }>();
  const [permission, requestPermission] = useCameraPermission();
  const cameraInstalled = isCameraAvailable();
  const Camera = ArcCameraView;

  // A code handed over by the merged camera, normalized once. Empty means there
  // was none (or it was junk), and the screen opens on the viewfinder as always.
  const handoff = incomingCode ? normalizeBarcode(incomingCode) : '';
  // Opening straight into `resolving` matters: entering on `scanning` would
  // mount a viewfinder for one frame, starting an AVCaptureSession that is
  // about to be torn down — and doing it while the screen we were pushed FROM
  // is still unmounting its own.
  const [phase, setPhase] = useState<Phase>(() =>
    handoff === '' ? { kind: 'scanning' } : { kind: 'resolving', barcode: handoff }
  );
  const [added, setAdded] = useState(0);
  // Read once, in the initializer: the list is a snapshot of what was recent
  // when the scanner opened, and re-reading it under the user's finger would
  // reorder the rows they are aiming at. It refreshes on the next visit.
  const [recents] = useState<RecentFood[]>(() => listRecentBarcodeFoods(getDb()));
  // Display-only: whether a millilitre portion READS as ml or oz.
  const { units } = useUnitPreferences();
  const [targetMealId, setTargetMealId] = useState<string | null>(mealId ?? null);
  // The name of the meal THIS session created, as it stands — null when the
  // meal arrived by `mealId`, or none has been created yet. And the name typed
  // over it, null while the field is untouched (2026-09-23).
  const [createdName, setCreatedName] = useState<string | null>(null);
  const [nameDraft, setNameDraft] = useState<string | null>(null);
  // A first scan that joined a meal logged near it (item 58): its receipt, drawn
  // under the running count and kept on leaving — the Eat tab draws it too.
  const joinUndo = useUndoOffer('list', todayISODate(), { closeOnLeave: false });
  const [joined, setJoined] = useState<JoinedMeal | null>(null);
  // Portion editor state (mirrors food search's). The typed amount is always in
  // the FOOD'S own unit (g or ml) — the oz/ml preference governs read-only
  // figures, never an entry box (see app/food-search.tsx's Portion type).
  const [mode, setMode] = useState<'serving' | 'amount'>('amount');
  const [qty, setQty] = useState(1);
  const [amountText, setAmountText] = useState('100');
  // onBarcodeScanned fires every frame the code is in view. This guards against
  // a burst of concurrent lookups for one scan, and against instantly
  // re-resolving the SAME code when the camera remounts (Scan another / after an
  // add) while the product is still in frame — which would double-add it.
  const scan = useRef<{ busy: boolean; code: string; at: number }>({
    busy: false,
    code: '',
    at: 0,
  });

  /** Return to live scanning and release the scan lock (keeping the last code +
   * time so the just-scanned item is ignored during the cooldown). */
  const resumeScanning = () => {
    scan.current.busy = false;
    setPhase({ kind: 'scanning' });
  };

  /**
   * Open the portion sheet for a resolved food. `last` is the portion it was
   * logged at before, supplied only by the running list — a repeat item is
   * almost always the same amount, and the sheet still shows what it comes to
   * before anything is written.
   */
  const openPortion = (
    food: FoodRow,
    fromOff: boolean,
    last?: { amount: number | null; servingQty: number | null },
    label: OffLabel | null = null
  ) => {
    if (last?.servingQty != null && food.serving_amount != null) {
      setMode('serving');
      setQty(last.servingQty);
      setAmountText(fmtQty(amountForQty(food, last.servingQty) ?? food.serving_amount));
    } else if (last?.amount != null) {
      setMode('amount');
      setAmountText(fmtQty(last.amount));
    } else if (food.serving_amount != null) {
      setMode('serving');
      setQty(1);
      setAmountText(fmtQty(food.serving_amount));
    } else {
      setMode('amount');
      setAmountText('100');
    }
    setPhase({ kind: 'portion', food, fromOff, label });
  };

  // The phase and the portion as last rendered, for the background re-read
  // below to ask whether the sheet it would update is still the one on screen,
  // and what portion it holds.
  const phaseRef = useRef(phase);
  const portionRef = useRef({ mode, qty, amountText });
  useEffect(() => {
    phaseRef.current = phase;
    portionRef.current = { mode, qty, amountText };
  });
  // The re-reads in flight, by food id — so Edit this food can abort its own.
  const refreshes = useRef(new Map<string, AbortController>());
  // A re-read aborted for an edit, to restart on return if the row is still OFF's.
  const refreshPaused = useRef<string | null>(null);
  // The meal each food was last added to this session — a heal that lands
  // after the Add says so (see the header).
  const addedTo = useRef(new Map<string, string>());
  // The food whose scan joined a nearby meal, for the join's Undo to remap.
  const joinedFood = useRef<string | null>(null);
  const [staleAdd, setStaleAdd] = useState<{ name: string; mealId: string } | null>(null);

  /**
   * A local hit that is still Open Food Facts' own is re-read in the
   * background (2026-10-21). The sheet opens at once on the cached row — the
   * offline-first ladder is unchanged, and offline this fails silently into
   * exactly what it did before. When OFF now says something different, the
   * cached row is healed (`refreshOffFood`, which never touches a row the user
   * edited) and, if the sheet is still on that food, it is redrawn from the
   * healed row — keeping the portion chosen (`portionAfterHeal`) — and says so.
   * Something already added keeps its own snapshot, and is named (header).
   */
  const refreshFromOff = async (food: FoodRow) => {
    if (food.source !== 'openfoodfacts' || !food.barcode) return;
    refreshes.current.get(food.id)?.abort();
    const controller = new AbortController();
    refreshes.current.set(food.id, controller);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const off = await lookupOffProduct(food.barcode, offFetch, controller.signal);
      // Aborted (Edit this food, a newer re-read, the timeout) after the
      // response was already in hand: drop it all the same.
      if (controller.signal.aborted) return;
      if (!off || off.kind !== 'food') return;
      const healed = refreshOffFood(getDb(), food.id, off.food);
      const added = addedTo.current.get(food.id);
      if (healed && added !== undefined) setStaleAdd({ name: healed.name, mealId: added });
      const current = phaseRef.current;
      if (current.kind !== 'portion' || current.food.id !== food.id) return;
      if (healed) {
        const next = portionAfterHeal(current.food, healed, portionRef.current);
        setMode(next.mode);
        setQty(next.qty);
        setAmountText(next.amountText);
      }
      setPhase({ ...current, food: healed ?? current.food, label: off.label, healed: !!healed });
    } catch {
      // Offline, or OFF unreachable: the cached row stands, as it always did.
    } finally {
      clearTimeout(timeout);
      if (refreshes.current.get(food.id) === controller) refreshes.current.delete(food.id);
    }
  };

  /** Edit this food: the re-read in flight for it stops here, so it cannot
   *  heal the row under the open form (whose Save would refuse anyway). */
  const editFood = (food: FoodRow) => {
    const inFlight = refreshes.current.get(food.id);
    if (inFlight) {
      inFlight.abort();
      refreshPaused.current = food.id;
    }
    router.push({ pathname: '/food-new', params: { id: food.id } });
  };

  /**
   * Back from editing the food (Edit this food): the sheet reads the row as it
   * now is, and its portion starts again from the food's serving — the serving
   * the old figures were set from may be the thing that was corrected. A food
   * deleted meanwhile returns the screen to scanning.
   */
  useFocusEffect(
    useCallback(() => {
      if (phase.kind !== 'portion') return;
      const fresh = getFood(getDb(), phase.food.id);
      const paused = refreshPaused.current === phase.food.id;
      refreshPaused.current = null;
      if (!fresh) {
        scan.current.busy = false;
        setPhase({ kind: 'scanning' });
        return;
      }
      // Back unsaved from an edit that stopped a re-read: the row is still
      // OFF's, so the re-read starts again.
      if (paused) void refreshFromOff(fresh);
      // Unchanged (the common case, and every re-run this effect causes).
      if (fresh.updated_at === phase.food.updated_at) return;
      if (fresh.serving_amount != null) {
        setMode('serving');
        setQty(1);
        setAmountText(fmtQty(fresh.serving_amount));
      } else {
        setMode('amount');
        setAmountText('100');
      }
      // The reading's notes described figures that are no longer these.
      setPhase({ ...phase, food: fresh, label: null, healed: false });
    }, [phase])
  );

  const onScanned = async (raw: string) => {
    const s = scan.current;
    if (s.busy) return; // a resolution is already in flight for this scan
    const code = normalizeBarcode(raw);
    if (code === '') return;
    const now = Date.now();
    // Ignore the same code re-appearing right after we handled it (camera
    // remount / lingering in frame), so it can't silently double-add.
    if (code === s.code && now - s.at < 2500) return;
    s.busy = true;
    s.code = code;
    s.at = now;
    setPhase({ kind: 'resolving', barcode: code });
    // Local cache first — instant, offline.
    const local = findFoodByBarcode(getDb(), code);
    if (local) {
      openPortion(local, false);
      void refreshFromOff(local);
      return;
    }
    // Miss → Open Food Facts (online). A stalled socket must not dead-end the
    // scan, so bound the request and fall into the manual path on timeout.
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
      const off = await lookupOffProduct(code, offFetch, controller.signal);
      if (!off) {
        setPhase({
          kind: 'notfound',
          barcode: code,
          reason: 'Not in Open Food Facts. Add it manually and it’s yours for next time.',
        });
        return;
      }
      // Figures that cannot be PLACED — per serving with no serving to read
      // them against, or dividing past the food itself — are not cached: the
      // reason is said, and the manual form opens with the name OFF did give.
      // Figures that merely disagree are cached and marked doubtful.
      if (off.kind === 'refused') {
        setPhase({
          kind: 'notfound',
          barcode: code,
          reason: off.reason,
          prefill: { name: off.name, brand: off.brand },
        });
        return;
      }
      const cached = cacheBarcodeFood(getDb(), off.food);
      openPortion(cached, true, undefined, off.label);
    } catch (error) {
      const reason =
        error instanceof OffLookupError
          ? 'Couldn’t reach Open Food Facts — you may be offline. Add it manually for now.'
          : 'Something went wrong looking that up. Add it manually for now.';
      setPhase({ kind: 'notfound', barcode: code, reason });
    } finally {
      clearTimeout(timeout);
    }
  };

  /**
   * A code handed over by the merged camera (`app/meal-estimate.tsx`) resolves
   * through the ladder above exactly as a live scan does — same lookup, same
   * cache-back, same portion sheet, same miss path. Once, on mount: the effect
   * has no dependencies because a route param cannot change under a mounted
   * screen, and `onScanned`'s own busy/cooldown guard covers a re-entry anyway.
   */
  const handedOver = useRef(false);
  useEffect(() => {
    if (handedOver.current || handoff === '') return;
    handedOver.current = true;
    void onScanned(handoff);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * Write the portion. `food` is carried through only to NAME the meal when
   * this add is the one that creates it (backlog A4) — a scan used to land as
   * "Snack", which is the clock's answer to a question the barcode had already
   * answered better. `mealNameForProduct` keeps the day part as the fallback
   * for a nameless product, because `meals.name` is NOT NULL.
   *
   * Only at CREATION: adding a second scan to the meal this screen already
   * created leaves the title alone (see the helper's header), and a meal pushed
   * in via `mealId` is someone else's record and is never retitled here.
   *
   * Past his caffeine cut-off before a timed workout (item 72) it asks first;
   * Cancel leaves the portion sheet open, as it was.
   */
  const addItem = (item: NewMealItem, food: FoodRow) =>
    confirmCaffeine([item], () => writeItem(item, food), { into: targetMealId });

  const writeItem = (item: NewMealItem, food: FoodRow) => {
    const db = getDb();
    try {
      if (targetMealId !== null) {
        addMealItem(db, targetMealId, item);
        addedTo.current.set(food.id, targetMealId);
      } else {
        const now = new Date();
        const name = mealNameForProduct(food, daypartName(now));
        const { mealId: created } = logMealWithItems(db, {
          date: todayISODate(),
          time: clockFromISO(now.toISOString()),
          name,
          items: [item],
        });
        // Near a meal already logged, the scan joins it (item 58) and every
        // later scan this visit follows; a meal it did not make is never
        // offered the name field.
        const join = joinNearbyMealWithUndo(db, created);
        setJoined(join);
        setTargetMealId(join ? join.keptId : created);
        setCreatedName(join ? null : name);
        addedTo.current.set(food.id, join ? join.keptId : created);
        joinedFood.current = join ? food.id : null;
      }
      setAdded((n) => n + 1);
      resumeScanning();
    } catch (error) {
      console.warn('[barcode] add failed', error);
      resumeScanning();
    }
  };

  const addPortion = (food: FoodRow) => {
    if (mode === 'serving' && food.serving_amount != null) {
      if (qty <= 0) return;
      addItem(itemForPortion(food, { servingQty: qty }), food);
    } else {
      const amount = parseAmount(amountText);
      if (amount === null) return;
      addItem(itemForPortion(food, { amount }), food);
    }
  };

  /**
   * Write the typed name when it changes anything, through the meal screen's
   * own `updateMealName` (`commitScanMealName`, src/lib/nutrition/
   * scan-meal-name.ts). Runs on Done, when the field stops being edited, and
   * when the screen goes — so a name typed and then left by the back chevron is
   * kept too. The helper compares with the name the DATABASE holds, so Done
   * and the unmount right after it write once, not twice.
   */
  const commitName = () => {
    if (targetMealId === null || createdName === null) return;
    try {
      const written = commitScanMealName(getDb(), targetMealId, nameDraft);
      if (written === null) return;
      setCreatedName(written);
      setNameDraft(null);
    } catch (error) {
      console.warn('[barcode] rename failed', error);
    }
  };
  // The unmount commit reads the LATEST closure, not the first render's.
  const commitNameRef = useRef(commitName);
  useEffect(() => {
    commitNameRef.current = commitName;
  });
  useEffect(() => () => commitNameRef.current(), []);

  /** The join's Undo: the scan goes back into the meal it was logged as, and
   *  this visit carries on in that one. */
  const undoJoin = () => {
    const done = runUndo();
    if (done && joined) {
      setTargetMealId(joined.createdId);
      setCreatedName(joined.createdName);
      // The joined scan's item is back in the meal it made; a late heal of
      // that food names that meal.
      const foodId = joinedFood.current;
      if (foodId !== null && addedTo.current.get(foodId) === joined.keptId) {
        addedTo.current.set(foodId, joined.createdId);
      }
    }
    setJoined(null);
  };

  /** Close the flow back to where it started — see the header. */
  const done = () => {
    commitName();
    router.dismiss(doneDismissCount(via));
  };
  // The name the field holds when it is offered — two foods in a meal this
  // session made (`offersScanMealName`) — else null, and no field.
  const nameable = offersScanMealName(createdName, added) ? createdName : null;

  const amountPreview =
    phase.kind === 'portion'
      ? mode === 'serving'
        ? amountForQty(phase.food, qty)
        : parseAmount(amountText)
      : null;
  const kcalPreview =
    phase.kind === 'portion' && amountPreview != null && phase.food.kcal_100g != null
      ? (phase.food.kcal_100g * amountPreview) / 100
      : null;
  const canAdd = amountPreview != null && amountPreview > 0;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader
          title="Scan barcode"
          // Done, where the eye already is once a food is in. Label voice and
          // no accent, like every header control: it leaves, it does not commit
          // anything Add has not already written.
          action={
            added > 0 ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Done, ${added} added`}
                hitSlop={8}
                onPress={done}
                className="min-h-[44px] justify-center px-1 active:opacity-60">
                <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
                  Done
                </Text>
              </Pressable>
            ) : undefined
          }
        />
      </View>

      {added > 0 ? (
        <Text className="mt-1 font-mono text-[11px] text-ink-muted">
          {added} added{targetMealId ? '' : ' to a new meal'}
        </Text>
      ) : null}
      {joinUndo ? <UndoRow offer={joinUndo} onUndo={undoJoin} first /> : null}
      {/* A heal that landed after an Add of that food: the item keeps the old
          figures (a snapshot, as after any catalog edit), and this says so —
          quiet serif, no accent; the meal is where it is put right. */}
      {staleAdd ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={`Open the meal with ${staleAdd.name}`}
          onPress={() => {
            const { mealId: id } = staleAdd;
            setStaleAdd(null);
            router.push({ pathname: '/meal-detail', params: { id } });
          }}
          className="mt-1.5 min-h-[44px] flex-row items-center gap-3 active:opacity-60">
          <Text className="flex-1 font-serif text-[12px] leading-5 text-ink-muted">
            The {staleAdd.name} just added used its old figures — Open Food Facts has since
            corrected them. Open the meal to fix it.
          </Text>
          <Ionicons name="chevron-forward" size={16} color={palette.inkMuted} />
        </Pressable>
      ) : null}

      {/* Camera / permission — only while actively scanning. */}
      {phase.kind === 'scanning' ? (
        <View>
          {/* The absent module is a SENTENCE, not a spinner: without it
              `permission` never resolves, and "Preparing the camera…" would sit
              there forever. The running list below still works — it is
              database-only — so this screen is not dead on a binary without the
              scanner, and says so. */}
          {!cameraInstalled || Camera === null ? (
            <View className="mt-6">
              <Block device="margin">
                <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
                  Scanning needs the next app build — the camera isn’t in this one yet. Anything
                  below can still be logged.
                </Text>
              </Block>
            </View>
          ) : !permission ? (
            <Text className="mt-6 font-serif text-[14px] text-ink-secondary">
              Preparing the camera…
            </Text>
          ) : !permission.granted ? (
            <View className="mt-6">
              <Text className="font-serif text-[14px] leading-6 text-ink-secondary">
                Barcode scanning needs camera access.
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Allow camera"
                onPress={() => void requestPermission()}
                className="mt-3 min-h-[44px] items-center justify-center rounded-btn bg-pine px-4 active:opacity-70">
                <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
                  Allow camera
                </Text>
              </Pressable>
            </View>
          ) : (
            <View className="mt-4">
              <View className="aspect-square w-full overflow-hidden border border-hairline bg-ink">
                <Camera
                  style={{ flex: 1 }}
                  barcodeScannerSettings={{ barcodeTypes: FOOD_BARCODE_TYPES }}
                  onBarcodeScanned={({ data }) => void onScanned(data)}
                />
              </View>
              {/* "Point at a product barcode." was cut by the owner as
                  explanatory copy on 2026-08-11 — the live viewfinder above says
                  it. What survives is the fact the viewfinder cannot. */}
              <Text className="mt-3 text-center font-serif text-[13px] leading-5 text-ink-muted">
                Found items cache for offline next time.
              </Text>
            </View>
          )}

          {/* THE RUNNING LIST. A ruled plate, because it is a record of what has
              been eaten from a package — the same object as "Eaten today". It
              renders only when there is something in it: a heading over an
              authored empty would be a permanent fixture explaining a feature
              that has not happened yet. */}
          {recents.length > 0 ? (
            <View className="mt-7">
              <SectionLabel label="Recently logged" />
              <View className="mt-2">
                <Block device="plate">
                  {recents.map((recent, index) => (
                    <RecentBarcodeRow
                      key={recent.food.id}
                      recent={recent}
                      first={index === 0}
                      volume={units.volume}
                      onPress={() => {
                        openPortion(recent.food, false, {
                          amount: recent.lastAmount,
                          servingQty: recent.lastServingQty,
                        });
                        void refreshFromOff(recent.food);
                      }}
                    />
                  ))}
                </Block>
              </View>
            </View>
          ) : null}
        </View>
      ) : null}

      {phase.kind === 'resolving' ? (
        <View className="mt-6 flex-row items-center gap-3">
          <ActivityIndicator color={palette.ink} />
          <View>
            <Text className="font-mono text-[13px] text-ink">{phase.barcode}</Text>
            <Text className="mt-1 font-serif text-[13px] text-ink-muted">Looking it up…</Text>
          </View>
        </View>
      ) : null}

      {/* Resolved → the record, with the portion decision drawn inside it. */}
      {phase.kind === 'portion' ? (
        <View className="mt-4">
          <Block device="plate">
            <SectionLabel
              label="Portion"
              note={phase.fromOff ? 'Open Food Facts' : 'Saved earlier'}
            />

            <Text className="mt-2 font-serif text-[15px] leading-5 text-ink">
              {phase.food.name}
              {phase.food.brand ? (
                <Text className="font-serif text-ink-muted"> · {phase.food.brand}</Text>
              ) : null}
            </Text>
            {/* Per 100 and per serving, side by side — and, on a fresh read,
                what had to be done to get them. */}
            <LabelRows food={phase.food} />
            <LabelNotes
              food={phase.food}
              label={phase.label}
              healed={phase.healed === true}
            />

            <View className="mt-3 flex-row items-center gap-2">
              {phase.food.serving_amount != null ? (
                <View className="flex-row items-center gap-1">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Less"
                    hitSlop={6}
                    onPress={() => {
                      const next = Math.min(50, Math.max(0.5, qty - 0.5));
                      setMode('serving');
                      setQty(next);
                      const a = amountForQty(phase.food, next);
                      if (a != null) setAmountText(fmtQty(a));
                    }}
                    className="h-9 w-9 items-center justify-center rounded-btn border border-hairline active:opacity-60">
                    <Ionicons name="remove" size={16} color={palette.ink} />
                  </Pressable>
                  <Text className="w-14 text-center font-mono text-[15px] text-ink">
                    {fmtQty(qty)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="More"
                    hitSlop={6}
                    onPress={() => {
                      const next = Math.min(50, Math.max(0.5, qty + 0.5));
                      setMode('serving');
                      setQty(next);
                      const a = amountForQty(phase.food, next);
                      if (a != null) setAmountText(fmtQty(a));
                    }}
                    className="h-9 w-9 items-center justify-center rounded-btn border border-hairline active:opacity-60">
                    <Ionicons name="add" size={16} color={palette.ink} />
                  </Pressable>
                  <Text className="ml-1 font-label text-[10px] uppercase tracking-[1.2px] text-ink-muted">
                    × {phase.food.serving_name}
                  </Text>
                </View>
              ) : null}
              <View className="ml-auto flex-row items-center gap-2">
                <TextInput
                  value={amountText}
                  onChangeText={(t) => {
                    setMode('amount');
                    setAmountText(t);
                  }}
                  keyboardType="decimal-pad"
                  returnKeyType={KEYPAD_DONE}
                  {...selectAllOnFocus(amountText)}
                  accessibilityLabel={phase.food.basis === 'ml' ? 'Millilitres' : 'Grams'}
                  className="w-16 border border-paper-deep bg-paper-dim px-2 py-2 text-right font-mono text-[13px] text-ink"
                />
                <Text className="font-mono text-[11px] text-ink-secondary">{phase.food.basis}</Text>
              </View>
            </View>

            <View className="mt-3 flex-row items-center justify-between">
              <Text className="font-mono text-[10px] text-ink-muted">
                {kcalPreview != null ? `≈ ${fmtInt(kcalPreview)} kcal` : 'no energy recorded'}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${phase.food.name}`}
                accessibilityState={{ disabled: !canAdd }}
                disabled={!canAdd}
                onPress={() => addPortion(phase.food)}
                className={
                  canAdd
                    ? 'min-h-[44px] justify-center rounded-btn bg-pine px-5 active:opacity-70'
                    : 'min-h-[44px] justify-center rounded-btn border border-paper-deep px-5'
                }>
                <Text
                  className={
                    canAdd
                      ? 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-pine-on'
                      : 'font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink-muted'
                  }>
                  Add
                </Text>
              </Pressable>
            </View>
          </Block>

          <View className="mt-2">
            <Block device="plate">
              <ScanRow
                icon="barcode-outline"
                label="Scan another"
                accessibilityLabel="Scan another"
                onPress={resumeScanning}
              />
              {/* The catalog entry itself — how figures cached wrong are put
                  right. Meals already logged keep their own numbers. */}
              <Divider first={false} />
              <ScanRow
                icon="create-outline"
                label="Edit this food"
                accessibilityLabel={`Edit ${phase.food.name} in the catalog`}
                onPress={() => editFood(phase.food)}
              />
            </Block>
          </View>
        </View>
      ) : null}

      {/* Miss → manual fallback. */}
      {phase.kind === 'notfound' ? (
        <View className="mt-6">
          <Block device="margin">
            <Text className="font-mono text-[13px] text-ink">{phase.barcode}</Text>
            <Text className="mt-1 font-serif text-[14px] leading-6 text-ink-secondary">
              {phase.reason}
            </Text>
          </Block>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add this food manually"
            onPress={() =>
              router.replace({
                pathname: '/food-new',
                params: {
                  barcode: phase.barcode,
                  ...(phase.prefill ? { name: phase.prefill.name } : {}),
                  ...(phase.prefill?.brand ? { brand: phase.prefill.brand } : {}),
                },
              })
            }
            className="mt-4 min-h-[44px] items-center justify-center rounded-btn bg-pine px-4 active:opacity-70">
            <Text className="font-label text-[13px] font-semibold uppercase tracking-[1.2px] text-pine-on">
              Add manually
            </Text>
          </Pressable>

          <View className="mt-2">
            <Block device="plate">
              <ScanRow
                icon="barcode-outline"
                label="Scan another"
                accessibilityLabel="Scan another"
                onPress={resumeScanning}
              />
            </Block>
          </View>
        </View>
      ) : null}

      {/* Two foods in a meal this session made: it can be named before it is
          left. Prefilled with the name it has; nothing waits on it. */}
      {nameable !== null ? (
        <SessionMealName
          value={nameDraft ?? nameable}
          current={nameable}
          count={added}
          onChange={setNameDraft}
          onCommit={commitName}
        />
      ) : null}
    </Screen>
  );
}
