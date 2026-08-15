import Ionicons from '@expo/vector-icons/Ionicons';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useEffect, useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Block, Divider } from '@/components/ui/block';
import { Screen } from '@/components/ui/screen';
import { SectionLabel } from '@/components/ui/section-label';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import {
  cacheBarcodeFood,
  findFoodByBarcode,
  listRecentBarcodeFoods,
} from '@/lib/db/repositories/foods';
import { addMealItem, logMealWithItems } from '@/lib/db/repositories/nutrition';
import {
  ArcCameraView,
  FOOD_BARCODE_TYPES,
  isCameraAvailable,
  useCameraPermission,
} from '@/lib/media/camera';
import { fmtInt, fmtQty } from '@/lib/nutrition/format';
import { lookupOffProduct, normalizeBarcode, OffLookupError } from '@/lib/nutrition/openfoodfacts';
import { gramsForQty, itemForPortion } from '@/lib/nutrition/servings';
import type { FoodRow, NewMealItem, RecentFood } from '@/lib/nutrition/types';

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
 * module is then an app-LAUNCH crash. Absence is drawn in words here; the
 * scanner needs the pending EAS build. Pushed with an optional `mealId` (add to
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
 * is the same editor. Only its grams input takes the recessed treatment, because
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
 */

type Phase =
  | { kind: 'scanning' }
  | { kind: 'resolving'; barcode: string }
  | { kind: 'portion'; food: FoodRow; fromOff: boolean }
  | { kind: 'notfound'; barcode: string; reason: string };

function daypartName(now: Date): string {
  const h = now.getHours();
  if (h < 11) return 'Breakfast';
  if (h < 16) return 'Lunch';
  if (h < 21) return 'Dinner';
  return 'Snack';
}

function parseGrams(text: string): number | null {
  const g = Number(text.trim());
  return Number.isFinite(g) && g > 0 && g <= 5000 ? g : null;
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
 * It is the plate's only row today, so it draws no `border-t` — a hairline
 * between rows needs a row above it. The `first` flag the sweep deleted is not
 * reinstated: a second row would state its own rule at the call site rather
 * than inherit a boolean.
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
  onPress,
}: {
  recent: RecentFood;
  first: boolean;
  onPress: () => void;
}) {
  const { food, lastGrams, lastServingQty } = recent;
  const portion =
    lastServingQty != null && food.serving_name
      ? `${fmtQty(lastServingQty)} × ${food.serving_name}`
      : lastGrams != null
        ? `${fmtQty(lastGrams)} g`
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

export default function BarcodeScanScreen() {
  const router = useRouter();
  const { mealId, code: incomingCode } = useLocalSearchParams<{
    mealId?: string;
    code?: string;
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
  const [targetMealId, setTargetMealId] = useState<string | null>(mealId ?? null);
  // Portion editor state (mirrors food search's).
  const [mode, setMode] = useState<'serving' | 'grams'>('grams');
  const [qty, setQty] = useState(1);
  const [gramsText, setGramsText] = useState('100');
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
    last?: { grams: number | null; servingQty: number | null }
  ) => {
    if (last?.servingQty != null && food.serving_grams != null) {
      setMode('serving');
      setQty(last.servingQty);
      setGramsText(fmtQty(gramsForQty(food, last.servingQty) ?? food.serving_grams));
    } else if (last?.grams != null) {
      setMode('grams');
      setGramsText(fmtQty(last.grams));
    } else if (food.serving_grams != null) {
      setMode('serving');
      setQty(1);
      setGramsText(fmtQty(food.serving_grams));
    } else {
      setMode('grams');
      setGramsText('100');
    }
    setPhase({ kind: 'portion', food, fromOff });
  };

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
    if (local) return openPortion(local, false);
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
      const cached = cacheBarcodeFood(getDb(), off);
      openPortion(cached, true);
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

  const addItem = (item: NewMealItem) => {
    const db = getDb();
    try {
      if (targetMealId !== null) {
        addMealItem(db, targetMealId, item);
      } else {
        const now = new Date();
        const { mealId: created } = logMealWithItems(db, {
          date: todayISODate(),
          time: clockFromISO(now.toISOString()),
          name: daypartName(now),
          items: [item],
        });
        setTargetMealId(created);
      }
      setAdded((n) => n + 1);
      resumeScanning();
    } catch (error) {
      console.warn('[barcode] add failed', error);
      resumeScanning();
    }
  };

  const addPortion = (food: FoodRow) => {
    if (mode === 'serving' && food.serving_grams != null) {
      if (qty <= 0) return;
      addItem(itemForPortion(food, { servingQty: qty }));
    } else {
      const grams = parseGrams(gramsText);
      if (grams === null) return;
      addItem(itemForPortion(food, { grams }));
    }
  };

  const gramsPreview =
    phase.kind === 'portion'
      ? mode === 'serving'
        ? gramsForQty(phase.food, qty)
        : parseGrams(gramsText)
      : null;
  const kcalPreview =
    phase.kind === 'portion' && gramsPreview != null && phase.food.kcal_100g != null
      ? (phase.food.kcal_100g * gramsPreview) / 100
      : null;
  const canAdd = gramsPreview != null && gramsPreview > 0;

  return (
    <Screen scroll>
      <View className="pt-2">
        <StackHeader title="Scan barcode" />
      </View>

      {added > 0 ? (
        <Text className="mt-1 font-mono text-[11px] text-ink-muted">
          {added} added{targetMealId ? '' : ' to a new meal'}
        </Text>
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
                      onPress={() =>
                        openPortion(recent.food, false, {
                          grams: recent.lastGrams,
                          servingQty: recent.lastServingQty,
                        })
                      }
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
            <Text className="mt-0.5 font-mono text-[10px] text-ink-muted">
              {phase.food.kcal_100g != null
                ? `${fmtInt(phase.food.kcal_100g)} kcal / 100 g`
                : 'no energy recorded'}
            </Text>

            <View className="mt-3 flex-row items-center gap-2">
              {phase.food.serving_grams != null ? (
                <View className="flex-row items-center gap-1">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Less"
                    hitSlop={6}
                    onPress={() => {
                      const next = Math.min(50, Math.max(0.5, qty - 0.5));
                      setMode('serving');
                      setQty(next);
                      const g = gramsForQty(phase.food, next);
                      if (g != null) setGramsText(fmtQty(g));
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
                      const g = gramsForQty(phase.food, next);
                      if (g != null) setGramsText(fmtQty(g));
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
                  value={gramsText}
                  onChangeText={(t) => {
                    setMode('grams');
                    setGramsText(t);
                  }}
                  keyboardType="decimal-pad"
                  accessibilityLabel="Grams"
                  className="w-16 border border-paper-deep bg-paper-dim px-2 py-2 text-right font-mono text-[13px] text-ink"
                />
                <Text className="font-mono text-[11px] text-ink-secondary">g</Text>
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
              router.replace({ pathname: '/food-new', params: { barcode: phase.barcode } })
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

      {added > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={() => router.back()}
          className="mt-6 min-h-[44px] items-center justify-center active:opacity-60">
          <Text className="font-label text-[12px] font-semibold uppercase tracking-[1.2px] text-ink">
            Done
          </Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}
