import Ionicons from '@expo/vector-icons/Ionicons';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { useRef, useState } from 'react';
import { ActivityIndicator, Pressable, Text, TextInput, View } from 'react-native';

import { Screen } from '@/components/ui/screen';
import { StackHeader } from '@/components/ui/stack-header';
import { palette } from '@/constants/theme';
import { getDb } from '@/lib/db/client';
import { clockFromISO, todayISODate } from '@/lib/db/date';
import { cacheBarcodeFood, findFoodByBarcode } from '@/lib/db/repositories/foods';
import { addMealItem, logMealWithItems } from '@/lib/db/repositories/nutrition';
import { fmtInt, fmtQty } from '@/lib/nutrition/format';
import { lookupOffProduct, normalizeBarcode, OffLookupError } from '@/lib/nutrition/openfoodfacts';
import { gramsForQty, itemForPortion } from '@/lib/nutrition/servings';
import type { FoodRow, NewMealItem } from '@/lib/nutrition/types';

/**
 * Barcode scanning (docs/nutrition-subapp.md §7) — the one online-except-AI
 * path. A scan resolves LOCALLY first (findFoodByBarcode over the grown cache),
 * then Open Food Facts when the local cache misses; every OFF hit is cached
 * into `foods` (source='openfoodfacts'), so the pantry converges to offline
 * scanning. A miss (offline or not-in-OFF) falls back to manual entry.
 *
 * NATIVE DEP: expo-camera → the app must be rebuilt (EAS) before this runs on
 * device. Pushed with an optional `mealId` (add to that meal) or from Nutrition
 * (creates a day-part meal on the first add, like food search).
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

export default function BarcodeScanScreen() {
  const router = useRouter();
  const { mealId } = useLocalSearchParams<{ mealId?: string }>();
  const [permission, requestPermission] = useCameraPermissions();

  const [phase, setPhase] = useState<Phase>({ kind: 'scanning' });
  const [added, setAdded] = useState(0);
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

  const openPortion = (food: FoodRow, fromOff: boolean) => {
    if (food.serving_grams != null) {
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
        !permission ? (
          <Text className="mt-6 text-[13px] text-ink-muted">Preparing the camera…</Text>
        ) : !permission.granted ? (
          <View className="mt-6">
            <Text className="text-[13px] leading-5 text-ink-secondary">
              Barcode scanning needs camera access.
            </Text>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Allow camera"
              onPress={requestPermission}
              className="mt-3 flex-row items-center justify-center rounded-btn bg-pine px-4 py-3 active:opacity-70">
              <Text className="text-[14px] font-semibold text-pine-on">Allow camera</Text>
            </Pressable>
          </View>
        ) : (
          <View className="mt-4">
            <View className="aspect-square w-full overflow-hidden rounded-card border border-hairline bg-ink">
              <CameraView
                style={{ flex: 1 }}
                barcodeScannerSettings={{
                  barcodeTypes: ['ean13', 'ean8', 'upc_a', 'upc_e', 'code128'],
                }}
                onBarcodeScanned={({ data }) => void onScanned(data)}
              />
            </View>
            <Text className="mt-3 text-center text-xs text-ink-muted">
              Point at a product barcode. Found items cache for offline next time.
            </Text>
          </View>
        )
      ) : null}

      {phase.kind === 'resolving' ? (
        <View className="mt-6 flex-row items-center gap-3">
          <ActivityIndicator color={palette.pine} />
          <View>
            <Text className="font-mono text-[13px] text-ink">{phase.barcode}</Text>
            <Text className="mt-1 text-[13px] text-ink-muted">Looking it up…</Text>
          </View>
        </View>
      ) : null}

      {/* Resolved → portion sheet. */}
      {phase.kind === 'portion' ? (
        <View className="mt-4">
          <View className="rounded-card border border-hairline bg-porcelain p-4">
            <Text className="text-[15px] text-ink">
              {phase.food.name}
              {phase.food.brand ? (
                <Text className="text-ink-muted"> · {phase.food.brand}</Text>
              ) : null}
            </Text>
            <Text className="mt-0.5 font-mono text-[11px] text-ink-muted">
              {phase.food.kcal_100g != null
                ? `${fmtInt(phase.food.kcal_100g)} kcal / 100 g`
                : 'no energy recorded'}
              {phase.fromOff ? ' · Open Food Facts' : ' · saved earlier'}
            </Text>

            <View className="mt-3 flex-row items-center gap-2">
              {phase.food.serving_grams != null ? (
                <View className="flex-row items-center gap-1">
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="Less"
                    onPress={() => {
                      const next = Math.min(50, Math.max(0.5, qty - 0.5));
                      setMode('serving');
                      setQty(next);
                      const g = gramsForQty(phase.food, next);
                      if (g != null) setGramsText(fmtQty(g));
                    }}
                    className="h-9 w-9 items-center justify-center rounded-btn border border-hairline-strong active:bg-paper-deep">
                    <Ionicons name="remove" size={16} color={palette.ink} />
                  </Pressable>
                  <Text className="w-14 text-center font-mono text-[15px] text-ink">
                    {fmtQty(qty)}
                  </Text>
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel="More"
                    onPress={() => {
                      const next = Math.min(50, Math.max(0.5, qty + 0.5));
                      setMode('serving');
                      setQty(next);
                      const g = gramsForQty(phase.food, next);
                      if (g != null) setGramsText(fmtQty(g));
                    }}
                    className="h-9 w-9 items-center justify-center rounded-btn border border-hairline-strong active:bg-paper-deep">
                    <Ionicons name="add" size={16} color={palette.ink} />
                  </Pressable>
                  <Text className="ml-1 text-xs text-ink-secondary">
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
                  className="w-16 rounded-btn border border-hairline-soft bg-paper-deep px-2 py-2 text-right font-mono text-[13px] text-ink"
                />
                <Text className="text-xs text-ink-secondary">g</Text>
              </View>
            </View>

            <View className="mt-3 flex-row items-center justify-between">
              <Text className="font-mono text-[11px] text-ink-muted">
                {kcalPreview != null ? `≈ ${fmtInt(kcalPreview)} kcal` : 'no energy recorded'}
              </Text>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={`Add ${phase.food.name}`}
                disabled={gramsPreview == null || gramsPreview <= 0}
                onPress={() => addPortion(phase.food)}
                className={`rounded-btn px-4 py-2 ${
                  gramsPreview != null && gramsPreview > 0
                    ? 'bg-pine active:opacity-70'
                    : 'bg-hairline'
                }`}>
                <Text
                  className={`text-[13px] font-semibold ${
                    gramsPreview != null && gramsPreview > 0 ? 'text-pine-on' : 'text-ink-muted'
                  }`}>
                  Add
                </Text>
              </Pressable>
            </View>
          </View>

          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan another"
            onPress={resumeScanning}
            className="mt-2 flex-row items-center justify-center gap-2 rounded-card border border-hairline bg-porcelain px-4 py-3 active:bg-paper-deep">
            <Ionicons name="barcode-outline" size={17} color={palette.inkSecondary} />
            <Text className="text-[13px] text-ink">Scan another</Text>
          </Pressable>
        </View>
      ) : null}

      {/* Miss → manual fallback. */}
      {phase.kind === 'notfound' ? (
        <View className="mt-6">
          <Text className="font-mono text-[13px] text-ink">{phase.barcode}</Text>
          <Text className="mt-1 text-[13px] leading-5 text-ink-muted">{phase.reason}</Text>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Add this food manually"
            onPress={() =>
              router.replace({ pathname: '/food-new', params: { barcode: phase.barcode } })
            }
            className="mt-4 flex-row items-center justify-center rounded-btn bg-pine px-4 py-3 active:opacity-70">
            <Text className="text-[14px] font-semibold text-pine-on">Add manually</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Scan another"
            onPress={resumeScanning}
            className="mt-2 flex-row items-center justify-center gap-2 rounded-card border border-hairline bg-porcelain px-4 py-3 active:bg-paper-deep">
            <Ionicons name="barcode-outline" size={17} color={palette.inkSecondary} />
            <Text className="text-[13px] text-ink">Scan another</Text>
          </Pressable>
        </View>
      ) : null}

      {added > 0 ? (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Done"
          onPress={() => router.back()}
          className="mt-6 items-center py-2 active:opacity-60">
          <Text className="text-[13px] font-semibold text-ink">Done</Text>
        </Pressable>
      ) : null}
    </Screen>
  );
}
