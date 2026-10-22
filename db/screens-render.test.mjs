/**
 * Headless RENDER test of ARC's screens — the real .tsx components rendered to
 * HTML via react-native-web + react-dom/server, over a node:sqlite database
 * running the REAL migrations. Every synchronous DB read a screen does in its
 * `useState` initializers executes for real; a crash in any component body
 * fails the suite; key content is asserted in the rendered output.
 *
 * It began as the recipes/grocery walk and has widened with each build that
 * added a screen — the nutrition hub and meal-detail, the progress photos, the
 * knowledge base, the reports, the protocol sub-app, Home, and (2026-09-19)
 * **app/mission-day.tsx**, the mission on a day other than today. For that
 * screen this is the only headless gate there is: it computes a FUTURE day's
 * plan in a `useState` initializer, which this suite executes for real.
 *
 * What this deliberately is NOT: a look/feel or interaction verdict — effects
 * don't run in a server render, and taps can't be simulated here. Device
 * verification stays the on-device checklist in docs/recipes-grocery.md §10
 * (memory: verify on device, not web).
 *
 * Run: npm run db:test (via node --import ./db/register-render-hooks.mjs).
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';

import React from 'react';
import { renderToString } from 'react-dom/server';

import { selectAllOnFocus } from '../src/components/ui/select-on-focus.ts';
import { snoozeItem, unsnoozeItem } from '../src/lib/home/snooze-store.ts';
import { isoWeekday } from '../src/lib/protocols/cadence.ts';

import { __router, __setParams, __setRootState, __setRoute } from './render-stubs/expo-router.mjs';
import { SessionBar, TabSessionBar } from '../src/components/exercise/session-bar.tsx';
import { readOpenLiveSession, sessionBarView } from '../src/lib/exercise/session-bar.ts';
import { getDb } from './render-stubs/db-client.mjs';

import { clockFromISO, shiftISODate, todayISODate } from '../src/lib/db/date.ts';
import { dayPhrase } from '../src/lib/utils/day-cursor.ts';
import { estimateServings } from '../src/lib/recipes/servings.ts';
import { createFood, setFoodFavorite } from '../src/lib/db/repositories/foods.ts';

import {
  getMeal,
  listMealItems,
  logMeal,
  logMealWithItems,
  setNutritionTargets,
  updateMealName,
} from '../src/lib/db/repositories/nutrition.ts';
import { assembleMealItems } from '../src/lib/nutrition/composite.ts';
import {
  createFolder,
  createRecipe,
  listIngredients,
  moveRecipeToFolder,
  resolveIngredient,
  setIngredientNegligible,
  setRecipeFavorite,
} from '../src/lib/db/repositories/recipes.ts';
import {
  markPendingEstimateFailed,
  pendingEstimateForMeal,
  placeholderMealName,
  queueNewMealEstimate,
} from '../src/lib/db/repositories/pending-estimates.ts';
import { composeLastError } from '../src/lib/nutrition/queue-status.ts';
// Track 0 (2026-10-21): the spend ledger's screen, and its store.
import SettingsCoachUsageScreen from '../app/settings-coach-usage.tsx';
import * as spendStore from '../src/lib/ai/spend-store.ts';
import * as usageStore from '../src/lib/ai/usage-policy-store.ts';
import {
  addGroceryItems,
  checkGroceryItem,
  setStaple,
} from '../src/lib/db/repositories/grocery.ts';

import { deleteWorkout, logWorkout } from '../src/lib/db/repositories/exercise.ts';
import {
  clearOwnLiveDraft,
  clearWorkoutDraft,
  readWorkoutDraft,
  saveWorkoutDraft,
} from '../src/lib/db/repositories/workout-drafts.ts';
import { DRAFT_VERSION, liveStartFor, parseLiveDraft } from '../src/lib/exercise/draft.ts';
import { workingSets } from '../src/lib/db/repositories/training-stats.ts';
import { TREND_RANGE_WORDS, TREND_RANGES, trendView } from '../src/lib/exercise/records.ts';
import { DEFAULT_UNIT_PREFERENCES } from '../src/lib/user/types.ts';
import { importProgressPhotos } from '../src/lib/media/progress-photo-store.ts';
import {
  addVersion,
  createProtocolWithVersion,
  deleteProtocol,
} from '../src/lib/db/repositories/protocols.ts';
import {
  generateMissionForDay,
  rederiveMissionForDay,
} from '../src/lib/db/repositories/mission-generate.ts';
import { setMissionStatus } from '../src/lib/db/repositories/mission.ts';
import { clearMuscleAnchor, setMuscleAnchor } from '../src/lib/db/repositories/muscle-anchors.ts';
import {
  deleteSyncStateValue,
  GARMIN_SYNC_KEY,
  setSyncStateValue,
  upsertWearableRows,
} from '../src/lib/db/repositories/wearables.ts';

import { ingestCorpus } from '../src/lib/rag/corpus.ts';
import { saveKnowledgeEntry } from '../src/lib/db/repositories/knowledge.ts';
import { forgetMemory, rememberFact } from '../src/lib/db/repositories/coach-memory.ts';

import ExerciseScreen from '../app/exercise.tsx';
import MissionHistoryScreen from '../app/mission-history.tsx';
import WaterScreen from '../app/water.tsx';
import MuscleFreshnessScreen from '../app/muscle-freshness.tsx';
import ExerciseDetailScreen, { TrendField } from '../app/exercise-detail.tsx';
import { listExercises, setExerciseLoadBasis } from '../src/lib/db/repositories/exercise-catalog.ts';
import RoutineEditScreen, { RoutineLinesSection } from '../app/routine-edit.tsx';
import { ExerciseOrder, ReorderToggle } from '../src/components/exercise/exercise-order.tsx';
import { createRoutine, deleteRoutine, getRoutine } from '../src/lib/db/repositories/routines.ts';
import {
  openRoutineList,
  routineListReducer,
  showsOrder,
} from '../src/lib/exercise/routine-lines.ts';
// The two set grids. They joined the walk with the stopwatch clock field
// (2026-09-23): workout-live needed a Reanimated stub and both needed
// `useNavigation` from the expo-router stub — see db/render-hook.mjs.
import WorkoutLiveScreen, {
  blankSet,
  ExerciseBlock,
  leaveLiveLogger,
} from '../app/workout-live.tsx';
import { AiAddDoor, BrowseCatalog } from '../src/components/exercise/exercise-picker.tsx';
import { UndoRow } from '../src/components/nutrition/undo-row.tsx';
import { lbToKg, weightSpec } from '../src/lib/exercise/format.ts';
import { aiDoorCopy } from '../src/lib/exercise/match.ts';
import { setHint, setRemovalWords, removeSetWithUndo } from '../src/lib/exercise/set-hints.ts';
import WorkoutLogScreen from '../app/workout-log.tsx';
import RecipesScreen from '../app/recipes.tsx';
import RecipeDetailScreen from '../app/recipe-detail.tsx';
import RecipeEditScreen from '../app/recipe-edit.tsx';
import RecipeImportScreen, { ReviewDraft } from '../app/recipe-import.tsx';
import RecipeFoldersScreen from '../app/recipe-folders.tsx';
import RecipeReviseScreen from '../app/recipe-revise.tsx';
import GroceryScreen from '../app/grocery.tsx';
import NutritionScreen, { MACRO_BAR_FILL, MACRO_BAR_OVER } from '../app/nutrition.tsx';
import { OVERFLOW_CAP } from '../src/lib/nutrition/bar.ts';
// Items 95/84 (2026-10-21) — the intake-by-hour fold, the weight record and
// the recovery trends, all drawn from src/components/ui/chart.tsx.
import { IntakeByHour } from '../src/components/nutrition/intake-pace.tsx';
import { defaultCurve, learnCurve } from '../src/lib/nutrition/pace-curve.ts';
import { palette } from '../src/constants/theme.ts';
import WeightScreen from '../app/weight.tsx';
import NutritionMicrosScreen from '../app/nutrition-micros.tsx';
import NutritionHistoryScreen from '../app/nutrition-history.tsx';
import MealDetailScreen, { DishAmountRow } from '../app/meal-detail.tsx';
import MealReviseScreen, { AsLoggedPlate } from '../app/meal-revise.tsx';
import LabImportScreen from '../app/lab-import.tsx';
import { QuestionsPlate, ReviewItemsPlate } from '../src/components/nutrition/estimate-review.tsx';
// The two camera screens. They could not be imported here until `expo-camera`
// moved behind the guarded seam (src/lib/media/camera.ts) — a static native
// import is a resolve failure under node, not a render failure.
import BarcodeScanScreen, {
  doneDismissCount,
  LabelNotes,
  LabelRows,
} from '../app/barcode-scan.tsx';
import { SessionMealName } from '../src/components/nutrition/session-meal-name.tsx';
import { CombineFooter } from '../src/components/nutrition/combine-meals.tsx';
import { planCombine } from '../src/lib/nutrition/combine.ts';
import { closeUndo, currentUndo, offerUndo, runUndo } from '../src/lib/nutrition/undo-store.ts';
import MealEstimateScreen from '../app/meal-estimate.tsx';
import FoodNewScreen from '../app/food-new.tsx';
import FoodSearchScreen, { PortionEditor } from '../app/food-search.tsx';
import { foodDeleteConsequence } from '../src/lib/nutrition/food-delete.ts';
import {
  getCapture,
  listEntriesOn,
  logCapture,
  logMetric,
  logNote,
} from '../src/lib/db/repositories/logs.ts';
import { logSymptom } from '../src/lib/db/repositories/symptoms.ts';
import { CaptureEditor } from '../src/components/log/capture-editor.tsx';
import { RecentLogs } from '../src/components/log/recent-logs.tsx';
import { apiKeyStore } from '../src/lib/ai/api-key-store.ts';
import ProgressPhotosScreen from '../app/progress-photos.tsx';
import ProgressPhotoAddScreen from '../app/progress-photo-add.tsx';
import ProgressPhotoDetailScreen from '../app/progress-photo-detail.tsx';
import ProgressPhotoCompareScreen from '../app/progress-photo-compare.tsx';
import KnowledgeScreen from '../app/knowledge.tsx';
import KnowledgeEntryScreen from '../app/knowledge-entry.tsx';
import KnowledgeEntryEditScreen from '../app/knowledge-entry-edit.tsx';
import KnowledgeImportScreen from '../app/knowledge-import.tsx';
import CoachMemoryScreen from '../app/coach-memory.tsx';
import ReportsScreen from '../app/reports.tsx';
import ReportViewScreen from '../app/report-view.tsx';
import ProtocolsScreen from '../app/protocols.tsx';
import ProtocolDetailScreen from '../app/protocol-detail.tsx';
import ProtocolEditScreen from '../app/protocol-edit.tsx';
import ProtocolVersionsScreen from '../app/protocol-versions.tsx';
import MissionItemScreen from '../app/mission-item.tsx';
import MissionDayScreen from '../app/mission-day.tsx';
import { TimeControl } from '../src/components/protocols/time-control.tsx';
import { ArcTimePicker, isTimeWheelAvailable } from '../src/lib/ui/date-time-picker.ts';
import { MissionItemRow } from '../src/components/home/mission-item.tsx';
import DataScreen from '../app/(tabs)/data.tsx';
import HomeScreen from '../app/(tabs)/index.tsx';
import { MetricsGrid } from '../src/components/home/metrics-strip.tsx';
import WearablesScreen from '../app/wearables.tsx';
import {
  DrinksPanel,
  StatusControl,
  StatusFacts,
} from '../src/components/status/status-control.tsx';
import { StatusRail } from '../src/components/status/status-rail.tsx';
import { ReadinessStrip } from '../src/components/home/readiness-strip.tsx';
import { openStatuses, startStatus } from '../src/lib/db/repositories/statuses.ts';
import { endPromptFor, STATUS_CHIPS } from '../src/lib/status/chips.ts';
import { shortDate } from '../src/lib/experiments/format.ts';
// §41 — the experiment readout on the detail screen.
import ExperimentDetailScreen from '../app/experiment-detail.tsx';
import { completeExperiment, createExperiment } from '../src/lib/db/repositories/experiments.ts';
import { toolByName } from '../src/lib/ai/tools/index.ts';
import LogScreen from '../app/(tabs)/log.tsx';

import { deleteWaterEntry, logWater } from '../src/lib/db/repositories/water.ts';
import { metricByKey, resolveDisplay } from '../src/lib/log/metrics.ts';
import {
  getPreferences,
  setHealthSyncEnabled,
  setUnitPreference,
  setWaterTarget,
} from '../src/lib/db/repositories/user.ts';
import { setHealthSyncLog } from '../src/lib/db/repositories/wearables.ts';
import SettingsHealthScreen from '../app/settings-health.tsx';
import SettingsScreenTimeScreen from '../app/settings-screen-time.tsx';
import MetricEntryScreen from '../app/metric-entry.tsx';
import ScreenTimeLinkScreen from '../app/log/screen-time.tsx';
import {
  markReceiptSeen,
  recordScreenTime,
  undoScreenTime,
} from '../src/lib/db/repositories/screen-time.ts';
import { defaultScreenTimeDay, screenTimeDate } from '../src/lib/screen-time/entry.ts';
import {
  forgetTypedScreenTime,
  noteTypedScreenTime,
} from '../src/lib/screen-time/receipt-store.ts';
import { weekdayDate } from '../src/lib/protocols/format.ts';
// 0064 — Coach notifications: the Coach tab's two new pieces, rendered in
// isolation (the tab itself stays off the walk — see the status-control note),
// and Settings › Coach, which gained a Notifications section.
import SettingsCoachScreen from '../app/settings-coach.tsx';
import SettingsGarminScreen from '../app/settings-garmin.tsx';
import { garminKeyStore } from '../src/lib/garmin/key-store.ts';
import { NudgesCard } from '../src/components/coach/nudges-card.tsx';
import { RemindersCard } from '../src/components/coach/reminders-card.tsx';
import { CheckinLine, checkinNote } from '../src/components/coach/checkin-line.tsx';
import { saveNudgeSettings } from '../src/lib/db/repositories/coach-nudges.ts';
import { WaterPublishPointer } from '../src/components/water/publish-pointer.tsx';
import { WATER_REFUSED_LINE, WATER_UNASKED_LINE } from '../src/lib/health/publish.ts';
import { insertReport } from '../src/lib/db/repositories/reports.ts';
import { assembleSelfReview } from '../src/lib/reports/assemble-self-review.ts';
import { periodFromBounds } from '../src/lib/reports/period.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};

/**
 * **Every number pad on the screen has a way out.**
 *
 * iOS number pads have no return key, so a `TextInput` whose `keyboardType` is
 * `number-pad` / `decimal-pad` / `numeric` traps the keyboard unless
 * `returnKeyType` is set — that prop is the whole trigger for the native Done
 * toolbar RN builds over those keyboards (the mechanism, and why it looks like
 * dead code at a call site, is documented in src/components/ui/keyboard.ts).
 * The owner hit this on the water goal: *"you cant close the keyboard so its
 * impossible to actually put a number in."*
 *
 * react-native-web translates the pair faithfully — `keyboardType` becomes
 * `inputMode="numeric"|"decimal"` and `returnKeyType` becomes `enterKeyHint` —
 * so the rule is checkable in the rendered markup, on every screen this suite
 * walks, without naming any of them. `numbers-and-punctuation` and `url` fields
 * emit no `inputMode` and are correctly ignored: those keyboards have a return
 * key already.
 *
 * What it CANNOT establish: that the toolbar actually appears, or that the field
 * is visible while you type (that half is the scroll container's keyboard inset
 * — {@link Screen}). Both are device facts. Nor does it see a field behind an
 * interaction: the water goal editor and the per-entry editor only mount after a
 * tap, so what is proved here for app/water.tsx is the Add field.
 */
function findKeypads(html) {
  const all = (html.match(/<input[^>]*>/g) || []).filter((tag) =>
    /inputMode="(numeric|decimal)"/.test(tag)
  );
  return { all, stuck: all.filter((tag) => !tag.includes('enterKeyHint=')) };
}

/** How many number pads the whole walk has seen — so a silently vacuous check
 *  (a regex that stopped matching anything at all) fails at the end. */
let keypadsSeen = 0;

function keypadsDismissable(name, html) {
  const { all, stuck } = findKeypads(html);
  if (all.length === 0) return;
  keypadsSeen += all.length;
  stuck.length === 0
    ? ok(`${name}: all ${all.length} number pad(s) can be dismissed`)
    : bad(
        `${name}: ${stuck.length} of ${all.length} number pad(s) have no Done key`,
        stuck[0].slice(0, 140)
      );
}

/** Render a screen to HTML; a throw anywhere in the tree is a failure. */
function render(name, Component, params = {}, props = {}) {
  __setParams(params);
  try {
    const html = renderToString(React.createElement(Component, props));
    keypadsDismissable(name, html);
    return html;
  } catch (e) {
    bad(`${name} rendered`, e instanceof Error ? e.message : String(e));
    return null;
  }
}

/** The negative of expect: these strings must NOT be on the screen. Used where
 *  the absence IS the behaviour — a remainder the day cannot support, a setup
 *  affordance that has retired. */
function refute(name, html, substrings) {
  if (html === null) return;
  for (const sub of substrings) {
    if (html.includes(sub)) bad(`${name} must NOT show "${sub}"`);
    else ok(`${name} does not show "${sub}"`);
  }
}

/**
 * The body figure actually DREW — the check that came in with the SVG rewrite
 * (2026-08-25), when the figure stopped being `View`s and became `<Path>`
 * elements with gradient fills.
 *
 * The render stub maps every react-native-svg element to its real DOM tag, so a
 * server render emits genuine markup and three silent failures become visible
 * here: a figure that mounted no paths at all, a `url(#…)` fill pointing at a
 * gradient id that is not in the document (which paints the muscle BLACK on
 * iOS and nothing at all on web), and a NaN in any coordinate — all of which a
 * text assertion walks straight past.
 *
 * It says nothing about how the drawing LOOKS. That stays db/figure-preview.mjs
 * and the device (memory: verify on device, not web).
 */
function figureDrew(name, html) {
  if (html === null) return;
  const paths = (html.match(/<path/g) || []).length;
  const ids = new Set([...html.matchAll(/id="([^"]+)"/g)].map((m) => m[1]));
  const refs = [...html.matchAll(/url\(#([^)]+)\)/g)].map((m) => m[1]);
  const dangling = refs.filter((r) => !ids.has(r));
  paths >= 100
    ? ok(`${name}: the figure pair drew ${paths} paths`)
    : bad(`${name}: figure drew only ${paths} paths`);
  refs.length > 0 && dangling.length === 0
    ? ok(`${name}: all ${refs.length} gradient references resolve inside the document`)
    : bad(`${name}: dangling gradient refs`, dangling.join(' ') || 'no gradients at all');
  html.includes('NaN')
    ? bad(`${name}: NaN in the rendered markup`)
    : ok(`${name}: no NaN reached the path data`);
}

/**
 * The macro bars, read out of the markup — one record per bar, in document
 * order.
 *
 * NativeWind's className is a babel transform that does not run here, so colour
 * is invisible in a server render — every view in a bar comes out as the same
 * class-less `<div>`. What IS visible is everything the bar computes, because it
 * rides inline `style` and `testID`:
 *
 *   level       the grade, off the bar's own `data-testid` (FB2);
 *   pct         the fill's `width:N%` — a share of the RAIL, which is the
 *               target, so it tops out at 100;
 *   terminator  whether the rail holds a second child after the fill — one-to-
 *               one with `met`, which is exactly when the fill reaches 100%;
 *   over        the run past the mark (FB3), as a share of the RAIL's length.
 *               The run's own `width` is a share of the room past the mark, and
 *               the room is `OVERFLOW_CAP` of the rail, so it converts back
 *               exactly. `null` when no run is drawn;
 *   cap         whether the run carries the `+`.
 *
 * ONE anchored pattern per bar rather than a scan for loose pieces: a run must
 * sit in the room that immediately follows THIS bar's rail, so it can never be
 * credited to a neighbour; and the room must declare `flex:` OVERFLOW_CAP, so a
 * bar whose room drifted from the cap `barFigure` draws against stops matching
 * and every count below fails loudly instead of passing on the wrong geometry.
 * The hue and its contrast are asserted numerically in
 * db/nutrition-remaining.test.mjs §13.
 */
function readBars(html) {
  const div = '<div class="css-view-g5y9jx"';
  const roomFlex = String(OVERFLOW_CAP).replace('.', '\\.');
  const pattern = new RegExp(
    'data-testid="macro-bar-(optimal|good|caution|poor|unknown)">' +
      `${div} style="flex:1">${div} style="width:([\\d.]+)%"></div>(${div}></div>)?</div>` +
      `${div}></div>` +
      `${div} style="flex:${roomFlex}">` +
      `(?:${div} style="width:([\\d.]+)%" data-testid="macro-over">(${div} data-testid="macro-over-cap">)?)?`,
    'g'
  );
  return [...html.matchAll(pattern)].map((m) => ({
    level: m[1],
    pct: Number(m[2]),
    terminator: m[3] !== undefined,
    over: m[4] === undefined ? null : Number(m[4]) * OVERFLOW_CAP,
    cap: m[5] !== undefined,
  }));
}

function barsDrawn(name, html, count, metCount) {
  if (html === null) return;
  const bars = readBars(html);
  bars.length === count
    ? ok(
        `${name}: ${count} progress bar(s) drawn (${bars.map((b) => `${b.pct.toFixed(0)}%`).join(' ')})`
      )
    : bad(`${name}: expected ${count} bars`, `found ${bars.length}`);
  const met = bars.filter((b) => b.terminator);
  met.length === metCount && met.every((b) => b.pct === 100)
    ? ok(`${name}: ${metCount} of them carry the terminator, each at the mark`)
    : bad(
        `${name}: expected ${metCount} terminator(s) at 100%`,
        JSON.stringify(bars.filter((b) => b.terminator || b.pct === 100))
      );
}

/**
 * The runs past the mark (FB3), bar by bar. `expected[i]` is `[over, capped]`:
 * the run's length as a share of the rail, or `null` for no run at all. Every
 * bar that draws a run must ALSO be a full rail carrying its terminator — the
 * in-budget fill stops at the mark, and only the excess runs past it.
 */
function barsOver(name, html, expected) {
  if (html === null) return;
  const bars = readBars(html);
  const say = (over, capped) =>
    over === null ? 'none' : `${over.toFixed(2)}%${capped ? ' +' : ''}`;
  const found = bars.map((b) => say(b.over, b.cap)).join(' · ');
  bars.length === expected.length &&
  bars.every(({ over, cap }, i) => {
    const [want, capped] = expected[i];
    return want === null
      ? over === null && !cap
      : over !== null && Math.abs(over - want) < 0.01 && cap === capped;
  })
    ? ok(`${name}: past the mark ${found}`)
    : bad(`${name}: expected ${expected.map(([o, c]) => say(o, c)).join(' · ')}`, found);
  const running = bars.filter((b) => b.over !== null);
  running.every((b) => b.pct === 100 && b.terminator)
    ? ok(`${name}: each of the ${running.length} run(s) leaves a full rail at its terminator`)
    : bad(`${name}: a run beside a rail that is not full`, JSON.stringify(running));
}

/**
 * The GRADE each bar was coloured with, in document order (FB2).
 *
 * The class itself cannot be read here — NativeWind's babel transform does not
 * run in a server render, so `bg-signal-poor-bar` and `bg-signal-optimal-bar`
 * both come out as the same class-less `<div>`, which is exactly why
 * {@link readBars} reads geometry instead. So the bar carries its level in a
 * `testID`, which react-native-web DOES emit (`data-testid`), and the level →
 * class table is asserted separately from the imported {@link MACRO_BAR_FILL}.
 * The two together are what "the graded class rendered" means in this harness:
 * the render proves the right LEVEL reached the bar, the table proves the level
 * maps to the right class, and neither can drift without failing here.
 */
function gradedBars(html) {
  return [...html.matchAll(/data-testid="macro-bar-([a-z]+)"/g)].map((m) => m[1]);
}

function barsGraded(name, html, levels) {
  if (html === null) return;
  const found = gradedBars(html);
  found.length === levels.length && found.every((l, i) => l === levels[i])
    ? ok(`${name}: bars graded ${found.join(' · ')}`)
    : bad(`${name}: expected ${levels.join(' · ')}`, found.join(' · ') || 'no graded bars at all');
}

/**
 * Run `fn` with the wall clock frozen at `HH:MM` **on today's own date**.
 *
 * The Eat tab's bar colours are graded on the pace curve, so they depend on the
 * hour the suite happens to run at — every band assertion below would be green
 * in the evening and `unknown` before 10:00. Freezing the hour is the only way
 * to pin them; freezing the DATE too would be wrong, because every fixture is
 * logged under `todayISODate()` and the screen reads today.
 *
 * Only the time of day moves, so `todayISODate()` still answers the same
 * calendar day (the suite never installs a day boundary — `DEFAULT_DAY_STARTS_AT`
 * is `00:00`, so the logical day is the calendar day here).
 */
function atClock(hhmm, fn) {
  const Real = Date;
  const [h, m] = hhmm.split(':').map(Number);
  const fixed = new Real();
  fixed.setHours(h, m, 0, 0);
  const ms = fixed.getTime();
  class Frozen extends Real {
    constructor(...args) {
      if (args.length === 0) super(ms);
      else super(...args);
    }
    static now() {
      return ms;
    }
  }
  globalThis.Date = Frozen;
  try {
    return fn();
  } finally {
    globalThis.Date = Real;
  }
}

function expect(name, html, substrings) {
  if (html === null) return;
  ok(`${name} rendered without throwing (${html.length} chars)`);
  for (const s of substrings) {
    if (html.includes(s)) ok(`${name} shows "${s}"`);
    else bad(`${name} shows "${s}"`);
  }
}

const db = getDb();

{
  console.log('0. Empty states (fresh DB, real migrations)');
  expect('recipes (empty)', render('recipes (empty)', RecipesScreen), [
    'Import a recipe',
    'No recipes yet',
  ]);
  expect('grocery (empty)', render('grocery (empty)', GroceryScreen), [
    'Grocery list',
    'The list is clear.',
  ]);
  expect(
    'recipe-detail (missing id)',
    render('recipe-detail (missing id)', RecipeDetailScreen, { id: 'nope' }),
    ['This recipe is gone.']
  );
  expect('recipe-edit (new)', render('recipe-edit (new)', RecipeEditScreen), [
    'New recipe',
    'Add ingredient',
    'Save recipe',
  ]);
  expect('recipe-import', render('recipe-import', RecipeImportScreen), [
    'Import a recipe',
    'From a link',
    'Paste text',
    'No model key is set', // honest no-key state under node
    // D1: the no-key sentence is the explanation, so it names every rung the
    // model gates — including the video one. Nothing is greyed out; the
    // controls simply are not rendered in this arm, which is why the video
    // pressable's own render is a device obligation and not an assertion here.
    'captions, screenshots and videos need the model',
  ]);

  // The Protocols sub-app on a database that has never held one. This has to
  // happen HERE, before any fixture creates a protocol: the empty hub is the
  // first screen a fresh install reaches from Home's mission area, and it is a
  // state the owner's own device can never show (their device has data).
  const emptyHub = render('protocols (empty)', ProtocolsScreen);
  expect('protocols (empty)', emptyHub, [
    'Protocols',
    'New protocol',
    'No protocols yet',
    // Both first-run routes: build it yourself, or have the Coach draft one.
    // There is deliberately no template library — the Coach is the template
    // engine, and it can read a record a canned "Morning Stack" cannot.
    'Ask the Coach to draft one',
  ]);
  // Nothing may claim a rate, a phase or a group on a database with none.
  // ("Running" itself is not refutable — the closing margin note says *running
  //  protocols build Today's Mission*, which is true of an empty hub too.)
  refute('protocols (empty)', emptyHub, [
    'Ended',
    'Paused',
    '0%',
    'no record yet',
    'no version yet',
  ]);
  // A9: the empty hub's definition used to run three sentences, the last of
  // which explained versioning on a screen with no version yet. Cut to the
  // definition alone — must not silently come back.
  refute('protocols (empty)', emptyHub, ['Every edit after that becomes a new version.']);

  expect(
    'protocol-detail (missing id)',
    render('protocol-detail (missing id)', ProtocolDetailScreen, { id: 'nope' }),
    ['This protocol no longer exists.']
  );
  expect(
    'protocol-versions (missing id)',
    render('protocol-versions (missing id)', ProtocolVersionsScreen, { id: 'nope' }),
    ['This protocol no longer exists.']
  );

  // The CREATE path — the one the owner reported as "boxes covering other
  // boxes", and the path where every field is empty so a collapsed wrapper is
  // total. It must open on ONE open-ended phase with no phase chrome at all.
  const newProtocol = render('protocol-edit (new)', ProtocolEditScreen);
  expect('protocol-edit (new)', newProtocol, [
    'New Protocol',
    'Items',
    'Add item',
    'Add a phase',
    'Every day', // the cadence control, collapsed, stating the default
    'Create protocol',
  ]);
  refute('protocol-edit (new)', newProtocol, [
    'Phase 1', // no phase chrome until a second phase exists
    'Save as', // that is the edit path's label
    'Delete protocol',
  ]);

  // The execution record on a database that has never planned a day. This
  // render has to happen HERE, before any fixture touches log_entries: the
  // never-planned state is the one this screen most has to get right, and it
  // only exists once.
  const virgin = render('mission-history (never planned)', MissionHistoryScreen);
  expect('mission-history (never planned)', virgin, [
    'Mission',
    'No mission has been planned yet',
    'Set up a protocol', // the accent moves to the one action when there are no bars
  ]);
  // Nothing may imply a record that does not exist: no rate, no denominators,
  // no day rows, and above all no "nothing was missed" — which is a claim about
  // a plan, and there has never been one.
  refute('mission-history (never planned)', virgin, [
    '0 of 0',
    '0%',
    'Nothing was missed',
    'on record',
    'By day',
  ]);

  // Home and the Data tab on the same never-touched database (slop pass 3,
  // docs/ai-slop-candidates-2026-09.md §10). Much of what Home prints on day
  // one is BUILT in src/lib — the brief (src/lib/ai/insights.ts) and the
  // readiness line (src/lib/home/readiness.ts) — so two string-walks of app/
  // and src/components/ never read it. Each lost a tail that consoled or
  // narrated; the fact it carried is pinned beside the refutation.
  const firstHome = render('home (never touched)', HomeScreen);
  expect('home (never touched)', firstHome, [
    // The build fact, and the one thing a reader needs to know about it.
    'rides the next app build. Readings already in Apple Health will land then.',
    // SPARSE: what to log, and the gate as the number the detectors need.
    'Start with today: weight, what you eat, and any training. Trends need about ten days.',
  ]);
  refute('home (never touched)', firstHome, [
    'is safe there and will land here once it does',
    'a few days of anything at all',
  ]);
  // An empty trend row names the absence, like the five rows around it. This
  // one narrated the row's future instead ("Log weight to start a trend").
  const firstData = render('data tab (never touched)', DataScreen);
  expect('data tab (never touched)', firstData, ['No weight logged yet']);
  refute('data tab (never touched)', firstData, ['Log weight to start a trend']);

  // The water record on a database that has never logged a drop. Like
  // mission-history above, this render must happen HERE — the never-logged
  // state exists exactly once, and §14 below is what fills the table.
  const dry = render('water (never logged)', WaterScreen);
  expect('water (never logged)', dry, [
    'Water',
    // A9 (2026-09-19): the verdict names the absence and stops. It used to add
    // "Tap an amount below and the record starts." — a pointer at the quick-add
    // row three lines under it, narrating the widget back. Refuted below.
    'No water logged yet.',
    // Same round, same screen: the Entries empty used to run "...Anything you
    // add appears here to correct or remove.", describing rows the first entry
    // shows for itself.
    'Nothing logged today.',
    // The stamp takes the accent when there are no bars to spend it on.
    'No water yet',
    'The record starts with one glass',
    // Logging is on the screen itself — that is the whole point of it.
    'Glass',
    'Bottle',
    'Large',
    // No goal is an authored state, not a guess.
    'None set — totals show without a target.',
  ]);
  // A9: neither cut line may come back silently.
  refute('water (never logged)', dry, [
    'Tap an amount below and the record starts',
    'Anything you add appears here to correct or remove',
  ]);
  // Nothing may imply a record that does not exist, and above all no
  // plausible-looking zero: a day with nothing logged and a day of 0 oz are
  // different facts. No goal means no denominator, no percentage, no bar.
  refute('water (never logged)', dry, [
    '0 oz',
    '0 ml',
    'of goal',
    'By day',
    'on record',
    'average',
  ]);

  // The Log tab's water row with nothing to learn from — and this render, like
  // the two above, only exists here: it is the state the owner sees on day one.
  //
  // Until 2026-09-21 this block was a single Water TILE that committed a
  // *derived* amount and hid Glass / Bottle / Large / Other… behind a
  // long-press. Off device that came back as *"the water no longer really
  // works, because the button just adds 8"* — the derivation had settled on a
  // glass and the gesture was invisible, so one amount was the only amount. So
  // the assertion flips: every vessel must be ON the sheet, each saying the
  // amount it will write (src/components/log/quick-add-grid.tsx).
  const freshLog = render('log tab (no water on record)', LogScreen);
  expect('log tab (no water on record)', freshLog, [
    'Quick add',
    'Supplement',
    'Weight',
    'Therapy',
    'Water',
    // All four cells, at rest, with no gesture and no record behind them.
    'Glass',
    'Bottle',
    'Large',
    'Other…',
    'Keypad',
    '+8 oz',
    '+16 oz',
    '+24 oz',
    // Each cell's label carries its own amount, so no tap is a guess — and the
    // number in the label is the number the caption prints beside it.
    'Log 8 oz of water, Glass',
    'Log 16 oz of water, Bottle',
    'Log 24 oz of water, Large',
    'Log another amount of water on the keypad',
    'Nothing logged yet today.',
  ]);
  refute('log tab (no water on record)', freshLog, [
    // The one committing tile and its derived face are gone...
    'Log water, 8 oz',
    // ...and with an empty record there is no habit to state. An invented
    // "usually" would be a claim about a pattern that does not exist.
    'usually',
    // No receipt until something is actually written.
    'Logged 8 oz',
  ]);

  // **Nothing in this block may depend on a long-press again.** The gesture was
  // the whole of the bug: invisible, so it was never found, and the tile it hid
  // behind logged the same 8 oz every time. A rendered sheet cannot prove the
  // ABSENCE of a handler — RNW drops `accessibilityActions` and `onLongPress`
  // alike — so this is a source scan and is honest about being one. It also
  // pins the binding the whole fix rests on: each vessel passes ITS OWN amount.
  {
    const tile = readFileSync(
      new URL('../src/components/log/quick-add-grid.tsx', import.meta.url),
      'utf8'
    );
    !/onLongPress=/.test(tile) && !/accessibilityActions=/.test(tile)
      ? ok('nothing in Quick add is reachable only by a long-press')
      : bad('a long-press is back — an amount must never hide behind a gesture');
    /onPress=\{\(\) => log\(q\.amount\)\}/.test(tile)
      ? ok('each vessel logs its own amount, never a remembered one')
      : bad('a vessel stopped passing its own amount to log()');
  }

  // ---------------------------------------------------------------------
  // What a vessel tap DOES, and what Undo takes back.
  //
  // A server render runs no effects and dispatches no events, so the press
  // itself cannot be fired here. What can be proved is the pair either side of
  // it — the exact call the handler makes (`logWater` of the DISPLAY amount put
  // through the metric's spec) and the exact call Undo makes
  // (`deleteWaterEntry` of the id that write handed back) — read back through
  // the screen's own ledger rather than a repository query, which is the
  // receipt the owner actually sees.
  //
  // Both rows are removed again at the end, so §14 still opens on a water
  // record that has never been written to.
  {
    const wdb = getDb();
    const spec = resolveDisplay(metricByKey('water'), getPreferences(wdb).units);
    const today = todayISODate();
    const glass = logWater(wdb, today, spec.toCanonical(8));
    const bottle = logWater(wdb, today, spec.toCanonical(16));

    // Exactly what each cell said it would write, and nothing rounded on the
    // way through: 16 oz stored canonically and read back is 16 oz, not 15.
    const logged = render('log tab (a glass and a bottle logged)', LogScreen);
    expect('log tab (a glass and a bottle logged)', logged, ['2 entries', '>8 oz<', '>16 oz<']);
    refute('log tab (a glass and a bottle logged)', logged, ['Nothing logged yet today.']);

    // Undo deletes by the id its own write returned, so it can only ever remove
    // the glass it just wrote — never the neighbouring one.
    deleteWaterEntry(wdb, bottle);
    const undone = render('log tab (the bottle undone)', LogScreen);
    expect('log tab (the bottle undone)', undone, ['1 entry', '>8 oz<']);
    refute('log tab (the bottle undone)', undone, ['>16 oz<']);

    deleteWaterEntry(wdb, glass);
    const cleared = render('log tab (both undone)', LogScreen);
    expect('log tab (both undone)', cleared, ['Nothing logged yet today.']);
    refute('log tab (both undone)', cleared, ['>8 oz<']);
  }

  // 0035: the cabinet before there is anything in it. "Unfiled is a place" is
  // the design statement the whole feature turns on, so it is asserted.
  const emptyFolders = render('recipe-folders (empty)', RecipeFoldersScreen);
  expect('recipe-folders (empty)', emptyFolders, ['Folders', 'New folder', 'No folders yet']);
  // A9: the reassurance clause ("...which is a perfectly good place for it
  // until there are enough of them to sort") must not silently come back.
  refute('recipe-folders (empty)', emptyFolders, ['a perfectly good place']);
  expect(
    'recipe-revise (missing id)',
    render('recipe-revise (missing id)', RecipeReviseScreen, { id: 'nope' }),
    ['This recipe is gone']
  );
}

{
  console.log('1. Fixtures through the real repositories');
  const chicken = createFood(db, {
    name: 'Render chicken',
    kcal_100g: 165,
    protein_g_100g: 31,
    carbs_g_100g: 0,
    fat_g_100g: 3.6,
  });
  const adobo = createRecipe(db, {
    title: 'Chicken Adobo',
    source: 'import',
    // All four 0031 provenance columns, because since 2026-09-14 the detail
    // screen READS them (A6): the source line is a link, and the og:image is
    // drawn when the recipe has no photo of its own.
    source_url: 'https://www.instagram.com/reel/RENDER1/',
    source_platform: 'instagram',
    source_author: 'renderchef',
    source_image_url: 'https://scontent.cdninstagram.com/v/render.jpg',
    servings: 2,
    steps: ['Brown the chicken pieces.', 'Simmer in the sauce.'],
    ingredients: [
      { raw_text: '400 g chicken thighs' },
      { raw_text: '1/2 cup soy sauce' },
      { raw_text: 'salt to taste' },
    ],
  });
  const lines = listIngredients(db, adobo);
  resolveIngredient(db, lines[0].id, chicken, 400);
  resolveIngredient(db, lines[1].id, chicken, 120); // stand-in food; math is what's rendered
  setIngredientNegligible(db, lines[2].id, true);

  const draft = createRecipe(db, {
    title: 'Mystery stew',
    servings: 4,
    ingredients: [{ raw_text: 'some vegetables' }],
  });
  setRecipeFavorite(db, draft, true);

  addGroceryItems(db, [
    { name: 'Milk', qty_text: '2' },
    { name: 'Spinach' },
    { name: 'Sourdough' },
  ]);
  setStaple(db, 'Coffee beans', true);

  const { mealId } = logMealWithItems(db, {
    date: '2026-08-08',
    time: '12:00',
    name: 'Render lunch',
    items: [
      { food_id: chicken, name: 'Render chicken', amount: 150, kcal: 247.5, protein_g: 46.5 },
    ],
  });

  // A BARCODED food, logged — the two facts the scanner's running list joins
  // (§7b). `Render chicken` above is deliberately left barcode-less, so the
  // list's narrowing is proved by an exclusion and not only by an inclusion.
  // …and it is a DRINK (0047), so the running list is also where a millilitre
  // portion has to survive a real render — including through the oz preference.
  const oatDrink = createFood(db, {
    name: 'Render oat drink',
    brand: 'Oatly-ish',
    barcode: '5060000000000',
    basis: 'ml',
    kcal_100g: 46,
    protein_g_100g: 1,
    carbs_g_100g: 6.7,
    fat_g_100g: 1.5,
  });
  logMealWithItems(db, {
    date: '2026-08-08',
    time: '07:30',
    name: 'Render breakfast',
    items: [{ food_id: oatDrink, name: 'Render oat drink', amount: 250, unit: 'ml', kcal: 115 }],
  });

  ok('fixtures seeded (recipes, grocery, meal)');

  console.log('2. Populated renders');
  expect('recipes (populated)', render('recipes (populated)', RecipesScreen), [
    'Chicken Adobo',
    'Mystery stew',
    'kcal/serving', // the complete recipe's honest headline
    'ingredient',
  ]);
  // Complete recipe: per-serving numbers + steps + the per-line PROVENANCE
  // that replaced the Link chore (0034). `your pick` is the fixture's
  // hand-resolved line; the negligible one still says so in words.
  expect(
    'recipe-detail (complete)',
    render('recipe-detail (complete)', RecipeDetailScreen, { id: adobo }),
    [
      'Chicken Adobo',
      'renderchef',
      '400 g chicken thighs',
      'Brown the chicken pieces.',
      'Per serving',
      'Log it',
      'Add to grocery list',
      'counts as 0, on purpose', // the negligible salt line
      'your pick', // provenance, not an affordance
      'priced', // the Ingredients tally
    ]
  );
  /**
   * A6 — the source line and the source photo, both READ from stored columns.
   *
   * 0031 has held `source_url` / `source_platform` / `source_author` /
   * `source_image_url` since the importer shipped, and the screen printed only
   * the last two, as dead text, with the raw enum ("instagram") after the
   * author. Now the line names the platform the way it names itself, the whole
   * line is a link, and the og:image is drawn because this fixture has no photo
   * of its own.
   */
  {
    const html = render('recipe-detail (source)', RecipeDetailScreen, { id: adobo });
    expect('recipe-detail (source)', html, [
      'Instagram · renderchef',
      'role="link"', // it is an affordance, not the dead text it used to be
      'Open the source of this recipe', // …and it says so out loud
      'Image from the source of Chicken Adobo', // the og:image frame mounted
      'From the source', // labelled, so the poster's still is never mistaken
    ]); //                   for a photo of the thing the owner cooked
    // (The URL itself is never printed — the line names the platform and the
    // author, which is what a reader can use. That `source_url` is what gets
    // opened, and that only http(s) ever is, is pinned in db/recipes.test.mjs
    // §20 against `isOpenableSourceUrl`; react-native-web puts an Image's URI
    // in a generated stylesheet rather than in the markup, so the frame is
    // asserted by its label.)
    // The raw enum must never reach the reader again.
    refute('recipe-detail (source)', html, ['· instagram', 'instagram · renderchef']);
    // The recipe with NO provenance draws no source chrome at all — the line is
    // absent, not an empty stand-in.
    refute(
      'recipe-detail (no source)',
      render('recipe-detail (no source)', RecipeDetailScreen, {
        id: draft,
      }),
      ['From the source', 'Open the source of this recipe']
    );
  }

  // Incomplete recipe. The headless runtime has no model key, so the model pass
  // never fires and the screen must say WHY the lines are unpriced rather than
  // handing the user a chore — which is the whole point of the 0034 change.
  const incomplete = render('recipe-detail (incomplete)', RecipeDetailScreen, { id: draft });
  expect('recipe-detail (incomplete)', incomplete, [
    'Mystery stew',
    'not priced yet',
    'aren’t in your food catalog',
  ]);
  !incomplete.includes('Link each line') && !incomplete.includes('Nutrition not computed')
    ? ok('recipe-detail no longer asks the user to link anything')
    : bad('the Link chore is still on the screen');
  expect(
    'recipe-edit (existing)',
    render('recipe-edit (existing)', RecipeEditScreen, { id: adobo }),
    ['Edit recipe', '400 g chicken thighs', 'Save changes']
  );
  expect('grocery (populated)', render('grocery (populated)', GroceryScreen), [
    'Dairy &amp; Eggs', // category section from the static table
    'Milk',
    'Produce',
    'Spinach',
    'Bakery',
    'Sourdough',
    'Staples',
    'Coffee beans',
  ]);

  console.log('3. The Eat tab, redrawn — first run (no targets, nothing logged today)');
  {
    // The fixture meal is dated 2026-08-08; the hub reads TODAY, so this render
    // is the genuine first-run state even with the book and list populated.
    const html = render('nutrition hub (first run)', NutritionScreen);
    expect('nutrition hub (first run)', html, [
      'Nothing logged yet today, and no targets set',
      'Set daily targets', // promoted to a full-width control while it is needed
      // The capture pair is the accent in every state, and the chooser sits
      // under it outlined — the owner's words, verbatim (2026-08-15). Asserted
      // by NAME so a sweep that quietly restores "Log" fails the suite.
      'Other ways to log',
      'Photo',
      'Describe',
      'Kitchen',
      'Recipe book',
      'Grocery list',
      '2 recipes',
      '3 to buy',
      'Over time',
      'Energy',
      'Protein',
      'Micronutrients',
    ]);
    // No target exists, so no figure may carry a denominator and nothing may
    // claim a remainder.
    refute('nutrition hub (first run)', html, ['kcal left', 'left of']);
  }

  console.log('4. The Eat tab — the guarded remainder, when the day has earned it');
  const today = todayISODate();
  {
    setNutritionTargets(db, {
      effective_date: today,
      kcal: 2400,
      protein_g: 180,
      carbs_g: 240,
      fat_g: 70,
    });
    logMeal(db, {
      date: today,
      time: '08:30',
      name: 'Protein oats',
      kcal: 620,
      protein_g: 42,
      carbs_g: 68,
      fat_g: 20,
    });
    logMeal(db, {
      date: today,
      time: '12:40',
      name: 'Salmon + lentils',
      kcal: 740,
      protein_g: 46,
      carbs_g: 62,
      fat_g: 33,
    });

    const html = render('nutrition hub (guarded)', NutritionScreen);
    expect('nutrition hub (guarded)', html, [
      'kcal left', // 2,400 − 1,360 = 1,040
      '1,040',
      'Protein left', // the cell label carries the mode
      '1,360 of 2,400 kcal', // the corner note the hero was subtracted from
      'Eaten today',
      '1,360 kcal', // and the ledger sums to the same figure
      'Protein oats',
      'Salmon + lentils',
    ]);
    // The setup affordance retires the moment it is satisfied.
    refute('nutrition hub (guarded)', html, ['Set daily targets', 'no targets set']);
    // C6, AND THE REGRESSION IT FIXES: this is the well-logged day, the one
    // `remaining` mode is for, and before C6 it carried no bar anywhere on the
    // screen — the rule was drawn only under an EATEN reading, which is the
    // fallback. Four now: the kcal hero and all three macro cells.
    barsDrawn('nutrition hub (guarded)', html, 4, 0);
    // Every meal's macros are on its row, as three cells rather than a joined
    // string — the item count they replace is gone from the tab.
    expect('nutrition hub (guarded) meal rows', html, ['P 42g', 'C 68g', 'F 20g', 'P 46g']);
    refute('nutrition hub (guarded)', html, ['P 42g · C 68g', '1 item', '2 items']);

    // FB2 — the colours, on a day closed at 21:30. 1,360 of 2,400 kcal is 43%
    // short and 88 of 180 g protein is barely half, so this well-logged day is
    // also a badly-SHORT one: poor / poor / poor, and fat's 53 of 70 (−24%)
    // lands inside `maintain`'s caution band. The grades come from the Home
    // pillar's own functions, so this is what Home says about the same day.
    barsGraded(
      'nutrition hub (guarded, 21:30)',
      atClock('21:30', () => render('nutrition hub (graded)', NutritionScreen)),
      ['poor', 'poor', 'poor', 'caution']
    );
    // …and the same day BEFORE the pace clock starts is not graded at all. With
    // `expected` at 0 the projection is the whole target, so every bar would
    // open the morning green — the pillar refuses, and so does the tab.
    barsGraded(
      'nutrition hub (guarded, 08:00 — before the first anchor)',
      atClock('08:00', () => render('nutrition hub (pre-pace)', NutritionScreen)),
      ['unknown', 'unknown', 'unknown', 'unknown']
    );
  }

  console.log('5. The Eat tab — the fallback, when a meal has no numbers');
  {
    logMeal(db, {
      date: today,
      time: '19:05',
      name: 'Dinner out',
      kcal: null,
      protein_g: null,
      carbs_g: null,
      fat_g: null,
    });

    const html = render('nutrition hub (fallback)', NutritionScreen);
    expect('nutrition hub (fallback)', html, [
      'One meal is not fully counted for energy, protein, carbs or fat',
      'what is left of today is not known',
      'Nothing recorded — tap to fill it in', // the same fact, stated on the row
      '1,360 of 2,400 kcal', // the eaten reading, denominator intact
    ]);
    // THE POINT OF THE GUARD: no remainder is drawn on a day it cannot compute.
    refute('nutrition hub (fallback)', html, ['kcal left', 'Protein left']);
    // …and the bars survive the fallback: the number above them changed from a
    // remainder to an eaten figure, the thing they draw did not.
    barsDrawn('nutrition hub (fallback)', html, 4, 0);
  }

  console.log('5b. The bars at target, and a meal that carries BOTH a note and macros (C6)');
  {
    // Back to a day that can be counted down, so all three completion cues are
    // on screen at once: the unmeasured meal §5 added is removed (it has no
    // items to cascade), and a meal that takes protein past its target goes on.
    // That is the only state that turns a fill pine and draws the terminator.
    //
    // The new meal also carries a NOTE, which is the silent loss C6 fixes:
    // `meal.notes ?? macros` meant an AI-estimated meal — which always has the
    // model's note — showed no macros at all, so the meals most worth
    // inspecting were exactly the ones whose numbers were hidden.
    db.run('DELETE FROM meals WHERE date = ? AND name = ?', [today, 'Dinner out']);
    logMeal(db, {
      date: today,
      time: '20:10',
      name: 'Post-lift shake',
      kcal: 480,
      protein_g: 95,
      carbs_g: 40,
      fat_g: 9,
      notes: 'Two scoops; the milk was whole, not skim.',
    });

    const html = render('nutrition hub (at target)', NutritionScreen);
    // 42 + 46 + 95 = 183 of a 180 g protein target.
    barsDrawn('nutrition hub (at target)', html, 4, 1);
    // FB3: 183 of 180 g is 3 g past the mark, so the protein bar now draws a run
    // beyond its terminator — 1.67% of the rail, a sliver, which is the honest
    // size of 3 g. Nothing else on this day is over, so nothing else draws one.
    barsOver('nutrition hub (at target)', html, [
      [null, false],
      [(3 / 180) * 100, false],
      [null, false],
      [null, false],
    ]);
    expect('nutrition hub (at target)', html, [
      'Protein over', // the third cue, in words — the label already flips
      'Two scoops; the milk was whole, not skim.', // the note, still drawn
      'P 95g', // and the macros, on the same row, no longer displaced by it
      'C 40g',
      'F 9g',
    ]);

    // FB2 — the other two bands, on the same closed day. 1,840 of 2,400 kcal is
    // −23% (caution), 183 of 180 g protein is met (optimal — and one-sided, so
    // being OVER is not a fault in any direction), 170 of 240 g carbs is −29%
    // (caution) and 62 of 70 g fat is −11% (good). With §4 above, all four bands
    // plus `unknown` are now drawn by a real fixture rather than asserted in the
    // abstract.
    barsGraded(
      'nutrition hub (at target, 21:30)',
      atClock('21:30', () => render('nutrition hub (at target, graded)', NutritionScreen)),
      ['caution', 'optimal', 'caution', 'good']
    );
  }

  console.log('5c. The bars with NO target, and the grade → class table (FB2)');
  {
    // A day with meals on it and NO targets at all. `nutrition_targets` refuses
    // an all-null row by CHECK — a target set that governs nothing is not a
    // target set — so "no targets" is the absence of the row, and that is what
    // is staged here. §4's row is put back immediately afterwards, so every
    // section below (the micronutrients screen included) sees the targets it set.
    db.run('DELETE FROM nutrition_targets WHERE effective_date = ?', [today]);
    const html = atClock('21:30', () => render('nutrition hub (no targets)', NutritionScreen));
    barsGraded('nutrition hub (no targets)', html, ['unknown', 'unknown', 'unknown', 'unknown']);
    barsDrawn('nutrition hub (no targets)', html, 4, 0);
    // A neutral bar is a RAIL, not a reading: no fill, and no denominator
    // anywhere on the grid (00-design-spec.md §5).
    readBars(html).every((b) => b.pct === 0)
      ? ok('nutrition hub (no targets): every neutral bar is an empty rail')
      : bad('a bar claimed progress with no target', JSON.stringify(readBars(html)));
    refute('nutrition hub (no targets)', html, ['of 2,400 kcal', 'kcal left', 'Protein left']);
    setNutritionTargets(db, {
      effective_date: today,
      kcal: 2400,
      protein_g: 180,
      carbs_g: 240,
      fat_g: 70,
    });
    barsGraded(
      'nutrition hub (targets restored)',
      atClock('21:30', () => render('nutrition hub (targets restored)', NutritionScreen)),
      ['caution', 'optimal', 'caution', 'good']
    );

    // The half the render cannot see. NativeWind compiles className away in a
    // server render, so the markup above proves only that the right LEVEL
    // reached each bar; this proves the level maps to the class that colours it.
    // Whole literals, because Tailwind's scanner never sees a built fragment —
    // a `bg-signal-${level}-bar` would compile to nothing and ship four
    // invisible bars.
    const expectedFill = {
      optimal: 'h-[6px] bg-signal-optimal-bar',
      good: 'h-[6px] bg-signal-good-bar',
      caution: 'h-[6px] bg-signal-caution-bar',
      poor: 'h-[6px] bg-signal-poor-bar',
      unknown: 'h-[6px] bg-signal-unknown',
    };
    const levels = Object.keys(expectedFill);
    levels.every((l) => MACRO_BAR_FILL[l] === expectedFill[l]) &&
    Object.keys(MACRO_BAR_FILL).length === levels.length
      ? ok(`the grade → fill table is total over all ${levels.length} levels, in whole literals`)
      : bad('grade → fill table', JSON.stringify(MACRO_BAR_FILL));
    // The BAR cut (FB3) — neither the swatch, two of which are under 3:1 on this
    // rail, nor FB2's ink cut, which is a TEXT cut and read as drab on the
    // device. db/nutrition-remaining.test.mjs §13 carries the measurements.
    levels
      .filter((l) => l !== 'unknown')
      .every(
        (l) =>
          MACRO_BAR_FILL[l].includes(`bg-signal-${l}-bar`) && !MACRO_BAR_FILL[l].includes('-ink')
      )
      ? ok('every graded fill takes the bar cut — the most chroma its hue has at 4.5:1 on the rail')
      : bad('a graded fill left the bar cut', JSON.stringify(MACRO_BAR_FILL));
    // The height the owner asked for, in one place: the rail and its fill must
    // not disagree, or the fill draws a stripe inside the rail.
    levels.every((l) => MACRO_BAR_FILL[l].startsWith('h-[6px] '))
      ? ok('every fill is 6px — the rail’s own height (4px before FB2)')
      : bad('a fill no longer matches the rail height');
    // The run past the mark (FB3) is ONE literal whatever the grade: how far over
    // the day went is behaviour, so it wears the accent and never the verdict's
    // palette — the two meanings side by side, never sharing a colour.
    MACRO_BAR_OVER.split(' ').includes('bg-pine') &&
    !MACRO_BAR_OVER.includes('signal') &&
    MACRO_BAR_OVER.split(' ').includes('h-[6px]')
      ? ok(
          `the run past the mark is the accent at the rail’s height, in every grade: "${MACRO_BAR_OVER}"`
        )
      : bad('the overflow run’s class', MACRO_BAR_OVER);
  }

  console.log('5d. Over target — the run past the mark, and the + past the cap (FB3)');
  {
    // The owner, from the device: "the blue could also go over the bar again
    // for overflow." Until FB3 a bar stopped at its mark, so a day far over
    // target drew exactly what a day ON target drew — a full rail. A dinner goes
    // on that takes this day to 2,900 of 2,400 kcal (the example the round was
    // cut against), 300 of 180 g protein (+67%, past the 150% cap), 230 of
    // 240 g carbs (still under) and 70 of 70 g fat (exactly met): the four
    // shapes a bar can take, on one screen.
    logMeal(db, {
      date: today,
      time: '20:45',
      name: 'Steak night',
      kcal: 1060,
      protein_g: 117,
      carbs_g: 60,
      fat_g: 8,
    });
    const html = atClock('21:30', () => render('nutrition hub (over)', NutritionScreen));
    // The in-budget fill is capped AT the mark: three full rails with their
    // terminators (kcal, protein, fat), and carbs short of its own.
    barsDrawn('nutrition hub (over)', html, 4, 3);
    barsOver('nutrition hub (over)', html, [
      [(2900 / 2400 - 1) * 100, false], // +20.83%: a run a fifth of the rail long
      [OVERFLOW_CAP * 100, true], // +66.7% fills the room and takes the +
      [null, false], // under: no run
      [null, false], // exactly on target: the mark, and nothing past it
    ]);
    // …and the run says HOW FAR, never WHETHER. The kcal bar is `caution` (+21%
    // maintaining); the protein bar is `optimal` though it ran off the end of its
    // room, because protein is one-sided. The same accent on both runs — the
    // verdict stays in the fill.
    barsGraded('nutrition hub (over)', html, ['caution', 'optimal', 'optimal', 'optimal']);
    // The words agree with the geometry: the hero, the label and the corner.
    expect('nutrition hub (over)', html, ['kcal over', 'Protein over', '2,900 of 2,400 kcal']);
    // Put the day back, so every section below sees the day §5b left.
    db.run('DELETE FROM meals WHERE date = ? AND name = ?', [today, 'Steak night']);
  }

  console.log('5b. The Eat tab — a meal waiting on a queued estimate (0057, C3)');
  {
    // An estimate taken offline logs a PLACEHOLDER: a meal the user can see,
    // with NULL macros. The row must say what it is waiting for rather than
    // wearing "tap to fill it in", which is advice he cannot act on — and it
    // must never read as a meal measured at zero.
    queueNewMealEstimate(
      db,
      { date: today, time: '21:15', name: placeholderMealName('a chicken burrito and a lager') },
      { kind: 'text', description: 'a chicken burrito and a lager' }
    );
    const html = render('nutrition hub (estimate pending)', NutritionScreen);
    expect('nutrition hub (estimate pending)', html, [
      'a chicken burrito and a lager', // the user's own words, as the name
      'Estimate pending — offline',
    ]);
    // …and the two readings the PLACEHOLDER's own row must never produce: a
    // fabricated zero, and the line meant for a meal the user could fill in
    // himself right now. Checked in a window around the row rather than over
    // the whole page, because "Dinner out" above legitimately wears that line
    // and "2,400 kcal" legitimately contains "0 kcal".
    if (html !== null) {
      const at = html.indexOf('a chicken burrito and a lager');
      const row = at === -1 ? '' : html.slice(at, at + 700);
      row.includes('Estimate pending — offline') &&
      !row.includes('Nothing recorded') &&
      !/>\s*0\s*</.test(row)
        ? ok('the pending row says what it waits for, and shows no number at all')
        : bad('pending row', row.slice(0, 200));
    }
  }

  console.log('6. Both routes of the same file still render');
  {
    // The tab root is a PROP now, not global route state — app/(tabs)/eat.tsx
    // renders <NutritionScreen asTab />, so that is what this renders.
    const tabRoot = render('nutrition hub (tab root)', NutritionScreen, {}, { asTab: true });
    expect('nutrition hub (tab root)', tabRoot, [
      'Nutrition',
      // The two capture shortcuts (owner, 2026-08-14), promoted above the
      // chooser and given the accent on 2026-08-15. They stand in every state
      // of the tab, so they are asserted on the tab render.
      'Photograph a meal',
      'Describe a meal in words',
      'Other ways to log a meal', // the renamed chooser's spoken label
    ]);
    // The old label is GONE. "Log a meal" was the accent button's spoken label
    // and `Log` its visible word; the owner renamed it by name, so a silent
    // revert has to fail here rather than on the device.
    refute('nutrition hub (tab root)', tabRoot, ['Log a meal', '>Log<']);
    const pushed = render('nutrition hub (pushed)', NutritionScreen);
    expect('nutrition hub (pushed)', pushed, ['Nutrition']);
  }

  console.log('7. Edited shipped screens still render');
  {
    const detail = render('meal-detail', MealDetailScreen, { id: mealId });
    expect('meal-detail (+ Save as recipe)', detail, [
      'Render lunch',
      'Save as template',
      'Save as recipe',
      // The rename affordance (owner, 2026-08-15) sits in StackHeader's new
      // trailing slot, on the title it changes. Asserted by name — the owner
      // asked for this control, so a sweep that removes it fails here.
      'Rename',
      'Rename this meal',
    ]);
    // The editor is CLOSED on arrival: a rename is a deliberate act, and a
    // field sitting open under the title would look like the name is unsaved.
    refute('meal-detail', detail, ['Meal name', 'Stop renaming this meal']);

    // And the rename really writes — through the same repository call the
    // screen's Save uses, so the assertion covers the write and not a mock.
    updateMealName(db, mealId, 'Render lunch, corrected');
    const renamed = render('meal-detail (renamed)', MealDetailScreen, { id: mealId });
    expect('meal-detail (renamed)', renamed, [
      'Render lunch, corrected',
      'Render chicken', // the items are untouched by a rename
      '248', // ...and so are the totals derived from them (247.5 kcal, rounded)
    ]);
    updateMealName(db, mealId, 'Render lunch');
  }

  console.log('7b2. meal-detail draws a composite as ONE row with its parts folded (0058)');
  {
    const { mealId: pizzaId } = logMealWithItems(db, {
      date: today,
      time: '19:30',
      name: 'Pizza night',
      items: [
        {
          name: 'Pepperoni pizza',
          components: [
            { name: 'Pizza crust', amount: 300, kcal: 800, protein_g: 26, carbs_g: 160, fat_g: 6 },
            { name: 'Mozzarella', amount: 150, kcal: 450, protein_g: 33, carbs_g: 5, fat_g: 33 },
            { name: 'Pepperoni', amount: 60, kcal: 300, protein_g: 12, carbs_g: 2, fat_g: 27 },
          ],
        },
        { name: 'Lager', amount: 330, unit: 'ml', kcal: 140, protein_g: 1, carbs_g: 11, fat_g: 0 },
      ],
    });
    const pizza = render('meal-detail (composite)', MealDetailScreen, { id: pizzaId });
    expect('meal-detail (composite)', pizza, [
      'Pepperoni pizza',
      '3 parts',
      // The headline IS the parts' sum, derived at read time — 800+450+300.
      '1,550',
      // …and the meal's own total counts the parts, never the header: 1,690.
      '1,690',
      // The disclosure, spoken as one phrase.
      'Pepperoni pizza, 3 parts, 1,550 kcal',
    ]);
    // COLLAPSED BY DEFAULT — the table stays a table, and a pizza reads as one
    // thing you ate until you ask about its parts. The fraction chips live
    // inside the disclosure, so they are absent too.
    refute('meal-detail (composite)', pizza, [
      'Pizza crust',
      'Mozzarella',
      'I ate half of the Pepperoni pizza',
    ]);
  }

  console.log('7c. Micronutrients — the owner’s three: caffeine, fiber, sodium');
  {
    // Backlog A8. Two itemized meals on today, carrying the two micros the
    // estimator now returns plus the fiber column. The three free-form meals
    // already logged above contribute nothing — which is exactly the day the
    // screen's undercount caveat exists for, so it is asserted here too.
    //
    // First, the day BEFORE either lands, when no item has recorded fiber:
    // the fiber plate says "not recorded", as the Eat tab one tap back does —
    // never "0 g" (review finding, 2026-09-23).
    const bare = render('nutrition-micros (no fiber recorded)', NutritionMicrosScreen);
    expect('nutrition-micros (no fiber recorded)', bare, ['Fiber', 'Eaten today', 'not recorded']);
    refute('nutrition-micros (no fiber recorded)', bare, ['>0<', 'g of ']);
    // The empty state, on the day it matters most: three meals are logged and
    // none carries micros. Slop pass 4 (§11.B) made it one sentence — the
    // absence and where micronutrients come from, which is why these three
    // record none — and cut the estimator's rule it had grown.
    expect('nutrition-micros (no fiber recorded)', bare, [
      'Nothing recorded yet today — only catalog foods and estimates carry micronutrients.',
    ]);
    refute('nutrition-micros (no fiber recorded)', bare, [
      'notable source of',
      'Foods from the catalog contribute micronutrients',
    ]);
    logMealWithItems(db, {
      date: today,
      time: '15:10',
      name: 'Flat white',
      items: [
        {
          name: 'Flat white',
          amount: 240,
          kcal: 120,
          protein_g: 7,
          fiber_g: 0,
          micros: JSON.stringify({ caffeine_mg: 145, sodium_mg: 90 }),
        },
      ],
    });
    logMealWithItems(db, {
      date: today,
      time: '13:15',
      name: 'Lentil soup',
      items: [
        {
          name: 'Lentil soup',
          amount: 400,
          kcal: 320,
          protein_g: 18,
          fiber_g: 21,
          micros: JSON.stringify({ sodium_mg: 1150 }),
        },
      ],
    });

    const micros = render('nutrition-micros', NutritionMicrosScreen);
    expect('nutrition-micros', micros, [
      'Sodium',
      '1,240', // 90 + 1,150, summed across the day's items
      'Caffeine',
      '145',
      // 2 of 12: caffeine joined the vocabulary, so the denominator moved too.
      '2 of 12 recorded',
      'Fiber',
      // The owner asked for this caveat by name once already: a day holding any
      // food without micros undercounts, silently, unless it is said.
      'Only foods with recorded micronutrients contribute',
      // No fiber target on this profile yet — the figure stands with no
      // denominator rather than vanishing (00-design-spec.md §5).
      'no target set',
    ]);
    refute('nutrition-micros', micros, ['daily target']);

    // Give the day a fiber target and the same figure earns its denominator.
    // Written onto the existing row rather than appended: two target rows with
    // the same effective_date tie-break on created_at, and a render fixture
    // must not depend on which millisecond it landed in.
    db.run('UPDATE nutrition_targets SET fiber_g = ? WHERE effective_date = ?', [34, today]);
    const withTarget = render('nutrition-micros (fiber target)', NutritionMicrosScreen);
    expect('nutrition-micros (fiber target)', withTarget, ['Fiber', 'g of 34 g', 'daily target']);
    refute('nutrition-micros (fiber target)', withTarget, ['no target set']);
  }

  console.log('7c2. The owner’s three on the Eat tab, and the one notable micro on a row');
  {
    // Owner, 2026-09-23: "Sodium and caffeine more accessible", "Fiber should
    // be more visible too", "Important micro should show on key items; i.e.,
    // displaying caffeine on a latte". The day §7c left: the Flat white (145 mg
    // caffeine, 90 mg sodium), the Lentil soup (1,150 mg sodium, 21 g fiber),
    // a 34 g fiber target, and the free-form meals logged earlier in the walk.
    const hub = render('nutrition hub (key micros)', NutritionScreen);
    expect('nutrition hub (key micros)', hub, [
      // Under the macro bars, without opening the micronutrients screen.
      '>Sodium<',
      '>1,240<',
      'of ~2,300 limit',
      '>Caffeine<',
      '>145<',
      'of ~400 limit',
      '>Fiber<',
      '>21<',
      'of 34 g',
      // Each cell speaks as one sentence.
      'Sodium, 1,240 milligrams of about 2,300 limit',
      'Fiber, 21 of 34 grams',
      // The walk's free-form meals record none of the three, and it is said.
      'logged as totals only add no sodium, caffeine or fiber here.',
      // The rest of the shortlist is still one tap away, where it was.
      'Micronutrients',
      // …and the owner's example on the row he reads every day (review
      // finding): the Flat white's meal row says its caffeine, the soup's its
      // sodium — one figure each, so the soup's 21 g of fiber is not beside it.
      '145 mg caffeine',
      '1,150 mg sodium',
    ]);
    refute('nutrition hub (key micros)', hub, ['21 g fiber', '90 mg sodium']);
    // In order: the three sit UNDER the macro cells, inside the Today grid,
    // ahead of the capture buttons.
    if (hub !== null) {
      const at = (s) => hub.indexOf(s);
      at('Fat') < at('>Sodium<') &&
      at('>Sodium<') < at('>Caffeine<') &&
      at('>Caffeine<') < at('>Fiber<') &&
      at('>Fiber<') < at('Photograph a meal')
        ? ok('nutrition hub: sodium, caffeine, fiber — under the macros, above Photo/Describe')
        : bad('key micro row order');
    }
    // No colour, by source: the row's file names no signal token and no accent.
    // (A server render carries no NativeWind classes, so the source is where
    // the firewall can be checked.)
    const rowSource = readFileSync(
      new URL('../src/components/nutrition/day-micros.tsx', import.meta.url),
      'utf8'
    );
    const tailSource = readFileSync(
      new URL('../src/components/nutrition/key-micro-tail.tsx', import.meta.url),
      'utf8'
    );
    const code = (src) => src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    !/signal-|bg-pine|text-pine|border-pine/.test(code(rowSource)) &&
    !/signal-|bg-pine|text-pine|border-pine/.test(code(tailSource))
      ? ok('the micro row and the item tail use no signal colour and no accent')
      : bad('a micro surface took a colour');

    // The latte's caffeine, on its row in the meal screen.
    const flatWhite = db.get(`SELECT id FROM meals WHERE name = 'Flat white'`);
    const fw = render('meal-detail (key micro)', MealDetailScreen, { id: flatWhite.id });
    expect('meal-detail (key micro)', fw, ['145 mg caffeine']);
    // Sodium over a fifth of its limit, when there is no caffeine to show —
    // and one figure only: the soup's 21 g of fiber is not printed beside it.
    const soup = db.get(`SELECT id FROM meals WHERE name = 'Lentil soup'`);
    const soupHtml = render('meal-detail (key micro, sodium)', MealDetailScreen, { id: soup.id });
    expect('meal-detail (key micro, sodium)', soupHtml, ['1,150 mg sodium']);
    refute('meal-detail (key micro, sodium)', soupHtml, ['21 g fiber']);
  }
  {
    // The estimator's review table: the same tail at the live portion, and a
    // composite's header reading its parts' sum.
    const noop = () => {};
    const handlers = {
      onAmountChange: noop,
      onRemove: noop,
      onToggle: noop,
      onScale: noop,
      onScaleTo: noop,
      onScaleBegin: noop,
      onScaleEnd: noop,
      onCountChange: noop,
      onWholeChange: noop,
      onCountBegin: noop,
      onCountEnd: noop,
      onPiecesName: noop,
    };
    const row = (key, name, amount, micros, extra = {}) => ({
      key,
      name,
      foodId: null,
      food: undefined,
      confidence: 'medium',
      unit: 'g',
      base: {
        amount,
        kcal: 100,
        protein_g: 5,
        carbs_g: 5,
        fat_g: 5,
        fiber_g: null,
        micros: micros === null ? null : JSON.stringify(micros),
      },
      amountText: String(amount),
      ...extra,
    });
    const top = (r, components = []) => ({
      ...r,
      components,
      expanded: false,
      scaleFrom: null,
      pieces: null,
      wholeCount: null,
      countText: null,
      wholeText: null,
      countFrom: null,
    });
    const plate = render(
      'review plate (key micros)',
      ReviewItemsPlate,
      {},
      {
        rows: [
          top(row('latte', 'Latte', 360, { caffeine_mg: 126, sodium_mg: 130 }, { unit: 'ml' })),
          top(row('pizza', 'Pizza', 0, null), [
            row('crust', 'Crust', 200, { sodium_mg: 300 }),
            row('cheese', 'Cheese', 100, { sodium_mg: 250 }),
          ]),
        ],
        label: 'Items',
        emptyNote: 'x',
        handlers,
      }
    );
    expect('review plate (key micros)', plate, ['126 mg caffeine', '550 mg sodium']);
    refute('review plate (key micros)', plate, ['130 mg sodium']);
  }

  console.log('8. Check-off state renders');
  const milk = db.get(`SELECT id FROM grocery_items WHERE name = 'Milk'`);
  checkGroceryItem(db, milk.id);
  expect('grocery (with cart)', render('grocery (with cart)', GroceryScreen), ['In cart']);

  // -------------------------------------------------------------------------
  console.log('7b. The two CAPTURE screens — on this walk for the first time');
  {
    // Both used to `import { CameraView } from 'expo-camera'` at module scope,
    // which made them unloadable under node and therefore untestable. They now
    // go through the guarded seam (src/lib/media/camera.ts), so under node the
    // module is absent and each screen renders its ABSENT branch — which is
    // precisely the branch that has to be honest rather than a dead spinner.

    // a. The scanner, and the running list of recently logged barcodes
    //    (owner, 2026-08-14). `barcodeFood` was logged in the fixtures above.
    const scan = render('barcode-scan', BarcodeScanScreen);
    expect('barcode-scan', scan, [
      'Scan barcode',
      // The absence is a sentence, and it says the rest of the screen still works.
      'Scanning needs the next app build',
      'Anything below can still be logged',
      // THE FEATURE: name and brand, never the digits, and last time's portion.
      'Recently logged',
      'Render oat drink',
      'Oatly-ish',
      // A drink logged in millilitres (0047), printed under the DEFAULT volume
      // preference, which is oz — 250 ml ÷ 29.5735 = 8.5. The stored number is
      // still 250; only the reading converts, exactly as water already does.
      '8.5 oz',
    ]);
    // …and the same row under ml. Two renders rather than one assertion about a
    // formatter, because the preference reaching THIS screen is the thing that
    // could break, and it is invisible in a unit test of fmtAmount.
    refute('barcode-scan', scan, ['250 ml']);
    setUnitPreference(db, 'volume', 'ml');
    expect('barcode-scan (ml)', render('barcode-scan (ml)', BarcodeScanScreen), ['250 ml']);
    setUnitPreference(db, 'volume', 'oz');
    // A barcode number means nothing to a human, so the list never prints one;
    // and a food with no barcode is not on this list however recently it was
    // eaten — the query is narrowed to barcoded rows on purpose.
    refute('barcode-scan', scan, ['5060000000000', 'Render chicken']);

    // b. The estimator with no model key — unchanged behaviour, now covered.
    //    Slop pass 4 (docs/ai-slop-candidates-2026-09.md §11.F): the key gates
    //    said "…, then come back. Meanwhile, …" — the tail §11 cut from Compare
    //    and the time wheel. The route and what works offline are kept, and
    //    "Manual entry", a row the Log sheet now calls "Enter it manually", is
    //    lower-case: it names the act, not a label that no longer exists.
    const estimateNoKey = render('meal-estimate (no key)', MealEstimateScreen);
    expect('meal-estimate (no key)', estimateNoKey, [
      'Describe or snap',
      'AI meal estimation needs a model key',
      'Add a key in the Coach tab. Add food and manual entry work offline.',
    ]);
    refute('meal-estimate (no key)', estimateNoKey, ['come back', 'Meanwhile', 'Manual entry']);

    // The same gate on the meal's Adjust screen and on lab import. Neither was
    // rendered here before; both draw the no-key state from the first render,
    // because node has no key.
    const reviseNoKey = render('meal-revise (no key)', MealReviseScreen, { id: mealId });
    expect('meal-revise (no key)', reviseNoKey, [
      'Adjusting a meal in words needs a model key',
      'Add one in Settings › Coach. Editing items by hand works offline.',
    ]);
    refute('meal-revise (no key)', reviseNoKey, ['come back']);
    const labNoKey = render('lab-import (no key)', LabImportScreen);
    expect('lab-import (no key)', labNoKey, [
      'Reading a lab PDF needs a model key',
      // The privacy fact is the kept half, and "It’s" now names what it was:
      // the read is the one step that goes online.
      'Add a key in Settings › Coach. Reading the PDF is the only part of this that goes online; matching, reviewing and storing all happen on your phone.',
    ]);
    refute('lab-import (no key)', labNoKey, ['come back']);

    // c. With a key, the input phase — and `start=camera` (the Eat tab's Photo
    //    button) opening straight into the viewfinder. The key is an in-memory
    //    placeholder; rendering makes no model call, and none is made here.
    await apiKeyStore.setKey('render-test-key');
    expect('meal-estimate (input)', render('meal-estimate (input)', MealEstimateScreen), [
      'Describe the meal',
      'Take a photo',
      'Choose a photo',
    ]);
    const straightToCamera = render('meal-estimate (start=camera)', MealEstimateScreen, {
      start: 'camera',
    });
    expect('meal-estimate (start=camera)', straightToCamera, [
      // The camera phase, entered from the param rather than from a tap.
      'The camera needs the next app build',
      'Describe it instead',
    ]);
    // Never the spinner: `permission` stays null forever without the module, so
    // "Preparing the camera…" here would be a lie that never resolves.
    refute('meal-estimate (start=camera)', straightToCamera, ['Preparing the camera']);
    await apiKeyStore.clearKey();

    // d. HOME — regression cover for the safe-area round, which rewrapped
    //    src/components/status/status-control.tsx. This is as close as a server
    //    render gets: RN's `Modal` returns null without a DOM, so the sheet's
    //    BODY (and every other modal's) cannot be rendered here at all — the
    //    portal has nothing to mount into. What this does prove is that the
    //    status control still mounts around the rewrapped modal.
    const homeRender = render('home', HomeScreen);
    expect('home (after the ModalScreen rewrap)', homeRender, ['Today']);
    // A9 (2026-09-19): the Coach brief's whole block is one Pressable with an
    // accessibilityLabel that says where it goes, so the "Open chat" label
    // under it restated the control it sat on. The chevron stayed.
    refute('home (after the ModalScreen rewrap)', homeRender, ['Open chat']);
    // 0061: the mode picker is GONE from Home. Its chip named the mode on the
    // folio row ("Normal", "Travel") and its banner printed a directive above
    // the hero; both were the hardcoded layer the retirement removes.
    refute('home (modes retired)', homeRender, [
      'Set mode',
      'Normal',
      "Today's mode",
      'No training today',
    ]);
    // …and with no status open, the door beside the date reads STATUS and
    // nothing else on Home mentions one — which is most days.
    expect('home (no status)', homeRender, ['>Status</div>', 'Status: none set. Set one']);
    refute('home (no status)', homeRender, ['skips excused', 'readiness baselines exclude']);
  }

  // -------------------------------------------------------------------------
  console.log('7c-ii. The door names the status; its sheet holds age, baselines, the five');
  {
    const today = todayISODate();
    startStatus(getDb(), {
      label: 'Traveling',
      startDate: shiftISODate(today, -3),
      source: 'user',
    });

    // HOME (2026-09-23). The owner, on the device: "the message is there, but i
    // think it would be better if the status button just changed to say 'Sick'
    // or whatever the currently active status is." So the door beside the date
    // reads the status itself, and the mono line that sat above the hero is
    // GONE: the door is what keeps a running status visible without opening
    // anything now.
    const withStatus = render('home (traveling)', HomeScreen);
    expect('home (traveling)', withStatus, [
      // The door's visible word is the status, not "Status"…
      '>Traveling</div>',
      // …and its spoken label names it and says what a tap does.
      'Status: Traveling. Re-check or change',
    ]);
    refute('home (traveling)', withStatus, [
      '>Status</div>',
      // The line's own words and its re-ask target. Its facts moved into the
      // sheet's header (asserted on StatusFacts below).
      'Traveling since',
      'skips excused',
      'readiness baselines exclude',
      'Ask the Coach to re-check today',
      // A status carries no heroFocus and no tone. Nothing writes a sentence
      // on the owner's behalf about what a travel day should contain.
      'Adjust to the new time zone',
      'morning light',
    ]);

    // Both status components, rendered in isolation. The Coach tab is not in
    // this suite's screen list (it needs a KeyboardAvoidingView and a live chat
    // hook), so pure props are the only way its chrome gets covered at all.
    //
    // THE DOOR. Since 2026-09-21 the Coach tab reaches the five through the
    // door Home already had (the owner: they "need to be moved and put behind
    // another button"); since 2026-09-23 the door names what is on. With
    // nothing set it reads STATUS and NOTHING ELSE — the five words are behind
    // it.
    const doorOff = render(
      'status-control (Coach, nothing set)',
      StatusControl,
      {},
      {
        open: [],
        docked: true,
        onToggle() {},
        onEnd() {},
      }
    );
    expect('status-control (Coach, nothing set)', doorOff, [
      '>Status</div>',
      // The authored empty state, spoken: the door says there is nothing set
      // and that it is the way to set one, rather than going silent.
      'Status: none set. Set one',
    ]);
    refute('status-control (Coach, nothing set)', doorOff, [
      'Sick',
      'Traveling',
      'Injured',
      'Off day',
      'Night out',
    ]);

    // …and with one running, the door IS the status. The chip that stood beside
    // it until 2026-09-23 is gone, and with it the x and the re-ask target it
    // carried — both live on the sheet's rail now (asserted on StatusRail
    // below). The other four do not come back either.
    const doorOn = render(
      'status-control (Coach, traveling)',
      StatusControl,
      {},
      {
        open: [{ id: 's1', label: 'traveling', end_date: null }],
        docked: true,
        onToggle() {},
        onEnd() {},
      }
    );
    expect('status-control (Coach, traveling)', doorOn, [
      '>Traveling</div>',
      // Named in the spoken label too, so the state reaches a VoiceOver user
      // without opening anything either.
      'Status: Traveling. Re-check or change',
    ]);
    refute('status-control (Coach, traveling)', doorOn, [
      '>Status</div>',
      // No chip beside the door: neither its x nor its own re-ask target.
      'End Traveling',
      'aria-label="Traveling"',
      'Sick',
      'Injured',
      'Off day',
      'Night out',
    ]);

    // Several at once: the NEWEST by name (rows arrive newest-first) and the
    // rest as a count — a door that grew a word per status would be the rail
    // again. The spoken label names every one.
    const doorTwo = render(
      'status-control (two open)',
      StatusControl,
      {},
      {
        open: [
          { id: 's1', label: 'sick', end_date: null },
          { id: 's2', label: 'traveling', end_date: null },
        ],
        onToggle() {},
        onEnd() {},
      }
    );
    expect('status-control (two open)', doorTwo, [
      '>Sick</div>',
      '>+1</div>',
      'Status: Sick, Traveling. Re-check or change',
    ]);
    refute('status-control (two open)', doorTwo, ['>Traveling</div>', '>Status</div>']);

    // HOME's face is now the same face — and still never a chip, so the x,
    // which only a chip carries, is the thing that must be absent.
    const homeFace = render(
      'status-control (Home, sick)',
      StatusControl,
      {},
      {
        open: [{ id: 's1', label: 'sick', end_date: null }],
        onToggle() {},
        onEnd() {},
      }
    );
    expect('status-control (Home, sick)', homeFace, ['>Sick</div>']);
    refute('status-control (Home, sick)', homeFace, [
      '>Status</div>',
      'End Sick',
      'Off day',
      'Night out',
    ]);

    // A pending write suppresses the whole control, as it suppresses the
    // activity line: the loop is suspended on one decision.
    const hidden = render(
      'status-control (pending write)',
      StatusControl,
      {},
      {
        open: [{ id: 's1', label: 'sick', end_date: null }],
        docked: true,
        hidden: true,
        onToggle() {},
        onEnd() {},
      }
    );
    refute('status-control (pending write)', hidden, ['Status', 'Sick']);

    // THE SHEET'S HEADER — what only Home's line used to say: each status's
    // age, whether its skips count, and what it is doing to the baselines.
    // RN's `Modal` returns null without a DOM, so it is rendered directly, as
    // the rail is; and it reads the REAL database the way the sheet does, so
    // the count is the derivation's rather than a prop's. Traveling since three
    // days ago is four status days in the window, today included.
    const facts = render(
      'status-facts (the sheet header, traveling)',
      StatusFacts,
      {},
      {
        open: openStatuses(getDb(), today),
      }
    );
    expect('status-facts (the sheet header, traveling)', facts, [
      `Traveling since ${shortDate(shiftISODate(today, -3))}`,
      'skips excused',
      'readiness baselines exclude 4 status days',
    ]);
    // …and the sheet really mounts it. RN's Modal renders nothing server-side,
    // so Home's refutes above would pass whether or not the header were in the
    // sheet at all; the source is the one place that fact is visible here.
    const controlSource = readFileSync(
      new URL('../src/components/status/status-control.tsx', import.meta.url),
      'utf8'
    );
    /<ModalScreen>[\s\S]*<StatusFacts [^>]*open=\{open\}[^>]*\/>[\s\S]*<\/ModalScreen>/.test(
      controlSource
    )
      ? ok('the sheet mounts StatusFacts inside its ModalScreen')
      : bad('StatusFacts is not mounted inside the sheet');
    // An ordinary day prints nothing at all — not an empty line.
    const noFacts = render('status-facts (nothing open)', StatusFacts, {}, { open: [] });
    noFacts === ''
      ? ok('status-facts (nothing open) renders nothing')
      : bad('status-facts (nothing open) renders nothing', String(noFacts));

    // THE SHEET PATH. RN's `Modal` returns null without a DOM, so what the door
    // opens cannot be server-rendered from the control itself — the rail IS the
    // sheet's body (status-control.tsx renders exactly this), so it is asserted
    // directly. All five words survive the move, in their fixed order.
    const openRows = [
      { id: 's1', label: 'sick', end_date: null },
      { id: 's2', label: 'night out', end_date: today },
      { id: 's3', label: 'jet-lagged', end_date: null },
      { id: 's4', label: 'work crunch', end_date: null },
      { id: 's5', label: 'deadline week', end_date: null },
    ];
    const sheetOff = render(
      'status-rail (the sheet, nothing set)',
      StatusRail,
      {},
      {
        open: [],
        onToggle() {},
        onEnd() {},
      }
    );
    expect('status-rail (the sheet, nothing set)', sheetOff, [
      'Sick',
      'Traveling',
      'Injured',
      'Off day',
      'Night out',
    ]);

    const sheetOn = render(
      'status-rail (the sheet, five open)',
      StatusRail,
      {},
      {
        open: openRows,
        onToggle() {},
        onEnd() {},
      }
    );
    expect('status-rail (the sheet, five open)', sheetOn, [
      'Sick',
      'Jet-lagged',
      'Work crunch',
      // The x lives HERE now, and only here.
      'End Sick',
    ]);
    // …and so does the re-ask: the on-chip's own press target, under its own
    // spoken name, sharing an outline with its x. RNW emits no selected state
    // for a button, so ON is proved by the pairing — only an on-chip draws an x
    // beside its target. A server render cannot tap it; `toggleStatus` reads a
    // tap on a chip that has an openId as the re-ask.
    /aria-label="Sick"[^>]*>(?:(?!<\/button>)[\s\S])*<\/button><button aria-label="End Sick"/.test(
      sheetOn ?? ''
    )
      ? ok('status-rail (the sheet, five open): the on-chip keeps its re-ask target beside its x')
      : bad('status-rail (the sheet, five open): no re-ask target paired with the x');
    refute('status-rail (the sheet, five open)', sheetOn, [
      // MAX_EXTRA_CHIPS is two: the third typed status is counted on the door,
      // named in the sheet's header and in the Coach's state block, and the
      // rail stops rather than becoming a wall inside the sheet.
      'Deadline week',
      // Night out ends tonight by construction, so an x on it would be a
      // control that does nothing.
      'End Night out',
    ]);

    // THE END PROMPTS (2026-09-23). The owner: "the message for unchecking a
    // status feels weird but otherwise this is ok." The x SEEDS one of these
    // into the composer, and a server render cannot tap it, so the table is
    // pinned here. Each is what he would type — first person, ending in his own
    // sentence — never the mechanism narrated back at the Coach.
    const ADJUST = "Check what's up and adjust accordingly.";
    const endPrompts = {
      sick: `I'm feeling better. ${ADJUST}`,
      traveling: `I'm back home. ${ADJUST}`,
      injured: `My injury's better. ${ADJUST}`,
      // These two end tonight and no x is drawn on them, so nothing seeds them
      // today — pinned anyway, so the table cannot rot where nobody looks.
      'off day': `I'm back on it. ${ADJUST}`,
      'night out': `I'm home for the night. ${ADJUST}`,
      // A status the Coach recorded is free text, so "X is over." — the one
      // shape that reads for an adjective and a noun alike.
      'jet-lagged': `Jet-lagged is over. ${ADJUST}`,
      'work crunch': `Work crunch is over. ${ADJUST}`,
    };
    for (const [label, want] of Object.entries(endPrompts)) {
      const got = endPromptFor(label);
      got === want ? ok(`end prompt (${label}): "${got}"`) : bad(`end prompt (${label})`, got);
    }
    const unpinned = STATUS_CHIPS.filter((chip) => !(chip.label in endPrompts));
    unpinned.length === 0
      ? ok('every chip carries a pinned end prompt')
      : bad('end prompts not pinned', unpinned.map((chip) => chip.label).join(', '));

    // NIGHT OUT'S DRINKS STEPPER (items 61/80, 2026-10-21) — drawn in the sheet
    // in place of the rail, so rendered directly, as the rail is. The count,
    // what it records as figures, the four kinds, and Save / Back.
    const stepper = render(
      'drinks-panel (Night out, first time)',
      DrinksPanel,
      {},
      { initialCount: 2, initialKind: 'beer', editing: false, onSave() {}, onBack() {} }
    );
    expect('drinks-panel (Night out, first time)', stepper, [
      'How many drinks?',
      'One fewer drink',
      'One more drink',
      'standard drinks',
      '28 g alcohol · 306 kcal · 25.2 g carbs',
      'Beer',
      'Wine',
      'Spirits',
      'Cocktail',
      'Save Night out, 2 drinks',
      'Back to the statuses',
    ]);
    refute('drinks-panel (Night out, first time)', stepper, ['limit', 'too many', 'adjust']);
    const recount = render(
      'drinks-panel (re-count, at zero)',
      DrinksPanel,
      {},
      { initialCount: 0, initialKind: 'wine', editing: true, onSave() {}, onBack() {} }
    );
    expect('drinks-panel (re-count, at zero)', recount, ['nothing logged', 'Save 0 drinks']);
    // The morning after (2026-10-21 review): last night's count, re-counted
    // on last night — and the panel says so instead of "Logged on today".
    const lastNight = render(
      'drinks-panel (the morning after)',
      DrinksPanel,
      {},
      { initialCount: 4, initialKind: 'beer', editing: true, lastNight: true, onSave() {}, onBack() {} }
    );
    expect('drinks-panel (the morning after)', lastNight, [
      'last night’s count',
      'Save 4 drinks',
    ]);
    refute('drinks-panel (the morning after)', lastNight, ['Logged on today']);
    /const \{ recorded, lastNight, night \} = currentNightOutDrinks\(\);/.test(controlSource) &&
    /const editing = chip\.openId !== null \|\| lastNight;/.test(controlSource)
      ? ok('the sheet opens last night’s count as a re-count the morning after')
      : bad('status-control does not carry last night’s Night out');
    /<StatusRail[\s\S]*if \(chip\.asksDrinks\)[\s\S]*setDrinks\(/.test(controlSource) &&
    /onToggle\(drinks\.chip, input, drinks\.night\)/.test(controlSource)
      ? ok('the sheet opens the stepper for Night out and hands its count, and the night it opened on, to onToggle')
      : bad('status-control no longer routes Night out through the stepper');

    // The next morning's fact, under the pillars — and Home passes it.
    const strip = render(
      'readiness-strip (alcohol last night)',
      ReadinessStrip,
      {},
      {
        readiness: { level: 'good', label: 'Ready', detail: 'HRV 50 ms' },
        pillars: [{ label: 'Recovery', level: 'good' }],
        alcoholLine: 'Alcohol last night — 4 standard drinks · 56 g',
      }
    );
    expect('readiness-strip (alcohol last night)', strip, [
      'Alcohol last night — 4 standard drinks · 56 g',
    ]);
    const homeSource = readFileSync(new URL('../app/(tabs)/index.tsx', import.meta.url), 'utf8');
    /alcoholLine=\{alcoholLastNightLine\(readiness\.alcoholLastNight\)\}/.test(homeSource)
      ? ok('Home hands the readiness view’s alcoholLastNight to the strip')
      : bad('Home does not pass the alcohol line');

    getDb().run('DELETE FROM day_statuses');
  }

  // -------------------------------------------------------------------------
  console.log('7d. Create a food — the Describe-it path and the mark it leaves (C2)');
  {
    // a. NO KEY. The field is replaced by a sentence saying so and what still
    //    works; the form below is untouched, because typing the food in by hand
    //    is the path this screen already was. Never a live-looking box that
    //    answers nothing.
    const noKey = render('food-new (no key)', FoodNewScreen, { name: 'Overnight oats' });
    expect('food-new (no key)', noKey, [
      'Create a food',
      'Describe it',
      'Describing a food needs a model key',
      'everything below works without it',
      'Overnight oats', // the failed search still prefills the name
      'Solid · g', // …and the whole manual form is still there
      'Save food',
    ]);
    refute('food-new (no key)', noKey, ['Fill from description', 'Estimated by the model']);

    // b. WITH A KEY, the field and its control. No model call is made here —
    //    rendering does not describe anything — and the point of the count is
    //    the C2 guarantee: the path up to the Save tap writes nothing at all.
    const foodsBefore = db.get('SELECT count(*) AS n FROM foods').n;
    await apiKeyStore.setKey('render-test-key');
    const withKey = render('food-new (key set)', FoodNewScreen);
    expect('food-new (key set)', withKey, [
      'Describe it',
      'Fill from description',
      'Costco rotisserie chicken thigh, skin on', // the placeholder, in the owner's own words
    ]);
    refute('food-new (key set)', withKey, ['Describing a food needs a model key']);
    await apiKeyStore.clearKey();
    db.get('SELECT count(*) AS n FROM foods').n === foodsBefore
      ? ok('food-new wrote no catalog row on either render — nothing is saved without Save')
      : bad('food-new wrote a row on mount');

    // c. THE MARK, in the catalog. A described entry says `est` wherever it
    //    appears — typography, never a hue — so an inferred number is never
    //    read as one the owner typed. Favorited so it shows with no query, the
    //    search field's text being state this render cannot set.
    const described = createFood(db, {
      name: 'Render described soup',
      kcal_100g: 60,
      source: 'ai',
    });
    setFoodFavorite(db, described, true);
    const search = render('food-search (an ai entry)', FoodSearchScreen);
    expect('food-search (an ai entry)', search, [
      'Render described soup',
      '  est</span>', // the tag itself, not the letters in some other word
    ]);
    // The typed foods beside it carry no mark — the tag means something only if
    // it is not on everything.
    search !== null && (search.match(/ {2}est<\/span>/g) || []).length === 1
      ? ok('food-search (an ai entry): exactly one row is marked est')
      : bad('the est tag is on the wrong number of rows');
  }

  // -------------------------------------------------------------------------
  console.log('8b. Folders (0035) — the filter strip, the drawer, and the unfiled place');
  {
    const dinners = createFolder(db, 'Dinners');
    moveRecipeToFolder(db, adobo, dinners);

    const book = render('recipes (with folders)', RecipesScreen);
    expect('recipes (with folders)', book, [
      'Folders',
      'Dinners',
      'Unfiled', // the draft recipe is still in no folder, so the chip is drawn
      'Manage',
      'Chicken Adobo',
      'Mystery stew',
    ]);
    // The strip is a FILTER, never an editor: nothing destructive may appear
    // on the book, or a scoping tap and a deleting tap share a row.
    refute('recipes (with folders)', book, ['Delete folder', 'Confirm delete']);

    // Scoped by the route param the folders screen pushes with.
    const scoped = render('recipes (scoped)', RecipesScreen, { folder: dinners });
    expect('recipes (scoped)', scoped, ['Chicken Adobo']);
    refute('recipes (scoped)', scoped, ['Mystery stew']);

    expect('recipe-folders (populated)', render('recipe-folders', RecipeFoldersScreen), [
      'Dinners',
      '1 recipe',
      'recipe is unfiled', // "Unfiled is a place, not a backlog"
    ]);

    // A filed recipe says where it lives; an unfiled one says so too.
    expect(
      'recipe-detail (filed)',
      render('recipe-detail (filed)', RecipeDetailScreen, { id: adobo }),
      ['Dinners', 'Edit in words']
    );
    expect(
      'recipe-detail (unfiled)',
      render('recipe-detail (unfiled)', RecipeDetailScreen, { id: draft }),
      ['Unfiled']
    );
  }

  console.log('8c. recipe-revise — the honest no-key state, and the recipe it is about');
  {
    // No model key exists under node, so the screen must say what is missing
    // rather than drawing a field that cannot work.
    const html = render('recipe-revise (no key)', RecipeReviseScreen, { id: adobo });
    expect('recipe-revise (no key)', html, [
      'Edit in words',
      'needs a model key',
      'Settings › Coach',
      // Slop pass 4 (§11.F): the route and the offline fact, without ", then
      // come back".
      'Add one in Settings › Coach. The recipe editor works offline.',
    ]);
    // And nothing may look like a write is pending.
    refute('recipe-revise (no key)', html, ['Save changes', 'Apply', 'come back']);
  }

  // -------------------------------------------------------------------------
  // The body figure (contoured rewrite, 2026-08-12 — the third round). What a
  // server render CAN prove about a drawing is narrow, but it is exactly the
  // part that keeps failing: the figure's ~490 positioned views cost nothing to
  // VoiceOver, so the whole burden of saying WHICH muscle is in WHICH state
  // falls on words — the roll call, the section tally, and the ramp's two named
  // ends. Those are text, so they are assertable here. Everything about how it
  // LOOKS stays an on-device check (memory: verify on device, not web).
  console.log('9. Muscle freshness — the figure key states its case in words');
  {
    const empty = render('exercise hub (never trained)', ExerciseScreen);
    expect('exercise hub (never trained)', empty, [
      'Muscle freshness',
      '16 of 16 fresh',
      // The scale beside the figure names both ends. A continuous opacity ramp
      // with no stated direction is a ramp anyone can read backwards.
      'Fresh',
      'Spent',
      // Empty is AUTHORED, never blank — and "nothing logged" is not the same
      // fact as "nothing depleted", which the model renders identically.
      'No training in the last 14 days, so every muscle reads fresh.',
    ]);
    // A9: the caveat used to end "...Log a session and the figure starts
    // fading." — the UI narrating itself back rather than stating a fact.
    // Must not silently come back.
    refute('exercise hub (never trained)', empty, [
      'Log a session and the figure starts fading.',
      // A9 (2026-09-19): Recent sessions' empty ran "Nothing logged yet — start
      // a workout above.", pointing at the control it sits under. Same shape as
      // the saved-workout card's "add some from Saved workouts below", cut in
      // the first A9 round.
      'start a workout above',
    ]);

    logWorkout(
      db,
      { date: today, name: 'Render push', kind: 'strength', notes: null },
      Array.from({ length: 6 }, () => ({
        exercise: 'Bench',
        exerciseId: 'barbell-bench-press',
        reps: 8,
        weightKg: 80,
      }))
    );

    const worked = render('exercise hub (after a session)', ExerciseScreen);
    figureDrew('exercise hub', worked);
    expect('exercise hub (after a session)', worked, [
      'Fatigued', // the WORD is the primary carrier: the two fills are 1.03:1
      'Chest', // ...and the muscle is NAMED, which the old figure never did
    ]);
    // The tally moved off 16/16, and the never-logged caveat retired with it.
    refute('exercise hub (after a session)', worked, [
      '16 of 16 fresh',
      'No training in the last 14 days, so every muscle reads fresh.',
    ]);

    const pushed = render('muscle-freshness', MuscleFreshnessScreen);
    figureDrew('muscle-freshness', pushed);
    expect('muscle-freshness (pushed)', pushed, [
      'Muscle freshness',
      'Per muscle',
      'Fatigued',
      'Chest',
    ]);
    // Nothing is hand-set yet, so nothing claims to be.
    refute('muscle-freshness (pushed)', pushed, ['Set by hand']);

    // An asserted number and a derived one must not wear the same face
    // (the rule `resolved_by` applies to recipe lines, 0034). Anchor a muscle
    // and the row says so — 0037's whole visible contract.
    setMuscleAnchor(db, 'calves', 20);
    const anchored = render('muscle-freshness (hand-set)', MuscleFreshnessScreen);
    expect('muscle-freshness (hand-set)', anchored, ['Set by hand', 'Calves']);
    clearMuscleAnchor(db, 'calves');
    refute(
      'muscle-freshness (cleared)',
      render('muscle-freshness (cleared)', MuscleFreshnessScreen),
      ['Set by hand']
    );

    // exercise-detail is the figure's ONLY `mode: 'muscles'` consumer, and the
    // one screen in this area carrying a design firewall: which muscles a
    // MOVEMENT works is a fact about an exercise, never a biological state, so
    // it must never wear the signal green (00-design-spec.md §2). It joined the
    // walk on 2026-08-25 — see db/render-stubs/exercise-images.mjs for the
    // static-require blocker that had kept it off.
    const detail = render('exercise detail', ExerciseDetailScreen, { id: 'barbell-bench-press' });
    figureDrew('exercise detail', detail);
    expect('exercise detail', detail, [
      'Muscles worked',
      'Primary',
      'Assists',
      'Chest',
      // A9 (2026-09-19): one session is on record, so the e1rm chart has one
      // point and cannot draw a trend (it needs `series.length >= 2`). The
      // sentence states that requirement instead of narrating the chart's
      // arrival — it used to read "Log a couple of weighted sessions and the
      // estimated-1RM trend appears here."
      'An estimated-1RM trend needs two weighted sessions.',
    ]);
    // The firewall, asserted rather than asserted-about: the freshness green
    // must not appear anywhere in this screen's markup.
    refute('exercise detail', detail, [
      '#185A36',
      '#185a36',
      'the estimated-1RM trend appears here',
    ]);

    // -----------------------------------------------------------------------
    // 2026-09-23 — what a weight counts (0062), and trends and PRs per
    // exercise. Owner: "indicate whether weight is per arm, total, etc." and
    // "trends, prs, etc for exercises (i.e. fitbod)".
    expect('exercise detail (load basis + records)', detail, [
      // The basis, stated and correctable, with what it means in words.
      'Weight',
      'Total',
      'The whole load. A barbell counts the bar.',
      'Change',
      // The fuller records grid, and the sections Fitbod has that ARC lacked.
      'Session volume',
      'Most reps',
      'Sessions',
      'Trend',
      'Best at each rep count',
      '8 reps',
      'History',
    ]);
    // ARC's reading, so nothing claims the owner set it.
    refute('exercise detail (load basis + records)', detail, ['Set by you']);
    setExerciseLoadBasis(db, 'barbell-bench-press', 'per_side');
    const corrected = render('exercise detail (corrected basis)', ExerciseDetailScreen, {
      id: 'barbell-bench-press',
    });
    expect('exercise detail (corrected basis)', corrected, ['Per side', 'Set by you']);
    setExerciseLoadBasis(db, 'barbell-bench-press', null);

    // A push-up's grid was three em-dashes for ever; its records are reps.
    const pushUp = render('exercise detail (push-up)', ExerciseDetailScreen, { id: 'push-up' });
    expect('exercise detail (push-up)', pushUp, ['Most reps', 'Session reps']);
    // No weight figure to describe, no rep-max table for a load it never carries.
    refute('exercise detail (push-up)', pushUp, ['Best at each rep count', 'Set by you']);

    // The hub's way into any exercise's history: every movement trained, with
    // its latest top set saying what its weight counts.
    const hubWithExercises = render('exercise hub (exercises list)', ExerciseScreen);
    expect('exercise hub (exercises list)', hubWithExercises, [
      'Exercises',
      'Barbell Bench Press',
      'lb total',
      'Open records and history.',
    ]);

    // The live logger (and the session editor, the same screen): the load
    // column's heading says what the number counts. Two lines — unit over basis.
    const live = render('workout-live (headings)', WorkoutLiveScreen, {
      exerciseIds: 'dumbbell-bench-press,barbell-bench-press,lat-pulldown',
    });
    expect('workout-live (headings)', live, ['lb\nPer hand', 'lb\nTotal', 'lb\nStack']);
    const benchSession = db.get(
      `SELECT w.id FROM workouts w JOIN workout_sets s ON s.workout_id = w.id
        WHERE s.exercise_id = 'barbell-bench-press' ORDER BY w.created_at DESC LIMIT 1`
    );
    expect(
      'workout-live (session editor)',
      render('workout-live (session editor)', WorkoutLiveScreen, { workoutId: benchSession.id }),
      ['Session', 'lb\nTotal']
    );
    // A session resumed from a build that still stamped PRs (item 87 retired
    // the stamp): the old fields are dropped, and no PR line is drawn.
    saveWorkoutDraft(db, 'live', {
      version: DRAFT_VERSION,
      startedAt: Date.now() - 20 * 60_000,
      routineId: null,
      ingestId: null,
      restEndsAt: null,
      away: false,
      blocks: [
        {
          key: 1,
          exerciseId: 'barbell-bench-press',
          name: 'Barbell Bench Press',
          loggingType: 'weight_reps',
          measures: 'reps,load',
          mechanic: 'compound',
          restSec: 180,
          prev: [],
          bestE1rm: null,
          linkedToNext: false,
          sets: [
            {
              key: 1,
              weight: '225',
              reps: '5',
              rpe: '',
              time: '',
              distance: '',
              setType: 'normal',
              done: true,
              pr: true,
              prKinds: ['e1rm', 'weight', 'rep_max'],
            },
          ],
        },
      ],
    });
    const resumedPr = render('workout-live (resumed, old PR stamp)', WorkoutLiveScreen, {
      resume: '1',
    });
    expect('workout-live (resumed, old PR stamp)', resumedPr, ['Barbell Bench Press']);
    refute('workout-live (resumed, old PR stamp)', resumedPr, [
      '>PR<',
      'best e1RM, heaviest',
      'Set 1: best',
    ]);
    clearWorkoutDraft(db, 'live');

    // Review fixes (2026-09-23). A pull-up at bodyweight — how most are done —
    // had no trend (it opened on an empty e1RM chart), and its rep-max table
    // said "Nothing logged yet." over three sessions. Dated in the past, with
    // created_at moved to match, so no freshness reading on this walk moves.
    const pastSession = (date, sets, away) => {
      const id = logWorkout(db, { date, kind: 'strength', ...(away ? { away: true } : {}) }, sets);
      db.run('UPDATE workouts SET created_at = ? WHERE id = ?', [`${date}T12:00:00.000Z`, id]);
    };
    const pull = (reps) => ({ exercise: 'Pull-Up', exerciseId: 'pull-up', reps, weightKg: null });
    pastSession('2025-03-01', [pull(8), pull(7)]);
    pastSession('2025-03-03', [pull(9), pull(8)]);
    pastSession('2025-03-05', [pull(11), pull(9)]);
    const pullUp = render('exercise detail (bodyweight pull-up)', ExerciseDetailScreen, {
      id: 'pull-up',
    });
    expect('exercise detail (bodyweight pull-up)', pullUp, [
      'Most reps',
      'Session reps',
      // The Trend opens on reps, and says which way they are going — first in
      // the hub row's own words, on every range chip (review, 2026-09-25).
      'aria-label="up 29 percent on the previous 2 sessions"',
      '11 reps',
      'No sets with added weight yet.',
    ]);
    refute('exercise detail (bodyweight pull-up)', pullUp, [
      'An estimated-1RM trend needs two weighted sessions.',
      'Nothing logged yet.',
      // Three home sessions opening on All: "the first 2 on record" ARE the
      // previous 2, so the range line would only repeat the figure above it.
      'on the first 2 sessions on record',
    ]);
    // A friendlier bar elsewhere, logged last: the large figure is the home
    // session the "+29%" is about, and says so.
    pastSession('2025-03-07', [pull(15)], true);
    expect(
      'exercise detail (pull-up, away last)',
      render('exercise detail (pull-up, away last)', ExerciseDetailScreen, { id: 'pull-up' }),
      ['Latest at home', '11 reps', 'aria-label="up 29 percent on the previous 2 sessions"']
    );

    // Sets of fifteen carry no e1RM. The hub reads "+10%" from the top weight,
    // so the screen it opens must open on that chart, not an empty e1RM one.
    const ext = (weightKg) => ({
      exercise: 'Leg Extension',
      exerciseId: 'leg-extension',
      reps: 15,
      weightKg,
    });
    pastSession('2025-03-02', [ext(50)]);
    pastSession('2025-03-04', [ext(55)]);
    const legExt = render('exercise detail (high reps)', ExerciseDetailScreen, {
      id: 'leg-extension',
    });
    expect('exercise detail (high reps)', legExt, [
      'Latest',
      'aria-label="up 10 percent on the previous session"',
    ]);
    refute('exercise detail (high reps)', legExt, [
      'An estimated-1RM trend needs two weighted sessions.',
      'An estimated 1RM needs a set of 12 reps or fewer',
    ]);

    // A9: routine-edit is the one screen-render-covered survivor of the
    // retired "routine" vocabulary — the noun everywhere else is "saved
    // workout" (renamed 2026-08-11). Its empty-exercises line said "add the
    // movements this routine runs...", teaching a form whose own fields
    // (Sets / Rep low / Rep high) already say the same thing. Cut to the
    // bare fact, in the current noun.
    const newRoutine = render('routine-edit (new)', RoutineEditScreen);
    expect('routine-edit (new)', newRoutine, [
      'New saved workout',
      'Exercises',
      'No exercises yet.',
      'Add exercise',
    ]);
    refute('routine-edit (new)', newRoutine, ['movements this routine runs', 'routine']);

    // Reorder in the saved-workout editor (owner, 2026-09-23: "be able to
    // reorder exercises in a workout"). The editor could only append and
    // remove; it now has the live logger's Order mode. The whole screen proves
    // the door on its first frame; the mode itself is pressed through below.
    refute('routine-edit (new)', newRoutine, ['Reorder']);
    const upperId = createRoutine(db, {
      name: 'Upper B',
      notes: null,
      exercises: [
        { exerciseId: 'barbell-bench-press', targetSets: 4, repLow: 5, repHigh: 8, restSec: 180 },
        { exerciseId: 'barbell-row', targetSets: 4, repLow: 6, repHigh: 10, restSec: 150 },
        { exerciseId: 'plank', targetSets: 3, repLow: null, repHigh: null, restSec: null },
      ],
    });
    const upper = render('routine-edit (editing)', RoutineEditScreen, { id: upperId });
    expect('routine-edit (editing)', upper, [
      'Edit saved workout',
      'aria-label="Reorder exercises"',
      'Barbell Bench Press',
      'value="180"',
      'Save workout',
    ]);
    // The fields are what reorder mode folds away; until it is on, no arrows.
    refute('routine-edit (editing)', upper, ['aria-label="Move Barbell Bench Press up"']);

    const soloId = createRoutine(db, {
      name: 'One thing',
      notes: null,
      exercises: [
        { exerciseId: 'plank', targetSets: 3, repLow: null, repHigh: null, restSec: null },
      ],
    });
    // One line is nothing to put in order — the door is not drawn.
    refute(
      'routine-edit (one line)',
      render('routine-edit (one line)', RoutineEditScreen, { id: soloId }),
      ['Reorder']
    );

    // Reorder mode through the editor's OWN wiring. RoutineLinesSection is the
    // editor's list section, a hook-free function of the list state the editor
    // holds, and ExerciseOrder / ReorderToggle are hook-free too. So, as with the
    // mission row (§ further down), the element tree is walked and the real Reorder button
    // and the real arrow are pressed: each press runs the section's own
    // `dispatch` call, and the action goes through routineListReducer, the
    // reducer the editor passes to useReducer. Drop the Order plate from the
    // section, flip a direction or unwire the toggle, and this fails.
    const findEl = (node, match) => {
      if (node === null || node === undefined || typeof node !== 'object') return null;
      if (match(node)) return node;
      for (const child of React.Children.toArray(node.props?.children ?? [])) {
        const hit = findEl(child, match);
        if (hit) return hit;
      }
      return null;
    };
    const labelled = (label) => (el) => el.props?.accessibilityLabel === label;
    let list = openRoutineList(getRoutine(db, upperId));
    const section = () =>
      RoutineLinesSection({
        state: list,
        dispatch: (action) => {
          list = routineListReducer(list, action);
        },
        onAddExercise: () => {},
      });
    const drawList = (name) =>
      render(
        name,
        RoutineLinesSection,
        {},
        {
          state: list,
          dispatch: () => {},
          onAddExercise: () => {},
        }
      );
    const pressToggle = (label) => {
      const toggle = findEl(section(), (el) => el.type === ReorderToggle);
      const button = toggle && findEl(ReorderToggle(toggle.props), labelled(label));
      if (button) button.props.onPress();
      else bad(`routine-edit list: no "${label}" button to press`);
    };
    const pressArrow = (label) => {
      const plate = findEl(section(), (el) => el.type === ExerciseOrder);
      const arrow = plate && findEl(ExerciseOrder(plate.props), labelled(label));
      if (arrow) arrow.props.onPress();
      else bad(`routine-edit list: no "${label}" arrow to press`);
    };

    const fieldsHtml = drawList('routine-edit list (fields)');
    expect('routine-edit list (fields)', fieldsHtml, [
      'aria-label="Reorder exercises"',
      'aria-label="Target sets for Barbell Bench Press"',
      'aria-label="Remove Plank"',
    ]);
    refute('routine-edit list (fields)', fieldsHtml, ['aria-label="Move Barbell Bench Press']);

    // Press Reorder: the Order plate takes the Exercises plate's place.
    pressToggle('Reorder exercises');
    showsOrder(list)
      ? ok('routine-edit list: pressing Reorder puts the editor in Order mode')
      : bad('routine-edit list: Reorder did not switch the mode');
    const ordered = drawList('routine-edit list (reorder mode)');
    expect('routine-edit list (reorder mode)', ordered, [
      'aria-label="Done reordering exercises"',
      'aria-label="Move Barbell Bench Press, 4 sets of 5 to 8, 180 seconds rest, down"',
      'aria-label="Move Barbell Row, 4 sets of 6 to 10, 150 seconds rest, up"',
      'aria-label="Move Plank, 3 sets, up"',
      // The targets the fields held, drawn in mono under each name.
      '4 × 5–8 · 180 s rest',
      '4 × 6–10 · 150 s rest',
      '>3 sets<',
      'Add exercise',
    ]);
    // The fields fold away: no target inputs, no remove buttons.
    refute('routine-edit list (reorder mode)', ordered, [
      'aria-label="Target sets for',
      'aria-label="Remove ',
      'A superset moves as one',
      '>Superset<',
    ]);
    // Top's up and bottom's down are drawn off, never hidden.
    const offArrows = (ordered ?? '').split('aria-disabled="true"').length - 1;
    offArrows === 2
      ? ok('routine-edit list (reorder mode): the two end arrows are drawn disabled')
      : bad('routine-edit list (reorder mode): disabled arrows', String(offArrows));

    // Press the plank's up arrow once: it lands between the bench and the row.
    pressArrow('Move Plank, 3 sets, up');
    const order = () => list.lines.map((l) => l.exerciseId).join();
    order() === 'barbell-bench-press,plank,barbell-row'
      ? ok('routine-edit list: the plank’s up arrow moves it one place up')
      : bad('routine-edit list: order after the up arrow', order());
    const movedHtml = drawList('routine-edit list (reorder mode, moved)') ?? '';
    const at = (label) => movedHtml.indexOf(`aria-label="Move ${label}, `);
    at('Barbell Bench Press') < at('Plank') && at('Plank') < at('Barbell Row')
      ? ok('routine-edit list (reorder mode, moved): Bench, Plank, Row — drawn in the new order')
      : bad(
          'routine-edit list (reorder mode, moved): order',
          [at('Barbell Bench Press'), at('Plank'), at('Barbell Row')].join()
        );

    // Press Done: the fields come back, in the new order, with every target.
    pressToggle('Done reordering exercises');
    !showsOrder(list)
      ? ok('routine-edit list: pressing Done leaves Order mode')
      : bad('routine-edit list: Done did not leave Order mode');
    const backHtml = drawList('routine-edit list (after Done)') ?? '';
    const field = (name) => backHtml.indexOf(`aria-label="Target sets for ${name}"`);
    expect('routine-edit list (after Done)', backHtml, ['value="180"', 'value="150"']);
    field('Barbell Bench Press') < field('Plank') && field('Plank') < field('Barbell Row')
      ? ok('routine-edit list (after Done): the fields return in the order just set')
      : bad(
          'routine-edit list (after Done): order',
          [field('Barbell Bench Press'), field('Plank'), field('Barbell Row')].join()
        );

    // One movement twice (a top set and a back-off line): in Order mode the
    // two rows must read differently, drawn and spoken, or the owner cannot
    // tell which one he is moving.
    const bench = { exerciseId: 'barbell-bench-press', exerciseName: 'Barbell Bench Press' };
    let twice = openRoutineList({
      id: 'twice',
      name: 'Push day',
      notes: null,
      archived: false,
      exercises: [
        { ...bench, primaryMuscles: ['chest'], targetSets: 1, repLow: 3, repHigh: 3, restSec: 240 },
        { ...bench, primaryMuscles: ['chest'], targetSets: 3, repLow: 8, repHigh: 12, restSec: 90 },
      ],
    });
    twice = routineListReducer(twice, { type: 'toggle-order' });
    expect(
      'routine-edit list (one movement twice)',
      render(
        'routine-edit list (one movement twice)',
        RoutineLinesSection,
        {},
        {
          state: twice,
          dispatch: () => {},
          onAddExercise: () => {},
        }
      ),
      [
        '1 × 3 · 240 s rest',
        '3 × 8–12 · 90 s rest',
        'aria-label="Move Barbell Bench Press, 1 set of 3, 240 seconds rest, down"',
        'aria-label="Move Barbell Bench Press, 3 sets of 8 to 12, 90 seconds rest, up"',
      ]
    );
    deleteRoutine(db, upperId);
    deleteRoutine(db, soloId);

    // -----------------------------------------------------------------------
    // The Resume card (0045, owner 2026-09-14). The hub is where the app lands
    // after iOS killed it mid-session, so the offer to come back has to be on
    // the first frame — which is exactly what a server render can prove.
    refute('exercise hub (no draft)', worked, ['Session in progress', 'Resume']);

    saveWorkoutDraft(db, 'live', {
      version: DRAFT_VERSION,
      startedAt: Date.now() - 12 * 60_000,
      routineId: null,
      restEndsAt: null,
      blocks: [
        {
          key: 1,
          exerciseId: 'barbell-bench-press',
          name: 'Barbell Bench Press',
          loggingType: 'weight_reps',
          mechanic: 'compound',
          restSec: 180,
          prev: [],
          bestE1rm: null,
          linkedToNext: false,
          sets: [
            { key: 1, weight: '80', reps: '8', rpe: '', setType: 'normal', done: true, pr: false },
            { key: 2, weight: '80', reps: '8', rpe: '', setType: 'normal', done: true, pr: false },
            { key: 3, weight: '80', reps: '', rpe: '', setType: 'normal', done: false, pr: false },
          ],
        },
      ],
    });
    const resuming = render('exercise hub (draft waiting)', ExerciseScreen);
    expect('exercise hub (draft waiting)', resuming, [
      'Session in progress',
      'Barbell Bench Press',
      // What is in it, and how long it has been sitting there — a session
      // abandoned days ago is resumable, but the user has to be told which
      // session they are picking up.
      '2 sets logged',
      // The age is measured from the last WRITE, not from the session's start:
      // "how long has this been sitting here" is the question the card answers,
      // and it was just written. Clamped at zero, so a SQLite/`Date.now()` skew
      // can never print "in 0 minutes" (the Windows trap, CLAUDE.md house rules).
      'just now',
      'Resume',
    ]);

    // A draft with structure but nothing typed IS offered (reversed 2026-09-23).
    // It used to be dropped as reproducible — but leaving the logger no longer
    // discards, and a saved workout started, warmed up for and left to check
    // Home came back as nothing, its start instant gone with it.
    saveWorkoutDraft(db, 'live', {
      version: DRAFT_VERSION,
      startedAt: Date.now(),
      routineId: null,
      restEndsAt: null,
      blocks: [
        {
          key: 1,
          exerciseId: 'barbell-row',
          name: 'Barbell Row',
          loggingType: 'weight_reps',
          mechanic: 'compound',
          restSec: 180,
          prev: [],
          bestE1rm: null,
          linkedToNext: false,
          sets: [
            { key: 1, weight: '', reps: '', rpe: '', setType: 'normal', done: false, pr: false },
          ],
        },
      ],
    });
    expect(
      'exercise hub (untouched draft)',
      render('exercise hub (untouched draft)', ExerciseScreen),
      ['Session in progress', 'Barbell Row', 'Nothing logged yet', 'Resume']
    );
    clearWorkoutDraft(db, 'live');

    // -----------------------------------------------------------------------
    // Ingested workouts (0054, backlog D3). Two rows the watch wrote: a walk,
    // which ARC infers a load from, and a strength session, which it refuses to
    // guess at and asks about instead. The hub has to draw BOTH answers on the
    // first frame, and neither may read as the other.
    const nowMs = Date.now();
    const hkSpan = (endsMinAgo, minutes) => {
      const end = new Date(nowMs - endsMinAgo * 60_000);
      return {
        startTime: new Date(end.getTime() - minutes * 60_000).toISOString(),
        endTime: end.toISOString(),
      };
    };
    upsertWearableRows(db, [
      {
        date: todayISODate(),
        metricType: 'workout',
        value: 45,
        unit: 'min',
        sourceDevice: 'garmin',
        sourceRawId: 'render-walk',
        ...hkSpan(60, 45),
        metadata: { activity: 'Walking', activity_type_raw: 52, kcal: 180 },
      },
      {
        date: todayISODate(),
        metricType: 'workout',
        value: 47,
        unit: 'min',
        sourceDevice: 'garmin',
        sourceRawId: 'render-lift',
        ...hkSpan(240, 47),
        metadata: { activity: 'Strength training', activity_type_raw: 50, kcal: 410 },
      },
    ]);
    const ingested = render('exercise hub (ingested workouts)', ExerciseScreen);
    expect('exercise hub (ingested workouts)', ingested, [
      // The blank — a question, with the span it will prefill and the one tap
      // that answers it.
      'From your watch',
      'Strength training from Apple Health',
      '47 min',
      'muscles unknown',
      'Log sets',
      // …and the inference, which must NOT wear the face of a logged set.
      'Part inferred from Apple Health workouts',
    ]);
    // The walk is inferred, never asked about: a question ARC can answer itself
    // is not a question.
    refute('exercise hub (ingested workouts)', ingested, ['Walking from Apple Health']);
    expect(
      'muscle-freshness (part inferred)',
      render('muscle-freshness (part inferred)', MuscleFreshnessScreen),
      ['Part inferred']
    );
    db.run(`DELETE FROM wearable_data WHERE metric_type = 'workout'`);
  }

  // -------------------------------------------------------------------------
  // The execution record with a real, YOUNG record behind it — the state a
  // brand-new install is actually in, and the one the standing rule is about:
  // three days of history must SAY three days, not draw a fortnight of nothing.
  //
  // The fixture is deliberately lopsided: one protocol item done every day, one
  // never done. That is the shape the screen exists to name — a protocol whose
  // items are not getting done is a protocol to change.
  console.log('10. Mission — the execution record behind Data’s Mission row');
  {
    const day = (n) => {
      const d = new Date();
      d.setDate(d.getDate() - n);
      return todayISODate(d);
    };
    const settledDays = [day(3), day(2), day(1)];

    createProtocolWithVersion(
      db,
      { name: 'Morning stack', type: 'supplement_stack' },
      {
        items: [
          { title: 'Creatine', scheduled_time: '07:00', dose: '5 g', notes: null },
          { title: 'Magnesium', scheduled_time: '21:00', dose: '400 mg', notes: null },
        ],
      }
    );
    for (const date of [...settledDays, today]) generateMissionForDay(db, date);

    const idsOn = (date) =>
      new Map(
        db
          .all(
            `SELECT e.id, e.title FROM log_entries e
               JOIN daily_logs d ON d.id = e.daily_log_id
              WHERE d.date = ?`,
            [date]
          )
          .map((r) => [r.title, r.id])
      );
    // Creatine every day, Magnesium never — including today, which is still
    // open and must therefore not be judged.
    for (const date of [...settledDays, today]) {
      setMissionStatus(db, idsOn(date).get('Creatine'), 'completed');
    }

    const young = render('mission-history (4-day record)', MissionHistoryScreen);
    expect('mission-history (4-day record)', young, [
      '50%', // 3 of 6 over the three days that are OVER
      'of 6 planned',
      '3 done', // the ledger sums to the denominator beside the rate
      '0 skipped',
      '3 untouched',
      '4 days on record', // the record's true extent, stated
      'too little to read as a trend', // ...and disclaimed, because it is 3 days
      'Judged ', // the window the rate is over, stated
      '3 finished days', // ...and the section that shares it
      'Morning stack', // the source, worst first
      '3 missed', // every figure on that plate is framed as a miss
      'of 6 planned',
      'Magnesium', // its worst item, named
      '3 of 3 missed',
      'today, still open', // today is on the record but is not judged
    ]);
    // Today has 2 planned and 1 done. If today were folded into the rate it
    // would read 4 of 8 = 50%… identical here by coincidence, which is exactly
    // why the DENOMINATOR is the assertion: 6, never 8.
    refute('mission-history (4-day record)', young, [
      'of 8 planned',
      'Nothing was missed',
      '0 of 0',
    ]);

    // Now do the missing item on every settled day. "Nothing was missed" and
    // "nothing was ever planned" are different facts and must not render
    // alike — this is the same pair the codebase has confused twice before.
    for (const date of settledDays) {
      setMissionStatus(db, idsOn(date).get('Magnesium'), 'completed');
    }
    const clean = render('mission-history (all done)', MissionHistoryScreen);
    expect('mission-history (all done)', clean, [
      '100%',
      'Nothing was missed. All 6 planned items were completed.',
    ]);
    refute('mission-history (all done)', clean, [
      '3 missed',
      'No mission has been planned yet', // the never-planned sentence, which is a different fact
    ]);
  }
}

// ---------------------------------------------------------------------------
// Progress photos (0036, docs/progress-photos-subapp.md). The point of walking
// these four through a real render is the degradation ledger: under node there
// is no expo-image-picker, no expo-file-system and no model key, which is
// EXACTLY the state of the owner's current binary. Every one of those absences
// has to be a sentence on the screen rather than a crash or a dead control.
{
  console.log('11. Progress photos — empty, populated, and honestly degraded');

  expect('progress photos (empty)', render('progress photos (empty)', ProgressPhotosScreen), [
    'Progress photos',
    'Bring in your progress photos',
    'No photos yet',
    // The picker is not in this binary: the control is disabled and says why.
    'rides the next app build',
  ]);
  refute('progress photos (empty)', render('progress photos (empty)', ProgressPhotosScreen), [
    // Nothing may claim a tally before there is anything to tally.
    'photos · ',
    // A9 (2026-09-19): the empty state ran a second paragraph of capture advice
    // — "Three poses on the same morning, in the same light, is the set that
    // compares well months later." An empty state gets one sentence, and the
    // pose set it recommended is still named in the sentence above it.
    'Three poses on the same morning',
  ]);

  // Compare, with nothing to compare. No walk before the fourth had read this
  // screen's empty state (slop pass 4, docs/ai-slop-candidates-2026-09.md
  // §11.D): it said a comparison was "worth looking at" and told the user to
  // come back. What is left is how a pair is made. It must NOT say a
  // comparison needs the same pose: the gallery compares any two photos, and
  // the front-vs-side render below draws exactly such a pair. `pickDefaultPair`
  // is only the fallback for a pair that no longer resolves.
  const noPair = render('progress photo compare (nothing to pair)', ProgressPhotoCompareScreen);
  expect('progress photo compare (nothing to pair)', noPair, [
    'Pick two photos in the gallery to compare them.',
    'Back to photos',
  ]);
  refute('progress photo compare (nothing to pair)', noPair, [
    'worth looking at',
    'come back',
    'needs two photos of the same pose',
  ]);

  expect('progress photo add', render('progress photo add', ProgressPhotoAddScreen), [
    'Add photos',
    'From your library',
    'Choose photos',
    'not today',
  ]);

  // Fixtures through the REAL store seam, with an in-memory file system.
  const photoFiles = new Map();
  const fakeStore = {
    list: () => [...photoFiles.keys()],
    exists: (name) => photoFiles.has(name),
    remove: (name) => {
      photoFiles.delete(name);
      return true;
    },
    write: (name, bytes) => {
      photoFiles.set(name, bytes);
      return true;
    },
    uri: (name) => (photoFiles.has(name) ? `file:///documents/progress-photos/${name}` : null),
  };
  const photoIds = importProgressPhotos(
    db,
    [
      { taken_on: '2026-01-12', pose: 'front', workingBase64Jpeg: '/9j/jan' },
      { taken_on: '2026-08-09', pose: 'front', workingBase64Jpeg: '/9j/aug' },
      { taken_on: '2026-08-09', pose: 'side', workingBase64Jpeg: '/9j/augside' },
    ],
    fakeStore
  );
  ok('progress photo fixtures seeded through the real store');

  const gallery = render('progress photos (populated)', ProgressPhotosScreen);
  expect('progress photos (populated)', gallery, [
    'August 2026',
    'January 2026',
    '2 photos · 2 poses',
    '1 photo · 1 pose',
    'Compare',
    'Front',
    'Side',
    // No expo-file-system under node, so every cell resolves to no URI — and
    // draws the authored state rather than a broken frame.
    'Not on this phone',
  ]);

  expect(
    'progress photo detail',
    render('progress photo detail', ProgressPhotoDetailScreen, { id: photoIds[1] }),
    [
      '9 Aug 2026',
      'Details',
      'Taken on',
      'Pose',
      'Important',
      // No weigh-in exists near that date in this fixture DB.
      'no weigh-in near this date',
      // No model key under node: the reading affordance is a sentence, not a button.
      'needs a model key',
      'Delete photo',
      // The honest retro-flag caveat is on the row that could mislead.
      'at import time',
      // Provenance is the PERSISTED fact, not a guess from `taken_at`.
      'Set by you.',
    ]
  );

  // THE HONESTY CASE THE SWEEP IS BUILT TO PRODUCE: a row that claims a
  // full-size original whose file did not come across. The screen must not say
  // "a full-size original is kept inside ARC" directly beneath "Image not on
  // this phone". Under node there is no file system at all, so every row is in
  // exactly this state — which makes it the cheapest possible assertion and the
  // one whose absence let the bug ship.
  db.run('UPDATE progress_photos SET original_file_name = ?, is_important = 1 WHERE id = ?', [
    'orphaned-original.jpg',
    photoIds[0],
  ]);
  const orphaned = render('progress photo detail (no files)', ProgressPhotoDetailScreen, {
    id: photoIds[0],
  });
  expect('progress photo detail (no files)', orphaned, [
    'Image not on this phone.',
    'isn’t on this phone either',
  ]);
  refute('progress photo detail (no files)', orphaned, [
    'A full-size original is kept inside ARC for this one.',
  ]);
  expect(
    'progress photo detail (missing id)',
    render('progress photo detail (missing)', ProgressPhotoDetailScreen, { id: 'nope' }),
    ['This photo is gone.']
  );

  expect(
    'progress photo compare',
    render('progress photo compare', ProgressPhotoCompareScreen, {
      a: photoIds[0],
      b: photoIds[1],
    }),
    [
      'Compare',
      '12 Jan 2026',
      '9 Aug 2026',
      'days apart',
      'both front',
      'Compare against',
      'no weigh-in near this date',
    ]
  );

  // The weigh-in caption, with its distance — the claim the whole compare
  // surface rests on. A weigh-in two days after the January photo must print
  // that distance, not just a number.
  //
  // 84.2 kg renders as **185.6 lb** because DEFAULT_UNIT_PREFERENCES.weight is
  // 'lb' and this surface goes through the same resolveDisplay/formatMeasured
  // pair as every other measured value in the app. Asserting the converted
  // figure is the point: a photo caption that hard-coded "kg" would be the one
  // number on the phone that ignored the owner's unit choice.
  db.run('INSERT INTO body_metrics (id, measured_at, weight_kg, source) VALUES (?, ?, ?, ?)', [
    'render-weigh-1',
    '2026-01-14T07:00:00.000Z',
    84.2,
    'manual',
  ]);
  expect(
    'progress photo compare (with a weigh-in)',
    render('progress photo compare (weighed)', ProgressPhotoCompareScreen, {
      a: photoIds[0],
      b: photoIds[1],
    }),
    ['185.6 lb', 'weighed 2 days later']
  );

  // Two poses side by side: the caveat stands, and the advice after it went
  // (§11.D) — the Compare against plate under it lists the same pose by
  // default, which is how like is compared with like.
  const mixed = render('progress photo compare (front vs side)', ProgressPhotoCompareScreen, {
    a: photoIds[1],
    b: photoIds[2],
  });
  expect('progress photo compare (front vs side)', mixed, [
    // Same day, so which of the two leads is the id tiebreak — "0 days apart"
    // holds either way, where "front vs side" would be a coin toss.
    '0 days apart',
    'These are different poses, so most of what looks like a change is the angle.',
    'Compare against',
  ]);
  refute('progress photo compare (front vs side)', mixed, ['like with like']);
}

{
  console.log('12. The knowledge base (0038 + 0044 sections, docs/knowledge-subapp.md)');

  // Before the pack: the hub is honest that the reference has not loaded, and
  // BOTH section empties are AUTHORED rather than blank — and they say
  // DIFFERENT things, because they are different facts. An empty scientific run
  // sits above a shipped pack, so "nothing of your own yet" is a remark about
  // authorship; an empty personal run means ARC holds no page about the user at
  // all.
  const cold = render('knowledge hub (cold)', KnowledgeScreen);
  expect('knowledge hub (cold)', cold, [
    'Knowledge',
    'Import an article',
    'Personal',
    'ARC holds no page about you yet',
    'Write a personal note',
    'Scientific',
    'Nothing of your own yet',
    'ARC reference',
    // A9: the accent card's pitch cut to the one fact worth keeping.
    'Yours outranks ARC’s shipped reference, and the Coach cites both.',
  ]);
  // A9: three feature-explainers on this one screen — the accent card taught
  // the import mechanism, and both empty sections re-explained what the
  // editor already says at the moment it matters (knowledge-entry-edit.tsx).
  // None may silently come back.
  refute('knowledge hub (cold)', cold, [
    'ARC compresses what its author actually commits to',
    'too long to be a one-line memory',
    'the Coach cites it like the rest',
  ]);

  ingestCorpus(db);
  const withPack = render('knowledge hub (pack loaded)', KnowledgeScreen);
  expect('knowledge hub (pack loaded)', withPack, [
    // Grouped by topic, the labs category-plate model.
    'Cardiovascular',
    'Supplements',
    'ApoB is ARC',
  ]);
  // The pack ships, so the screen is never globally empty — the first-run state
  // is a reading, not a void.
  refute('knowledge hub (pack loaded)', withPack, ['ARC’s reference hasn’t loaded yet']);

  const entryId = saveKnowledgeEntry(db, {
    title: 'Render entry: my own magnesium stance',
    topic: 'supplements',
    body:
      'Glycinate over citrate, at 300 mg, taken with the evening meal.\n\n' +
      'Citrate is notably laxative at the doses people actually take it at, which is the ' +
      'whole reason the form matters more than the milligrams here.',
  });
  const withEntry = render('knowledge hub (with an entry)', KnowledgeScreen);
  expect('knowledge hub (with an entry)', withEntry, [
    'Render entry: my own magnesium stance',
    'written by you', // provenance, from the shared provenanceLine
  ]);
  refute('knowledge hub (with an entry)', withEntry, ['Nothing of your own yet']);
  // …and a scientific entry does NOT fill the personal run. The two sections
  // read from one table through one filter, so the failure this catches is a
  // dropped WHERE clause — which would look fine until the day a personal note
  // exists.
  expect('knowledge hub (with an entry)', withEntry, ['ARC holds no page about you yet']);

  const personalId = saveKnowledgeEntry(db, {
    title: 'Render entry: left knee, ACL 2019',
    topic: 'training',
    section: 'personal',
    body:
      'Reconstructed left ACL in 2019. The quad still measures roughly 15% down against the ' +
      'right under load, and deep loaded knee flexion under fatigue is where it complains.',
  });
  const withPersonal = render('knowledge hub (with a personal entry)', KnowledgeScreen);
  expect('knowledge hub (with a personal entry)', withPersonal, [
    'Render entry: left knee, ACL 2019',
    'Render entry: my own magnesium stance', // the other section still drawn
  ]);
  refute('knowledge hub (with a personal entry)', withPersonal, [
    'ARC holds no page about you yet',
  ]);

  // The reader names the section it came out of — a page about the user and a
  // page about the world are read differently.
  expect(
    'knowledge-entry (personal)',
    render('knowledge-entry (personal)', KnowledgeEntryScreen, {
      id: personalId,
      kind: 'entry',
    }),
    ['Personal', 'Render entry: left knee, ACL 2019', 'Edit', 'Archive']
  );

  // The reader, both kinds behind one route.
  expect(
    'knowledge-entry (user entry)',
    render('knowledge-entry (user entry)', KnowledgeEntryScreen, {
      id: entryId,
      kind: 'entry',
    }),
    [
      'Your entry',
      'Render entry: my own magnesium stance',
      'Written by you · since',
      'Edit',
      'Archive',
    ]
  );

  const packId = db.get(
    `SELECT id FROM knowledge_chunks WHERE source = 'arc-longevity-v1' ORDER BY chunk_index LIMIT 1`
  ).id;
  const packRead = render('knowledge-entry (pack)', KnowledgeEntryScreen, {
    id: packId,
    kind: 'pack',
  });
  expect('knowledge-entry (pack)', packRead, [
    'ARC reference',
    'Part of ARC’s shipped reference',
    'Write your own entry on this topic',
  ]);
  // Pack entries are read-only, decisively — a version bump would eat any edit.
  refute('knowledge-entry (pack)', packRead, ['Archive']);

  expect(
    'knowledge-entry (deleted id)',
    render('knowledge-entry (deleted id)', KnowledgeEntryScreen, { id: 'nope', kind: 'entry' }),
    ['That entry is no longer here']
  );

  expect(
    'knowledge-entry-edit (new)',
    render('knowledge-entry-edit (new)', KnowledgeEntryEditScreen),
    [
      'Write an entry',
      'Section',
      'Personal',
      'Scientific',
      'Topic',
      'supplements', // the vocabulary chips
      'Save entry',
    ]
  );
  // The section switch is shown when EDITING too — that is the re-filing path,
  // and the line between "what I believe about sleep" and "what is true of my
  // sleep" is blurry enough that getting it wrong once must not be permanent.
  expect(
    'knowledge-entry-edit (editing)',
    render('knowledge-entry-edit (editing)', KnowledgeEntryEditScreen, { id: entryId }),
    ['Edit entry', 'Section', 'Save changes']
  );
  // Arriving from the hub's personal action preselects the section, so filing a
  // personal note is not two decisions.
  expect(
    'knowledge-entry-edit (new, personal)',
    render('knowledge-entry-edit (new, personal)', KnowledgeEntryEditScreen, {
      section: 'personal',
    }),
    ['A page about you']
  );

  expect('knowledge-import', render('knowledge-import', KnowledgeImportScreen), [
    'Import an article',
    'From a link',
    'Paste the text',
    // Honest no-key state under node — and the manual floor is still offered.
    'Reading an article needs a model key',
    'Write it yourself',
  ]);

  // --- C14: coach memory is a run on this hub, not a screen under Settings ---
  //
  // Owner: "I should be able to manually add stuff to coach memory that it
  // should know every turn." The store did not change (no migration); its
  // surface moved here, beside the entries it has to be told apart from.
  //
  // The empty state is AUTHORED, and it is a different fact from either entry
  // empty: "The Coach holds nothing yet" is a statement about what rides in the
  // prompt, not about what is written down.
  const coldMemory = render('knowledge hub (no memories)', KnowledgeScreen);
  expect('knowledge hub (no memories)', coldMemory, [
    'Coach memory',
    'The Coach holds nothing yet',
    // A9 (2026-09-19): what survives of the paragraph under it is the consent
    // fact — nothing is remembered without being asked. The "one line each,
    // carried into every turn" half is the editor's own sentence, stated where
    // the line is being written (app/coach-memory.tsx), and the examples were a
    // tutorial. This is the relocated §2 candidate: the sentence left
    // coach-memory.tsx for this hub and had to be cut where it landed.
    'tell the Coach and it will ask to keep it',
    'Remember something',
  ]);
  refute('knowledge hub (no memories)', coldMemory, [
    'One line each, carried into every turn',
    'how you like to train, something that',
  ]);

  rememberFact(db, {
    content: 'Render memory: trains fasted before 9am',
    category: 'preference',
  });
  const withMemory = render('knowledge hub (with a memory)', KnowledgeScreen);
  expect('knowledge hub (with a memory)', withMemory, [
    'Render memory: trains fasted before 9am',
    'Preference', // the kind eyebrow, the entry rows' topic-eyebrow shape
  ]);
  refute('knowledge hub (with a memory)', withMemory, ['The Coach holds nothing yet']);
  // The cap is stated only when it BITES. Under 40 the sentence would be a
  // setting nobody asked about; over it, it is the only explanation for a Coach
  // that ignores a fact the owner can still read on this screen.
  refute('knowledge hub (with a memory)', withMemory, ['no longer riding along']);

  // The forgotten foot stays collapsed, so its rows are absent from the render
  // while its heading is present — the Archived foot's behaviour exactly.
  const forgottenId = rememberFact(db, {
    content: 'Render memory: a fact that stopped being true',
    category: 'context',
  });
  forgetMemory(db, forgottenId);
  const withForgotten = render('knowledge hub (with a forgotten memory)', KnowledgeScreen);
  expect('knowledge hub (with a forgotten memory)', withForgotten, ['Forgotten']);
  refute('knowledge hub (with a forgotten memory)', withForgotten, [
    'Render memory: a fact that stopped being true',
  ]);

  // Past the cap the sentence appears, and it is the ONLY place in the app that
  // explains a Coach ignoring a fact the owner can still read on screen. Built
  // and torn down inside this block so the 41 rows do not follow the hub into
  // any later render.
  const overflow = [];
  for (let i = 0; i < 41; i += 1) {
    overflow.push(rememberFact(db, { content: `Render memory filler ${i}`, category: 'context' }));
  }
  expect(
    'knowledge hub (over the prompt cap)',
    render('knowledge hub (over the prompt cap)', KnowledgeScreen),
    ['no longer riding along', 'most recent into every turn']
  );
  for (const id of overflow) db.run('DELETE FROM coach_memories WHERE id = ?', [id]);

  // The editor the hub pushes at, both ways in.
  expect('coach-memory (new)', render('coach-memory (new)', CoachMemoryScreen), [
    'Remember something',
    'The memory',
    'Kind',
    'Preference',
    'Constraint',
    // The LENGTH litmus, stated where the owner is choosing between the stores.
    'is a Personal entry instead',
    // Not "carries the 40 most recent": MEMORY_PROMPT_LIMIT is a JSX
    // interpolation, so react-dom splits that sentence across text nodes and an
    // assertion spanning the number would fail on the markup, not the copy.
    'most recent memories into every turn',
  ]);
  const editing = render('coach-memory (editing)', CoachMemoryScreen, { id: forgottenId });
  expect('coach-memory (editing)', editing, [
    'Edit memory',
    'Render memory: a fact that stopped being true',
    // A forgotten memory offers Restore, not Forget — the two are one control.
    'Restore',
    'Delete',
  ]);
  refute('coach-memory (editing)', editing, ['Remember this']);
  // A link to a memory that has since been deleted is authored, not blank.
  expect(
    'coach-memory (deleted id)',
    render('coach-memory (deleted id)', CoachMemoryScreen, { id: 'nope' }),
    ['That memory is no longer here']
  );
}

{
  console.log('13. Reports (docs/reports-subapp.md, migration 0039');

  // a. The index, before anything has been generated.
  const emptyReports = render('reports (empty)', ReportsScreen);
  expect('reports (empty)', emptyReports, [
    'Reports',
    'Self-review',
    'Doctor visit pack',
    // Empty is AUTHORED — it says so and stops (backlog A9: the explainer that
    // followed — "A report is a document — assembled from your data,
    // previewed here, shared as a file." — was a feature-explainer, and the
    // two cards below it already say what each report contains).
    'Nothing generated yet.',
    // The pointer to export's real home, not a second export button.
    'lives in Settings › Security &amp; data',
  ]);
  // ⚑ MATT #4: the export ACTION does not live here.
  refute('reports (empty)', emptyReports, ['Export data', 'Reports & export']);
  // A9: the removed explainer must not silently come back.
  refute('reports (empty)', emptyReports, [
    'assembled from your data',
    // A9 (2026-09-19): the export pointer closed on an aphorism — "A report is
    // a document for a reader; the export is the data itself." Same conceit
    // shape as knowledge-entry-edit's "An entry is a page, not a paper", which
    // 00-design-spec.md §5 rules out. The route it points at is the fact and
    // survives above.
    'the export is the data itself',
  ]);

  // b. A draft self-review over a real period, assembled for real.
  const period = {
    kind: 'self_review',
    periodKind: 'custom',
    start: '2026-08-01',
    end: '2026-08-07',
  };
  const draft = render('report-view (draft self-review)', ReportViewScreen, period);
  expect('report-view (draft self-review)', draft, [
    'Draft report',
    'Custom range',
    '1 – 7 Aug 2026',
    'Adherence',
    'Sleep &amp; recovery',
    'What changed',
    // The one accent in the flow.
    'Save &amp; share',
    // The honesty rules, printed.
    'days in this period carry at least one logged entry',
    'not a medical record',
  ]);
  // The tripwires the HTML renderer is held to apply to the native one too.
  refute('report-view (draft self-review)', draft, ['undefined', 'NaN', '[object']);

  // c. The doctor pack, on a database with no profile: authored blanks and a
  //    warning BEFORE the document, never a guess.
  const pack = render('report-view (doctor pack)', ReportViewScreen, { kind: 'doctor_pack' });
  expect('report-view (doctor pack)', pack, [
    'Doctor visit pack',
    'Missing from your profile',
    'Current regimen',
    'Laboratory results',
    'tracked markers measured',
    // The two absences a clinician looks for, stated rather than left blank.
    'does not record blood pressure',
    'no BMI',
  ]);
  // NO MODEL SURFACE on the clinical document, ever.
  refute('report-view (doctor pack)', pack, ["Add Coach's read", 'undefined', 'NaN', '[object']);

  // d. A malformed range is a dead end with an authored explanation, not a crash.
  expect(
    'report-view (bad range)',
    render('report-view (bad range)', ReportViewScreen, {
      kind: 'self_review',
      periodKind: 'custom',
      start: 'nonsense',
      end: '2026-08-07',
    }),
    ['the range it was asked for is not a real one']
  );

  // e. A PERSISTED report re-renders from its snapshot, not from a re-assembly.
  const stored = assembleSelfReview(db, periodFromBounds('last_week', '2026-08-03', '2026-08-09'), {
    appVersion: '0.2.0',
  });
  const storedId = insertReport(db, {
    data: stored,
    read: null,
    fileName: 'arc-report-self-review-20260812-143308.html',
    filePath: 'reports/arc-report-self-review-20260812-143308.html',
  });
  expect(
    'report-view (persisted)',
    render('report-view (persisted)', ReportViewScreen, { id: storedId }),
    [
      'Last week',
      '3 – 9 Aug 2026',
      // A saved report offers the file again rather than a second save.
      'Share again',
    ]
  );

  // f. The history now has a row, and the Data tab's index row carries it.
  expect('reports (with history)', render('reports (with history)', ReportsScreen), [
    'Self-review',
    '3 – 9 Aug 2026',
  ]);

  const dataTab = render('data tab', DataScreen);
  expect('data tab', dataTab, [
    'The full file',
    // The relabel (⚑ MATT #4) and the row's LIVE state — the thing that makes
    // this row a reading rather than another index entry.
    '1 report · last ',
  ]);
  refute('data tab', dataTab, ['Reports &amp; export', 'Reports & export']);
}

// ---------------------------------------------------------------------------
// 14. The water record — the one screen that tracks, LOGS and EDITS a metric.
//
// Its never-logged state is asserted up in §0, before any fixture exists. What
// is left is the pair this codebase keeps confusing: a YOUNG record that must
// say it is young, and a full one that may finally state a trend. Water is
// stored one row per capture (db/water.test.mjs §1), which is the fact that
// makes the Entries block — and therefore "edit" — expressible at all.
{
  console.log('14. Water — track, log and edit');
  const db = getDb();
  const now = todayISODate();
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return todayISODate(d);
  };

  // Three days of record, two captures today. Deliberately under TREND_FLOOR.
  logWater(db, day(2), 500);
  logWater(db, day(1), 750);
  logWater(db, now, 500);
  logWater(db, now, 250);

  const young = render('water (3-day record)', WaterScreen);
  expect('water (3-day record)', young, [
    'Water',
    '3 days on record', // the record's true extent, stated...
    'too little to read as a trend', // ...and disclaimed, because it is 3 days
    'By day', // the record itself
    'Entries', // the editable half
    '2 entries', // today's two captures, counted
    'today, still open',
  ]);
  // 750 ml is 25.4 oz (it printed "25 oz" until 2026-09-21) and the default
  // unit is oz, so the day rows read in oz.
  // Nothing may print a stand-in zero for the eleven days with no capture, and
  // with no goal set there is still no denominator anywhere.
  refute('water (3-day record)', young, [
    'No water logged yet', // there IS a record now — a different fact
    'of goal',
    '0 oz',
    'No water yet', // the stamp retires the moment a record exists
  ]);

  // A goal turns the denominator on — and ONLY a goal does. 100 oz ≈ 2957 ml.
  setWaterTarget(db, 2957);
  const withGoal = render('water (with goal)', WaterScreen);
  expect('water (with goal)', withGoal, [
    'of 100 oz', // the denominator the user chose, in the user's unit
    '% of goal',
  ]);
  refute('water (with goal)', withGoal, ['None set']);

  // Eleven more days, taking the record past TREND_FLOOR: the disclaimer must
  // retire on its own rather than becoming permanent furniture.
  for (let n = 3; n <= 13; n++) logWater(db, day(n), 500);
  const full = render('water (14-day record)', WaterScreen);
  expect('water (14-day record)', full, ['14 days on record', 'average', '14 of 14 days logged']);
  refute('water (14-day record)', full, ['too little to read as a trend']);

  // ---------------------------------------------------------------------
  // The Data tab now carries a Water trend row — and no longer carries a
  // single "Set up" box (owner, 2026-08-14). The chips were never controls,
  // so their removal strands nothing; this is what keeps them removed.
  const dataWithWater = render('data tab (water + no chips)', DataScreen);
  expect('data tab (water + no chips)', dataWithWater, [
    'Water',
    'Intake today',
    // The tally counts the very array it renders, so the denominator proves
    // Water joined the strip. The NUMERATOR is deliberately not asserted: it
    // counts whichever domains happen to be populated by this point in the
    // shared fixture DB, which is a fact about test ordering, not about Water.
    ' of 7 tracked',
  ]);
  refute('data tab (water + no chips)', dataWithWater, ['Set up', 'Later']);

  // ---------------------------------------------------------------------
  // The Log tab's water row in BOTH unit preferences, now that there is a
  // record to learn from. The fixture above logged 500 ml thirteen times and
  // 750 / 250 once each, so the remembered amount is 500 ml.
  //
  // Two separate claims live here since 2026-09-21, and they used to be one:
  //
  //   1. **The vessels are per-unit literals.** Under ml they are 240/500/750,
  //      never a converted 473 — a metric bottle is 500, and a tap has to write
  //      the number on the cell.
  //   2. **The remembered amount is a NOTE, not a button.** It says which one he
  //      usually takes, in the unit he reads in, and nothing taps it. That is
  //      the whole of what survives of the one-tap tile.
  setUnitPreference(db, 'volume', 'ml');
  const mlLog = render('log tab (ml, learned amount)', LogScreen);
  expect('log tab (ml, learned amount)', mlLog, [
    '+240 ml',
    '+500 ml',
    '+750 ml',
    'Log 500 ml of water, Bottle',
    'usually 500 ml', // the note, stored and printed metric, unconverted
  ]);
  // Under a metric preference nothing in this block may still read in ounces.
  refute('log tab (ml, learned amount)', mlLog, [
    '+8 oz',
    '+16 oz',
    '+24 oz',
    'usually 17 oz',
    'Log water, 500 ml', // the committing tile's label is gone for good
  ]);

  setUnitPreference(db, 'volume', 'oz');
  const ozLog = render('log tab (oz, learned amount)', LogScreen);
  // THE INVARIANT, rendered: every cell's caption and its accessibility label
  // carry the SAME number, and it is the number that tap will log. The note
  // converts with them — 500 ml read under an ounce preference is 16.9 oz, so
  // the habit is stated as 16.9 oz rather than as a stored 500 nobody typed.
  expect('log tab (oz, learned amount)', ozLog, [
    '+8 oz',
    '+16 oz',
    '+24 oz',
    'Log 16 oz of water, Bottle',
    'usually 16.9 oz',
  ]);
  refute('log tab (oz, learned amount)', ozLog, [
    '+240 ml',
    '+500 ml',
    '+750 ml',
    'usually 500 ml',
    'Log water, 17 oz',
    // It read "usually 17 oz" until 2026-09-21: the whole-ounce rounding the
    // owner reported on Garmin water ("units are heavily rounded").
    'usually 17 oz',
  ]);

  // ONE ROW, ONE FIGURE, EVERYWHERE (2026-09-21). The same 500 ml capture that
  // the Log tab's note calls "usually 16.9 oz" is a row on the water screen, and
  // the same day's 750 ml (500 + 250) is both the water screen's Today figure
  // and the Data tab's Intake today. Each surface used to round for itself, to
  // whole ounces; all three now print through formatFigure.
  const ozWater = render('water (oz, one figure per row)', WaterScreen);
  expect('water (oz, one figure per row)', ozWater, [
    '16.9 oz at', // the 500 ml entry's own row label: the note's figure
    '8.5 oz at', // the 250 ml entry, a metric cup, where the defect was loudest
    '25.4', // Today, the day's total, the same figure the Data tab prints
  ]);
  refute('water (oz, one figure per row)', ozWater, [
    '17 oz at', // the 500 ml row as it printed before the fix
    '8 oz at', // the 250 ml row as it printed before the fix
  ]);
  const ozData = render('data tab (oz, water figure)', DataScreen);
  expect('data tab (oz, water figure)', ozData, ['25.4']);
}

// ---------------------------------------------------------------------------
// The Protocols sub-app, populated (docs/project-status.md §1 › PROTOCOLS).
// The empty states are up in §0, before any fixture existed; these are the four
// screens with a real phased, cadenced protocol and a real execution record
// behind them.
// ---------------------------------------------------------------------------
{
  console.log('15. Protocols — the hub, the detail, the editor and the diff');

  // A titration with two phases and three cadences, anchored in the past so a
  // phase is genuinely live and the record has settled days behind it.
  const day = (n) => {
    const d = new Date();
    d.setDate(d.getDate() - n);
    return todayISODate(d);
  };
  const phasedId = createProtocolWithVersion(
    db,
    { name: 'Creatine loading', type: 'supplement_stack', startedOn: day(10) },
    {
      schema: 2,
      phases: [
        {
          id: 'load',
          title: 'Loading',
          duration_days: 7,
          items: [
            {
              id: 'c-load',
              title: 'Creatine',
              scheduled_time: '07:00',
              dose: '20 g',
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
        {
          id: 'maint',
          title: 'Maintenance',
          duration_days: null,
          items: [
            {
              id: 'c-maint',
              title: 'Creatine',
              scheduled_time: '07:00',
              dose: '5 g',
              notes: null,
              cadence: { kind: 'daily' },
            },
            {
              id: 'lift',
              title: 'Lower body',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'weekdays', days: [1, 3, 5] },
            },
          ],
        },
      ],
    },
    'Split into a loading week and maintenance'
  );

  const hub = render('protocols (populated)', ProtocolsScreen);
  expect('protocols (populated)', hub, [
    'Running',
    'Creatine loading',
    // The row carries LIVE STATE, not a file description: which phase, and how
    // often. On day 10 of a 7-day loading phase it is in Maintenance.
    'Maintenance of 2',
    'Morning stack', // the §10 fixture, still running
  ]);

  const detail = render('protocol-detail', ProtocolDetailScreen, { id: phasedId });
  expect('protocol-detail', detail, [
    'Creatine loading',
    'Supplement stack',
    'Maintenance of 2', // where it is up to, as the verdict
    '5 g', // the live phase's dose, not the loading one's
    'Mon · Wed · Fri', // the cadence, in words
    // The adherence plate, re-set 2026-09-14 (backlog A9). The label is the
    // noun for what is filed under it; the assistant-voiced version the owner
    // named as the archetype of the app's AI slop is refuted below.
    'Adherence',
    // The closing plate since 2026-09-25 (option A): whether it runs, and its
    // history. Pause is a row with a confirmation, not a field in a form.
    'The protocol',
    'Pause this protocol',
    'Version history',
    // ONE door to the protocol-wide form, in the header where Settings was.
    'aria-label="Edit this protocol"',
    // R7: Add an item is drawn on a protocol that already has items.
    'Add an item',
  ]);
  refute('protocol-detail', detail, [
    'How it is going',
    'Nothing settled to judge yet',
    // The two settings menus the owner found confusing, and the second door.
    'Protocol settings',
    '>Settings<',
    'The document',
  ]);
  (detail?.match(/aria-label="Edit this protocol"/g) ?? []).length === 1
    ? ok('protocol-detail has exactly one door into the protocol form')
    : bad(
        'protocol-detail doors',
        String((detail?.match(/aria-label="Edit this protocol"/g) ?? []).length)
      );
  // The loading dose belongs to a phase that is over. Printing it beside the
  // live one would hand the reader two doses of the same compound with nothing
  // saying which is current.
  refute('protocol-detail', detail, ['20 g']);

  // A protocol whose live version landed today has NO record — which is a
  // different fact from a record of nothing done, and neither is 0%.
  expect('protocol-detail (no record yet)', detail, ['landed today', 'Counting starts tomorrow.']);
  refute('protocol-detail (no record yet)', detail, ['0%']);

  // THE ONE EDITOR, on a phased protocol (docs/spikes/protocol-menus-compact.md,
  // option A — the owner's choice of 2026-09-25): every protocol fact in one
  // form. Identity, the phases and items, the phase clock ONCE, both policies,
  // the change note and Delete.
  const editPhased = render('protocol-edit (phased)', ProtocolEditScreen, { id: phasedId });
  expect('protocol-edit (phased)', editPhased, [
    'Edit Protocol',
    'aria-label="Protocol name"',
    'value="Creatine loading"',
    'Supplement stack', // the type chips are back — Settings folded in
    'Changing it applies from tomorrow.',
    'Phase 1',
    'Phase 2',
    'Loading',
    'Maintenance',
    'Mon · Wed · Fri', // an item line states its cadence
    'Phase 1 starts',
    'If you miss it',
    'When you check it off',
    'What changed (optional)',
    'Delete protocol',
    // Order is the form's to set: an item within its phase, a phase among phases.
    'Move phase 2 up',
    'Move Creatine down',
  ]);
  (editPhased?.match(/Phase 1 starts/g) ?? []).length === 1
    ? ok('protocol-edit asks for the phase clock exactly once')
    : bad('Phase 1 starts appears', String((editPhased?.match(/Phase 1 starts/g) ?? []).length));
  // PAUSE IS NOT IN THE FORM (the owner's second answer): it is a row on the
  // page, so a Save can never flip it.
  refute('protocol-edit (phased)', editPhased, ['>Status<', '>Paused<', '>Active<', 'Running']);
  // At rest: every item is one line, nothing is open, and Save is inert and
  // says so — it names no version, because nothing would write one.
  refute('protocol-edit (phased)', editPhased, [
    'aria-label="Item name"',
    'aria-label="Item time"',
    '>At<',
    'Save as',
  ]);
  /** The Save button's own tag, so its disabled state can be read. */
  const saveTag = (html) =>
    (html?.match(/<[^>]*aria-label="(Save protocol|Create protocol)"[^>]*>/) ?? [''])[0];
  saveTag(editPhased).includes('aria-disabled="true"')
    ? ok('protocol-edit at rest: Save is inert')
    : bad('protocol-edit at rest: Save is live', saveTag(editPhased));

  // Opened AT an item — a Now row, or a mission row's *Edit this item*: that
  // item alone is open, with its fields, the why-line among them.
  const editAt = render('protocol-edit (at an item)', ProtocolEditScreen, {
    id: phasedId,
    item: 'c-maint',
  });
  expect('protocol-edit (at an item)', editAt, [
    'aria-label="Item name"',
    'aria-label="Dose or how-to"',
    'value="5 g"',
    'Why this is here', // the why-line is editable now, not carried unseen
    'In Maintenance', // …and its phase, as chips, keeping its id when moved
    'Moving an item puts it at the end of that phase.',
  ]);
  (editAt?.match(/aria-label="Item name"/g) ?? []).length === 1
    ? ok('protocol-edit opens exactly one item: the one it was opened at')
    : bad('open items', String((editAt?.match(/aria-label="Item name"/g) ?? []).length));
  // Even open, the item's time control stays one line: the wheel is tall.
  refute('protocol-edit (at an item)', editAt, ['aria-label="Item time"']);
  saveTag(editAt).includes('aria-disabled="true"')
    ? ok('protocol-edit opened at an item: Save is still inert until something changes')
    : bad('opened at an item: Save live at rest', saveTag(editAt));

  expect(
    'protocol-edit (at a gone item)',
    render('protocol-edit (at a gone item)', ProtocolEditScreen, { id: phasedId, item: 'no-such' }),
    ['The item you opened is not in the live version any more.']
  );

  // *Add an item* from the page: a blank item in the LIVE phase (Maintenance,
  // phase 2 on day 10 of a 7-day loading phase), open.
  const editAdd = render('protocol-edit (add)', ProtocolEditScreen, { id: phasedId, add: '1' });
  expect('protocol-edit (add)', editAdd, ['New item', 'aria-label="Item name"']);
  editAdd !== null && editAdd.indexOf('New item') > editAdd.indexOf('Phase 2')
    ? ok('protocol-edit (add): the new item sits in the phase running today')
    : bad('protocol-edit (add): the new item is not in the live phase');

  expect(
    'protocol-edit (gone)',
    render('protocol-edit (gone)', ProtocolEditScreen, { id: 'nope' }),
    ['This protocol no longer exists.']
  );

  // The CREATE path is the same form: identity, one open item, the policies.
  const create = render('protocol-edit (create)', ProtocolEditScreen);
  expect('protocol-edit (create, the same form)', create, [
    'New Protocol',
    'Supplement stack',
    'aria-label="Item name"',
    'If you miss it',
    'When you check it off',
    'Create protocol',
  ]);
  refute('protocol-edit (create, the same form)', create, [
    'Delete protocol',
    'What changed',
    'Changing it applies from tomorrow.',
  ]);

  // A second version, so the history has an adjacent pair to diff.
  addVersion(
    db,
    phasedId,
    {
      schema: 2,
      phases: [
        {
          id: 'load',
          title: 'Loading',
          duration_days: 7,
          items: [
            {
              id: 'c-load',
              title: 'Creatine',
              scheduled_time: '07:00',
              dose: '20 g',
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
        {
          id: 'maint',
          title: 'Maintenance',
          duration_days: null,
          items: [
            {
              id: 'c-maint',
              title: 'Creatine',
              scheduled_time: '07:00',
              dose: '10 g',
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    },
    'Doubled maintenance, dropped the lift',
    'ai'
  );

  const versions = render('protocol-versions', ProtocolVersionsScreen, { id: phasedId });
  expect('protocol-versions', versions, [
    'Version History',
    'Creatine loading',
    'Current',
    'Coach', // authorship is stamped per version
    'Doubled maintenance, dropped the lift', // what the author SAID
    // …and what the save actually DID, under it. This is the payoff the
    // history never paid: `change_notes` was write-only, and there was no way
    // to see what a version changed or to go back to one.
    'dose 5 g → 10 g',
    'removed Lower body',
    'Restore', // …and the way back, on the superseded row only
  ]);
  // v1 is the start of the record, not a change, so it prints no diff.
  refute('protocol-versions', versions, ['no change to the items']);
}

// ---------------------------------------------------------------------------
// The two screens that turn a mission row from a dead end into a door
// (docs/spikes/protocol-interface-rethink.md §6.1, §6.4).
// ---------------------------------------------------------------------------
{
  console.log('15b. The mission item sheet and the per-item editor');

  const sheetProtocol = createProtocolWithVersion(
    db,
    { name: 'Evening ritual', type: 'supplement_stack', startedOn: todayISODate() },
    {
      schema: 2,
      phases: [
        {
          id: 'only',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'mag',
              title: 'Magnesium glycinate',
              scheduled_time: '21:00',
              dose: '400 mg',
              notes: 'Sleep latency, not sedation.',
              cadence: { kind: 'daily' },
            },
            {
              id: 'sauna',
              // Lands TODAY and again in two days, whatever weekday the suite
              // runs on — so its next occurrence is strictly later than
              // tomorrow and the sheet has a day worth naming.
              title: 'Sauna',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: {
                kind: 'weekdays',
                days: [isoWeekday(todayISODate()), ((isoWeekday(todayISODate()) + 1) % 7) + 1].sort(
                  (a, b) => a - b
                ),
              },
            },
            {
              id: 'zone2',
              title: 'Zone 2',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'quota', per_week: 3 },
            },
          ],
        },
      ],
    }
  );
  // The day is already committed by earlier sections, so the new protocol
  // reaches it the way a real edit does.
  rederiveMissionForDay(db, todayISODate());
  const rowsToday = new Map(
    db
      .all(
        `SELECT e.id, e.title FROM log_entries e
           JOIN daily_logs d ON d.id = e.daily_log_id
          WHERE d.date = ?`,
        [todayISODate()]
      )
      .map((r) => [r.title, r.id])
  );

  const magSheet = render('mission-item (daily)', MissionItemScreen, {
    id: rowsToday.get('Magnesium glycinate'),
  });
  expect('mission-item (daily)', magSheet, [
    'Magnesium glycinate',
    'Evening ritual', // which protocol put it there — the row itself cannot say
    '21:00',
    '400 mg',
    'Sleep latency, not sedation.', // the why-line, printed whole
    'Cadence',
    'Every day',
    'Skip today',
    'Move today', // today only, and named so: the item's own time is the editor's
    'Remove from today',
    'Edit this item',
    'Open Evening ritual',
  ]);
  // An item that lands every day has no "next" worth printing: tomorrow is
  // tomorrow, and the sheet suppresses the first projected day for exactly
  // that reason.
  refute('mission-item (daily)', magSheet, ['next ']);
  // Accent budget zero: this is a screen you read and choose from, and none of
  // these verbs is THE next action. `bg-pine` is the accent fill.
  magSheet !== null && !magSheet.includes('bg-pine')
    ? ok('mission-item spends no accent')
    : bad('mission-item drew an accent fill');

  const quotaSheet = render('mission-item (quota)', MissionItemScreen, {
    id: rowsToday.get('Zone 2'),
  });
  expect('mission-item (quota)', quotaSheet, ['3× a week', 'of 3 this week']);
  // A quota is an ALLOWANCE, not a day. It is spread across every remaining
  // day of the week until it is met, so printing a day for one would invent a
  // fact the plan does not hold.
  refute('mission-item (quota)', quotaSheet, ['next ']);

  // An item whose next occurrence is strictly later than tomorrow DOES get a
  // day, which is what makes the suppression above a rule rather than a bug.
  const saunaSheet = render('mission-item (next later)', MissionItemScreen, {
    id: rowsToday.get('Sauna'),
  });
  expect('mission-item (next later)', saunaSheet, ['next ']);

  // Snoozed: the verb exists only when there is something to undo, and it is
  // reachable from a PUSHED route at all only because the snoozed set left
  // useTodayMission for a module store.
  snoozeItem(rowsToday.get('Magnesium glycinate'));
  expect(
    'mission-item (snoozed)',
    render('mission-item (snoozed)', MissionItemScreen, {
      id: rowsToday.get('Magnesium glycinate'),
    }),
    ['Unsnooze']
  );
  unsnoozeItem(rowsToday.get('Magnesium glycinate'));
  refute(
    'mission-item (unsnoozed again)',
    render('mission-item (unsnoozed again)', MissionItemScreen, {
      id: rowsToday.get('Magnesium glycinate'),
    }),
    ['Unsnooze']
  );

  // A CARRIED row — the debt itself. Its cadence lands on yesterday only, so
  // today's row can only be the carry.
  const yesterdayIdx = ((isoWeekday(todayISODate()) + 5) % 7) + 1;
  const yesterday = shiftISODate(todayISODate(), -1);
  createProtocolWithVersion(
    db,
    {
      name: 'Debt block',
      type: 'training_block',
      startedOn: shiftISODate(todayISODate(), -7),
      carryOver: true,
    },
    {
      schema: 2,
      phases: [
        {
          id: 'p',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'owed',
              title: 'Owed session',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'weekdays', days: [yesterdayIdx] },
            },
          ],
        },
      ],
    }
  );
  rederiveMissionForDay(db, yesterday); // planned, and left untouched
  rederiveMissionForDay(db, todayISODate()); // …so today carries it
  const carriedId = db.get(
    `SELECT e.id FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ? AND e.title = 'Owed session'`,
    [todayISODate()]
  )?.id;
  const carriedSheet = render('mission-item (carried)', MissionItemScreen, { id: carriedId });
  expect('mission-item (carried)', carriedSheet, [
    'Owed from',
    '1 day late',
    // What *Remove* does to a debt, said where it can be acted on: the copy
    // goes, the obligation does not.
    'comes back tomorrow',
  ]);
  // Skipping a carried row settles the debt too, and *Put back* is then the
  // sheet's verb. The skip is made the way the HERO card makes it — a plain
  // setMissionStatus — because since 2026-09-23 that is the one definition
  // every surface shares, the sheet's own *Skip today* included.
  setMissionStatus(db, carriedId, 'skipped');
  const settled = render('mission-item (carried, skipped)', MissionItemScreen, { id: carriedId });
  expect('mission-item (carried, skipped)', settled, ['Put back']);
  refute('mission-item (carried, skipped)', settled, ['Tap the row on Home to put it back.']);
  const owedFrom = db.get(
    `SELECT e.status, json_extract(e.value, '$.skipped_via') AS via
       FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ? AND e.title = 'Owed session'`,
    [yesterday]
  );
  owedFrom?.status === 'skipped' && owedFrom.via === carriedId
    ? ok('mission-item (carried, skipped): the debt behind the copy is settled too')
    : bad('mission-item (carried, skipped): the original is still owed', JSON.stringify(owedFrom));

  // A row with no protocol behind it — a mode item, an experiment's
  // intervention, or (as here) a row whose protocol has since been deleted,
  // which `log_entries.protocol_id` ON DELETE SET NULL is designed to survive.
  // It draws the day's verbs and nothing else: there is no cadence to state
  // and no document to open.
  const ghostId = createProtocolWithVersion(
    db,
    { name: 'Retired block', type: 'daily_routine', startedOn: todayISODate() },
    {
      schema: 2,
      phases: [
        {
          id: 'g',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'ghost',
              title: 'Legacy step',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    }
  );
  rederiveMissionForDay(db, todayISODate());
  const ghostRow = db.get(
    `SELECT e.id FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
      WHERE d.date = ? AND e.title = 'Legacy step'`,
    [todayISODate()]
  )?.id;
  deleteProtocol(db, ghostId);
  const orphan = render('mission-item (no protocol)', MissionItemScreen, { id: ghostRow });
  expect('mission-item (no protocol)', orphan, ['Today', 'Skip today', 'Remove from today']);
  refute('mission-item (no protocol)', orphan, ['Cadence', 'Edit this item']);

  expect('mission-item (gone)', render('mission-item (gone)', MissionItemScreen, { id: 'nope' }), [
    'This item is no longer on today.',
  ]);

  // *Edit this item* on the sheet opens THE editor at that item (the per-item
  // editor folded into it on 2026-09-25). It is a FORM, so it carries no
  // plate; its one accent is Save.
  const itemEdit = render('protocol-edit (from the sheet)', ProtocolEditScreen, {
    id: sheetProtocol,
    item: 'mag',
  });
  expect('protocol-edit (from the sheet)', itemEdit, [
    'Magnesium glycinate',
    'Evening ritual', // the back control names the protocol
    'value="400 mg"',
    'Sleep latency, not sedation.', // the why-line is EDITABLE here
    'Why this is here', // …and the field says whose line it is
    '21:00', // the item's time, stated on its collapsed control
    'Every day',
    'aria-label="Remove Magnesium glycinate"',
  ]);

  // The time control is the iOS wheel since 2026-09-21 — the owner, on the
  // device checklist: "needs a real wheel like a calendar app". A native view
  // cannot render under node, and the seam decides that on the PLATFORM
  // (src/lib/ui/date-time-picker.ts) — so what the control draws here is the
  // fallback: C9's typed field inside the field device, holding the STORED
  // time rather than the wheel's park, with the sentence that says why there
  // is no wheel. Never a blank. The HH:MM the wheel itself writes is pinned
  // in db/protocols.test.mjs §14, where no component is needed. The editor
  // opens the control collapsed, so it is rendered open here on its own.
  isTimeWheelAvailable() === false && ArcTimePicker === null
    ? ok('the time-wheel seam reports absent off iOS, so the fallback is what renders')
    : bad('time-wheel seam', 'reported available under node');
  const timeOpen = render(
    'time-control (open, no wheel)',
    TimeControl,
    {},
    {
      time: '21:00',
      remind: false,
      itemLabel: 'Magnesium glycinate',
      defaultOpen: true,
      onChange: () => {},
    }
  );
  expect('time-control (open, no wheel)', timeOpen, [
    '>At<', // the field's caption, label voice
    'aria-label="Item time"',
    'value="21:00"', // the stored time, not the 07:00 park
    'The wheel arrives with the next app build.',
    'aria-label="Clear the time"', // the clear outlived the chips
    'Remind me',
  ]);
  // The six anchor chips are gone from this control. (They live on in
  // MoveControl, a mission row's Move today …, which is not this control.)
  refute('time-control (open, no wheel)', timeOpen, ['>09:00<', '>15:00<', '>18:00<']);
  // Slop pass 4 (§11.A): the build fact stays; "Type it here meanwhile" pointed
  // at the field directly above it. The time wheel merged after the third
  // walk's branch was cut and before it landed, so no walk had read it.
  refute('time-control (open, no wheel)', timeOpen, ['Type it here meanwhile']);

  // ── The row itself ───────────────────────────────────────────────────────
  // `accessibilityActions` has no web equivalent, so react-native-web emits
  // nothing for it and no HTML assertion can see it. The component is a plain
  // function, so the element tree is inspected directly — which is the only
  // honest way to prove a reader can reach the sheet at all.
  const rowTree = MissionItemRow({
    item: {
      id: 'x',
      title: 'Magnesium glycinate',
      category: 'Supplements',
      status: 'pending',
      scheduledTime: '21:00',
    },
    onToggle: () => {},
    onOpen: () => {},
  });
  const children = React.Children.toArray(rowTree.props.children);
  const checkbox = children.find((child) => child?.props?.accessibilityRole === 'checkbox');
  const chevron = children.find((child) => child?.props?.accessibilityElementsHidden === true);
  checkbox?.props?.accessibilityLabel?.includes('Magnesium glycinate') &&
  checkbox?.props?.accessibilityState?.checked === false
    ? ok('the mission row keeps its checkbox role and its spoken label')
    : bad('mission row role/label', JSON.stringify(checkbox?.props?.accessibilityLabel));
  checkbox?.props?.accessibilityActions?.length === 1 &&
  checkbox.props.accessibilityActions[0].name === 'open'
    ? ok('…and gains exactly one named action, so VoiceOver reaches the sheet')
    : bad('row actions', JSON.stringify(checkbox?.props?.accessibilityActions));
  // A SIBLING of the checkbox, not a child: an accessible Touchable collapses
  // its subtree on iOS, so a nested chevron could never be focused on its own.
  chevron !== undefined
    ? ok('…and the chevron is a sibling, hidden from assistive tech')
    : bad('no chevron sibling on the mission row');

  // ── The hub row's lead figure, in each of its forms ──────────────────────
  // It leads with what the protocol is DOING; adherence moved to the foot. The
  // cadence summary it replaced said "mixed" the moment two items disagreed.
  const quotaOnly = createProtocolWithVersion(
    db,
    { name: 'Walk block', type: 'daily_routine', startedOn: todayISODate() },
    {
      schema: 2,
      phases: [
        {
          id: 'w',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'walk',
              title: 'Long walk',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'quota', per_week: 3 },
            },
          ],
        },
      ],
    }
  );
  const pausedId = createProtocolWithVersion(
    db,
    { name: 'Resting block', type: 'therapy_protocol', startedOn: todayISODate() },
    {
      schema: 2,
      phases: [
        {
          id: 'r',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'sauna2',
              title: 'Contrast therapy',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    }
  );
  rederiveMissionForDay(db, todayISODate());
  db.run('UPDATE protocols SET is_active = 0 WHERE id = ?', [pausedId]);
  // A protocol whose one bounded phase ran out — still is_active = 1, and it
  // generates nothing, which is why the hub lists it apart.
  createProtocolWithVersion(
    db,
    {
      name: 'Finished course',
      type: 'supplement_stack',
      startedOn: shiftISODate(todayISODate(), -40),
    },
    {
      schema: 2,
      phases: [
        {
          id: 'f',
          title: null,
          duration_days: 7,
          items: [
            {
              id: 'course',
              title: 'Course dose',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    }
  );

  const hubNow = render('protocols (re-cut)', ProtocolsScreen);
  expect('protocols (re-cut)', hubNow, [
    ' today', // the lead figure — what it puts on today
    'today · next ', // …and the next day, on the protocol whose item is days away
    ' of 3 this wk', // …an allowance, for the quota-only protocol
    'paused',
    'Version',
  ]);
  // "mixed" is gone with contentCadenceSummary, and the description left the row.
  // The ended group's explainer went with A9's blanket approval (2026-09-19): the
  // rule is stated more fully on the DETAIL screen — with the date, beside the
  // control that extends a phase — so the hub line was the duplicate, not the
  // only home. Refuted here so a revert fails rather than quietly restoring it.
  refute('protocols (re-cut)', hubNow, [
    'mixed',
    'Sleep latency, not sedation.',
    'They put nothing on a day until a phase is extended or another is added.',
  ]);

  // The detail, re-cut: Coming up with its honesty line, and a quota item that
  // reads its ALLOWANCE on its Now row instead of appearing in the projection.
  const ritual = render('protocol-detail (re-cut)', ProtocolDetailScreen, { id: sheetProtocol });
  expect('protocol-detail (re-cut)', ritual, [
    'aria-label="Edit this protocol"', // the header action, where Settings was
    'Coming up',
    'next 6 days',
    'Projected from the plan. These days are not committed yet.',
    'Magnesium glycinate', // a Now row, tappable into the editor at that item
    'of 3', // the quota item's allowance, on its own row
  ]);
  // A quota never appears in Coming up: an allowance is not a day.
  const comingBlock = ritual === null ? '' : ritual.slice(ritual.indexOf('Coming up'));
  !comingBlock.includes('Zone 2')
    ? ok('protocol-detail: no quota item in Coming up')
    : bad('a quota item was projected onto a day');

  const pausedDetail = render('protocol-detail (paused)', ProtocolDetailScreen, { id: pausedId });
  expect('protocol-detail (paused)', pausedDetail, [
    'Paused',
    'Paused — puts nothing on a day',
    // The phase clock RUNS while paused by design — pausing a titration for a
    // fortnight must not put you back on week 1 — so the line stays true and
    // is prefixed rather than hidden.
    'clock reads',
    // The one-step way back, with its confirmation (the owner's answer).
    'Resume this protocol',
  ]);
  refute('protocol-detail (paused)', pausedDetail, ['Coming up', 'Pause this protocol']);

  // The longest real category string plus a carry mark plus Snoozed, on one
  // line. This proves the LINE, not its legibility at 375pt — that stays a
  // device question (docs/spikes/protocol-interface-rethink.md §11).
  const longRow = MissionItemRow({
    item: {
      id: 'y',
      title: 'A deliberately long supplement name that used to wrap',
      category: 'Medications',
      status: 'pending',
      scheduledTime: '21:00',
      carriedDays: 2,
      snoozed: true,
    },
    onToggle: () => {},
    onOpen: () => {},
  });
  const texts = [];
  const walk = (node) => {
    if (node === null || node === undefined || typeof node !== 'object') return;
    for (const child of React.Children.toArray(node.props?.children ?? [])) walk(child);
    if (node.props?.numberOfLines !== undefined) texts.push(node.props.numberOfLines);
  };
  walk(longRow);
  texts.length >= 2 && texts.every((n) => n === 1)
    ? ok('every run on the row line is held to one line, so the row cannot become two')
    : bad('row line limits', JSON.stringify(texts));
}

// —————————————————————————————————————————————————————————————————————————
// The number-pad check, checked. `keypadsDismissable` runs inside `render` and
// says nothing when a screen has no number pad — which is also exactly what it
// would do if the markup shape changed under it and the regex stopped matching.
// So: assert the walk actually FOUND pads, and that the predicate can still
// tell a trapped one from a dismissable one.
{
  console.log('\n16. The number-pad check can fail');
  // A floor, not the count: most numeric fields in the app sit inside editors
  // that open on a TAP, and a server render never opens one. What the walk does
  // reach (water's Add, recipe-edit's four, protocol-edit's phase lengths) is
  // enough to prove the regex still matches something.
  keypadsSeen >= 5
    ? ok(`the walk inspected ${keypadsSeen} number pads`)
    : bad(`the number-pad check is vacuous — only ${keypadsSeen} pads seen`);

  const trapped = findKeypads('<input inputMode="decimal" value=""/>');
  trapped.all.length === 1 && trapped.stuck.length === 1
    ? ok('a pad with no enterKeyHint is reported as trapped')
    : bad('a pad with no enterKeyHint was NOT reported as trapped');

  const freed = findKeypads('<input inputMode="numeric" enterKeyHint="done" value=""/>');
  freed.all.length === 1 && freed.stuck.length === 0
    ? ok('a pad with enterKeyHint is reported as dismissable')
    : bad('a pad with enterKeyHint was reported as trapped');

  // A full keyboard already has a return key and must not be demanded one.
  findKeypads('<input type="text" value=""/>').all.length === 0
    ? ok('a full keyboard is not held to the number-pad rule')
    : bad('a full keyboard was held to the number-pad rule');
}

{
  console.log('Settings › Apple Health — the sync log the owner will actually open');

  // This screen had no render coverage at all, which is uncomfortable given
  // what it is FOR: it is the surface a user opens when Apple Health has
  // already gone wrong, and the one added on 2026-08-26 to explain a silent
  // failure. A screen that throws while explaining a failure explains nothing.

  setHealthSyncEnabled(db, true);
  const never = render('settings-health (no sync yet)', SettingsHealthScreen);
  expect('settings-health (no sync yet)', never, [
    'Apple Health',
    'Last sync',
    'No sync has run yet.', // authored, never blank
  ]);
  // Nothing may be reported that has not happened. An empty log must not print
  // counts, and must not name a step as having succeeded or failed.
  refute('settings-health (no sync yet)', never, ['rows changed', 'Published out']);

  // Hydration — two-way since 2026-09-21 (it was read-only from 2026-09-14).
  // Three things have to be on this screen and all three are assertions rather
  // than intentions: the scope row with its direction, the audit row with its
  // verdict, and the sentence that makes the no-dedupe rule the user's to act
  // on. "Pick one door" survives the change: ARC's own glasses are kept out of
  // what comes back, but the same glass typed here AND tapped on the watch is
  // still two entries, and only the user can know that.
  //
  // Slop pass 4 (docs/ai-slop-candidates-2026-09.md §11.C): the paragraph ran
  // five sentences. "Water goes both ways." restated the scope row's Both tag
  // — pinned on its own just below, so the two-way fact is still asserted —
  // and the route's "where the two entries sit side by side" narrated the
  // water screen. Every fact survives: when a glass goes out, that corrections
  // follow, that ARC's own glasses are kept out of what comes back, the
  // pick-one-door rule, and where a doubled day is fixed.
  expect('settings-health (no sync yet)', never, [
    'Water (hydration)',
    // WHEN a glass goes out (2026-09-23): it used to wait for the next sync,
    // and this sentence did not say so.
    'is written to Apple Health as soon as you log it',
    'undoing or correcting it here changes it there too',
    'with ARC’s own glasses left out, so none is counted twice',
    'A glass tapped on the watch and typed here is two glasses — log it in one place.',
    'A doubled day is fixed in Data → Water.',
    // The audit row: the owner's device settled it (2026-09-21 checklist,
    // confirmed 2026-09-23), so the verdict is no longer `unverified`.
    'Confirmed on your phone: hydration logged in Garmin Connect arrives',
  ]);
  // The one-way sentence and the old unverified note must not survive anywhere.
  refute('settings-health (no sync yet)', never, [
    'Water is read, never written.',
    'Nothing in this repository establishes that Garmin writes hydration',
    // §11.C: the restatement of the tag, and the narration of the water screen.
    'Water goes both ways.',
    'where the two entries sit side by side',
    'log a glass in one place or the other, not both',
  ]);
  // §11.C, the rest of the screen read whole. Under node there is no HealthKit
  // module, so the status plate takes its build-gate branch: the fact and the
  // way out, without "this screen goes live — nothing else to set up" (after
  // the build there IS something to set up: Enable, and the permission sheet),
  // and without "dev build" — the owner's phone runs TestFlight builds. The
  // coverage legend keeps what "Never" means — not a sync delay — without the
  // idiom it was said in.
  expect('settings-health (no sync yet)', never, [
    'Rides the next build',
    'The HealthKit module isn’t in this build yet. Run the next EAS build (docs/dev-build.md).',
    'Never — it stays in Garmin Connect, and a later sync will not bring it.',
  ]);
  refute('settings-health (no sync yet)', never, [
    'this screen goes live',
    'nothing else to set up',
    'this dev build',
    'no amount of waiting',
  ]);
  // The scope row's own direction tag. `Both` alone proves nothing (the body
  // rows carry it too), so the check is scoped to the markup between the water
  // row's label and the next row's.
  {
    const from = never?.indexOf('Water (hydration)') ?? -1;
    const to = never?.indexOf('Sleep (duration and stages)') ?? -1;
    const between = from >= 0 && to > from ? never.slice(from, to) : '';
    between.includes('>Both<') && !between.includes('>In<')
      ? ok('settings-health: the water scope row is tagged Both, not In')
      : bad('settings-health: water scope direction', between.slice(0, 200));
  }

  setHealthSyncLog(db, {
    at: '2026-08-26T09:00:00.000Z',
    windowDays: 14,
    rowsWritten: 12,
    metrics: [
      {
        metric: 'hrv',
        label: 'hrv',
        returned: 40,
        rows: 14,
        exclusion: 'source',
        error: null,
        rejected: null,
      },
      {
        metric: 'weight_kg',
        label: 'Weight',
        returned: 0,
        rows: 0,
        exclusion: 'refused',
        error: 'predicate not supported',
        rejected: { arcTag: 0, arcBundle: 0, unattributed: 0, outOfBounds: 0, nonFinite: 0 },
      },
      {
        metric: 'body_fat_pct',
        label: 'Body fat',
        returned: 6,
        rows: 0,
        exclusion: 'metadata',
        error: null,
        rejected: { arcTag: 0, arcBundle: 0, unattributed: 6, outOfBounds: 0, nonFinite: 0 },
      },
      // D3b (docs §15). The row that makes "31 → 0" readable: every workout was
      // seen and none produced a heart rate, which has two causes the screen
      // cannot tell apart — the watch exporting nothing, and the read grant
      // having been declined. Only one is recoverable, and only the sentence
      // sends the owner to the place he can recover it.
      {
        metric: 'workout_hr',
        label: 'Heart rate during workouts',
        returned: 31,
        rows: 0,
        exclusion: 'none',
        error: null,
        rejected: null,
        detail: 'associated: ActiveEnergyBurned, HeartRate · by workout 0 · by source 0',
      },
    ],
    publish: {
      armed: true,
      stalled: false,
      attempted: 0,
      succeeded: 0,
      types: [],
    },
  });

  const logged = render('settings-health (logged)', SettingsHealthScreen);
  expect('settings-health (logged)', logged, [
    '14d window',
    'Weight',
    '0 → 0', // the shape of the whole answer: returned → kept
    'Apple Health refused both echo-suppression filters',
    'predicate not supported', // the native error, carried all the way to the screen
    'Skipped 6 with no readable source.', // the guard named, in words
    '40 → 14', // …and a healthy metric alongside it, so the zero means something
    '12 rows changed',
    'Armed —', // the deliberate zero, said out loud rather than left to look like a bug
  ]);
  // The armed pass attempted nothing, so no type may appear claiming it was
  // refused — a fabricated finding is worse than a missing one.
  refute('settings-health (logged)', logged, ['Waist circumference. 0 / 0']);
  // Slop pass 4 (§11.C): the legend says how to read the arrow, and stops. Its
  // second sentence promised a note under every gap, which the rows either
  // show or do not — the note itself is the evidence, not a promise about it.
  expect('settings-health (logged)', logged, [
    'Each row reads: measurements Apple Health returned → measurements ARC kept.',
  ]);
  refute('settings-health (logged)', logged, ['always explained on the line beneath it']);

  // D3b. Four things, and all four are on this screen or nowhere: the scope
  // row, the honest audit verdict, the log row's sentence, and the control
  // whose whole justification is that a late read scope asks nobody anything.
  expect('settings-health (logged)', logged, [
    'Heart rate during workouts',
    '31 → 0',
    // The generic error branch never fires here (returned > 0), so this
    // sentence exists only because the row has a branch of its own.
    'Privacy &amp; Security → Health → ARC → Heart Rate',
    'by workout 0 · by source 0', // the detail line: door 1 wrong vs Garmin silent
  ]);
  // It never claims a read grant, because iOS does not reveal one.
  refute('settings-health (logged)', logged, ['Heart rate access granted']);
  // The *Read heart rate (90 days)* control itself is NOT assertable here, and
  // the reason is structural rather than an omission: it lives inside the
  // connected plate, which under node takes the `!supported` branch ("Rides the
  // next build") because there is no HealthKit module to report. `allowPublishing`
  // has always been invisible here for the same reason. Its whole VISIBILITY
  // RULE is pure and pinned instead — `unaskedReadScopes` in
  // db/health-mapping.test.mjs §21 — so what a device settles is whether the
  // button is where it should be, not whether it appears when it should.
}

/**
 * 16. A2 — the back affordance, on every screen the recipe save path passes
 * through.
 *
 * The owner's *"after saving a recipe, sometimes the back button doesn't work"*
 * had two halves, and a headless render can see one of them. The half it sees:
 * the control EXISTS and is spoken as a back control on each of the four
 * screens a saved recipe is reached through. The half it cannot: whether the
 * stack it pops has anything under it — that is navigation state, and it is
 * pinned instead in db/recipe-import.test.mjs §10, which asserts the root
 * layout's anchor so a cold-start deep link is never the only route on the
 * stack. Together they cover the bug; neither does alone.
 *
 * `render()` is not re-used here because the point is the header, which every
 * one of these screens draws unconditionally — including the "this recipe is
 * gone" state, where a missing back control would strand the user completely.
 */
console.log('16. A2 — every screen in the recipe save path can be left again');
{
  const backAffordance = (name, html) => {
    if (html === null) return;
    // react-native-web renders StackHeader's Pressable as role="button" with
    // the spoken label; `parent` screens say "Back to <where>".
    const labels = [...html.matchAll(/aria-label="(Back(?: to [^"]*)?)"/g)].map((m) => m[1]);
    labels.length > 0
      ? ok(`${name}: the header's back control is present and spoken ("${labels[0]}")`)
      : bad(`${name}: no back affordance in the rendered header`);
  };

  const saved = createRecipe(db, {
    title: 'Saved from a share',
    source: 'import',
    source_url: 'https://www.instagram.com/reel/SAVED1/',
    source_platform: 'instagram',
    servings: 2,
    ingredients: [{ raw_text: '1 onion' }],
  });

  // The four screens: where a save lands, and the three that can perform one.
  backAffordance(
    'recipe-detail (after a save)',
    render('recipe-detail (after a save)', RecipeDetailScreen, { id: saved })
  );
  backAffordance(
    'recipe-detail (deleted under it)',
    render('recipe-detail (deleted under it)', RecipeDetailScreen, { id: 'gone' })
  );
  backAffordance('recipe-edit (new)', render('recipe-edit (back)', RecipeEditScreen));
  backAffordance(
    'recipe-edit (existing)',
    render('recipe-edit (back, existing)', RecipeEditScreen, { id: saved })
  );
  backAffordance('recipe-import', render('recipe-import (back)', RecipeImportScreen));
  backAffordance(
    'recipe-revise',
    render('recipe-revise (back)', RecipeReviseScreen, { id: saved })
  );
}

/**
 * 17. A3 — the amount fields select themselves on focus.
 *
 * Two halves, because neither is visible on its own.
 *
 * The BEHAVIOUR is asserted directly: `selectAllOnFocus` is a pure props
 * builder, so the handler it returns can be driven with a fake focus event and
 * asked what it did. That is the half that matters on device — iOS's New
 * Architecture reads `selectTextOnFocus` only inside the imperative `-focus`
 * command, so a TAP needs the `setSelection` call (the whole mechanism, with
 * the RN source it was read off, is in src/components/ui/select-on-focus.ts).
 *
 * The COVERAGE is asserted over source, not markup, and that is a real
 * limitation stated rather than hidden: react-native-web consumes
 * `selectTextOnFocus` in its own focus handler and emits nothing for it, and an
 * `onFocus` prop leaves no trace in HTML either — so unlike the number-pad rule
 * above, this one cannot be read off a render. The sweep keys on the spoken
 * label, which is what makes a field an AMOUNT field rather than a clock or a
 * name: every `decimal-pad` input whose label says "grams" — or, since 0047,
 * "millilitres" — must carry it.
 *
 * The label match spans NEWLINES, and that is the second thing this rule has
 * learned the hard way. When the unit became a choice the labels became
 * expressions, prettier wrapped them across three lines, and a `[^\n]*` pattern
 * silently stopped matching two of the seven fields — a coverage rule failing
 * OPEN. The count assertion below is what caught it, which is why it is there.
 */
console.log('17. A3 — every amount field in food logging highlights its value');
{
  const ev = (captured) => ({
    currentTarget: {
      setSelection: (start, end) => {
        captured.push([start, end]);
      },
    },
    target: null,
  });

  const props = selectAllOnFocus('250');
  props.selectTextOnFocus === true
    ? ok('the declarative half is set (web, Android, and an imperative focus())')
    : bad('selectTextOnFocus missing');
  let calls = [];
  props.onFocus(ev(calls));
  JSON.stringify(calls) === '[[0,3]]'
    ? ok('focusing a filled field selects the whole value (the iOS tap path)')
    : bad('setSelection on focus', JSON.stringify(calls));
  calls = [];
  selectAllOnFocus('').onFocus(ev(calls));
  calls.length === 0
    ? ok('an empty field selects nothing rather than spending a bridge command')
    : bad('empty field selected');
  // A host that predates the method must not crash the tap.
  let threw = null;
  try {
    selectAllOnFocus('12').onFocus({ currentTarget: {}, target: null });
  } catch (e) {
    threw = e;
  }
  threw === null
    ? ok('a host instance without setSelection degrades to the declarative half')
    : bad('onFocus threw', String(threw));

  // The sweep. Each file is a surface where a FOOD's amount gets changed.
  // The two estimator screens' amount fields moved into the SHARED review table
  // when composites arrived (0058) — app/meal-estimate.tsx and
  // app/meal-revise.tsx now draw the identical tree, and the fields are in one
  // file rather than two copies. The sweep follows them: the rule is about
  // surfaces where a FOOD's amount gets changed, and that is now where they are.
  const SURFACES = [
    'app/barcode-scan.tsx',
    'app/food-search.tsx',
    'app/meal-detail.tsx',
    'app/recipe-detail.tsx',
    'src/components/nutrition/estimate-review.tsx',
  ];
  let swept = 0;
  let missing = [];
  for (const file of SURFACES) {
    const source = readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
    for (const chunk of source.split('<TextInput').slice(1)) {
      const element = chunk.slice(0, chunk.indexOf('/>'));
      const isAmount =
        /keyboardType="decimal-pad"/.test(element) &&
        /accessibilityLabel=[\s\S]*?(?:grams|millilitres)/i.test(element);
      if (!isAmount) continue;
      swept++;
      if (!element.includes('selectAllOnFocus(')) {
        missing.push(`${file}: ${(/accessibilityLabel=([^\n]*)/.exec(element) ?? [])[1]}`);
      }
    }
  }
  // A regex that stopped matching anything would pass vacuously, so the count
  // is asserted too. It was SEVEN across six surfaces; it is now SIX across
  // five, and the missing one is not a regression: the estimator's review row
  // and the composite's whole-dish handle share one `AmountField` component
  // (0058), where app/meal-estimate.tsx and app/meal-revise.tsx previously held
  // a copy each. One field, two screens, two uses — the guarantee is unchanged
  // and there is one fewer place to forget it.
  swept >= 6
    ? ok(`${swept} amount fields found across ${SURFACES.length} food-logging surfaces`)
    : bad(`the sweep matched only ${swept} amount fields — the pattern has gone stale`);
  missing.length === 0
    ? ok('every one of them highlights its value on focus')
    : bad(`${missing.length} amount field(s) without selectAllOnFocus`, missing.join(' · '));
}

/**
 * 18. C1 — the nutrition history's day view.
 *
 * Three claims, and the third is the one that could have shipped a lie:
 *   - a PAST day renders its own meals, reachable from nowhere before this;
 *   - an EMPTY day is authored, not a row of zeros;
 *   - a CLOSED day never counts down. The fixture is built so the difference is
 *     visible: the past day is fully logged against a target it does not reach,
 *     so without `recordFigure` the screen would print "820 kcal left" over a
 *     day that is over.
 */
console.log('18. C1 — nutrition history: a day picker, a past day, and an authored empty');
{
  const now = todayISODate();
  const threeBack = shiftISODate(now, -3);
  const twoBack = shiftISODate(now, -2);

  // Targets that governed the past day — DELIBERATELY different from today's
  // 2,400, so the assertion below proves the day is judged by its own era's
  // targets rather than by whatever is set now.
  setNutritionTargets(db, {
    effective_date: threeBack,
    kcal: 2000,
    protein_g: 150,
    carbs_g: 200,
    fat_g: 60,
  });
  logMeal(db, {
    date: threeBack,
    time: '07:50',
    name: 'Past breakfast',
    kcal: 620,
    protein_g: 42,
    carbs_g: 68,
    fat_g: 20,
  });
  logMeal(db, {
    date: threeBack,
    time: '19:20',
    name: 'Past dinner',
    kcal: 560,
    protein_g: 38,
    carbs_g: 44,
    fat_g: 24,
  });

  const past = render('nutrition-history (a past day)', NutritionHistoryScreen, {
    date: threeBack,
  });
  expect('nutrition-history (a past day)', past, [
    'Past breakfast',
    'Past dinner',
    'Meals',
    // Judged by the targets that governed THAT day (2,000), not today's 2,400.
    '1,180 of 2,000 kcal',
    // The picker's controls and its way home, which exists only off today.
    'Previous food log',
    'Next food log',
    'Back to today',
  ]);
  // THE CLOSED-DAY RULE. A remainder is a claim about a day you can still act
  // on; Tuesday is over. Both readings are refuted, because the macro cells
  // carry the mode in their own labels.
  refute('nutrition-history (a past day)', past, [
    'kcal left',
    'kcal over',
    'Protein left',
    'Protein over',
  ]);

  // An empty day inside the record: authored, and not a zero. The sentence is
  // composed through dayPhrase, so this also proves the screen and the phrase
  // helper agree (the helper's own wording is pinned in db/day-boundary.test.mjs).
  const empty = render('nutrition-history (an empty day)', NutritionHistoryScreen, {
    date: twoBack,
  });
  expect('nutrition-history (an empty day)', empty, [
    `Nothing logged ${dayPhrase(twoBack, now)}.`,
    'Back to today',
  ]);
  refute('nutrition-history (an empty day)', empty, [
    'kcal left',
    'Meals',
    // A9 (2026-09-19): the over-time empty used to close "...Log meals with
    // calories and the trend fills in here." The requirement (a meal without
    // calories contributes nothing) is the fact and survives; the widget
    // narration does not.
    'the trend fills in',
  ]);

  // Today: the picker is home, so the return affordance has retired.
  const todayView = render('nutrition-history (today)', NutritionHistoryScreen, {});
  expect('nutrition-history (today)', todayView, ['Today', 'Over time', 'Daily average']);
  refute('nutrition-history (today)', todayView, ['Back to today']);

  // A `?date=` in the future cannot select a day that has not happened — the
  // param is clamped the same way the arrow is.
  const future = render('nutrition-history (a future param)', NutritionHistoryScreen, {
    date: shiftISODate(now, 30),
  });
  expect('nutrition-history (a future param)', future, ['Today']);
  refute('nutrition-history (a future param)', future, ['Back to today']);
}

/**
 * 19. C8 — the review marks an estimate, and cannot save one unconfirmed.
 *
 * The review is the third phase of an async ladder (fetch → model turn), so it
 * is unreachable from a server render of the whole screen. `ReviewDraft` is
 * exported for exactly this, and this is the only claim in C8 that a headless
 * unit test cannot make on its own: that the SCREEN leaves the field empty.
 */
console.log('19. C8 — the servings estimate is marked, and never pre-filled');
{
  /** The value actually sitting in the Servings field of a rendered review. */
  const servingsValue = (html) => {
    const tag = (html.match(/<input[^>]*aria-label="Servings"[^>]*>/) || [])[0] ?? '';
    return (/value="([^"]*)"/.exec(tag) || [])[1] ?? null;
  };

  const lines = [
    { raw_text: '800 g chicken thighs' },
    { raw_text: '500 g white rice' },
    { raw_text: '400 g broccoli' },
    { raw_text: '2 tbsp soy sauce' },
  ];
  const estimate = estimateServings('Chicken & Rice Bowl', lines);
  const baseDraft = {
    title: 'Chicken & Rice Bowl',
    servings: null,
    prep_min: null,
    cook_min: null,
    ingredients: lines,
    steps: ['Cook the rice.', 'Sear the chicken.'],
    source_url: null,
    source_platform: null,
    source_author: null,
    source_image_url: null,
    notes: null,
    deterministic: false,
    servings_estimate: estimate,
  };

  // (a) The source said nothing: the estimate is OFFERED, marked, and the field
  //     is empty — so the Save gate (which has always required a positive
  //     servings) makes an unconfirmed estimate unsaveable, not merely unsaved.
  const offered = render(
    'recipe-import review (estimated)',
    ReviewDraft,
    {},
    {
      draft: baseDraft,
      onSaved: () => {},
    }
  );
  expect('recipe-import review (estimated)', offered, [
    'ARC’s estimate',
    '≈ estimate',
    'About 3 servings.',
    '3 of 4 lines', // the coverage — the direction of the error, said out loud
    'main-course',
    'Use 3',
    'Use 3 servings', // the spoken label on the control that confirms it
  ]);
  servingsValue(offered) === ''
    ? ok('recipe-import review: the estimate is NOT in the field — it must be confirmed')
    : bad(
        'an unconfirmed estimate was pre-filled into the servings field',
        String(servingsValue(offered))
      );
  // The old sentence is the wrong one now: there IS something better than
  // "set it" to say when ARC can propose a number.
  refute('recipe-import review (estimated)', offered, ['The source didn’t say — set it.']);

  // (b) The caption stated a yield: it wins outright, the field carries it, and
  //     no estimate is drawn beside it to argue with the author.
  const statedDraft = { ...baseDraft, servings: 6 };
  const stated = render(
    'recipe-import review (stated yield)',
    ReviewDraft,
    {},
    {
      draft: statedDraft,
      onSaved: () => {},
    }
  );
  servingsValue(stated) === '6'
    ? ok('recipe-import review: a stated yield fills the field as it always did')
    : bad('a stated yield did not reach the field', String(servingsValue(stated)));
  refute('recipe-import review (stated yield)', stated, ['≈ estimate', 'ARC’s estimate', 'Use 3']);

  // (c) Nothing stated and nothing estimable: the screen asks, exactly as it
  //     did before C8.
  const bare = render(
    'recipe-import review (no estimate)',
    ReviewDraft,
    {},
    {
      draft: {
        ...baseDraft,
        ingredients: [{ raw_text: 'a handful of herbs' }],
        servings_estimate: null,
      },
      onSaved: () => {},
    }
  );
  expect('recipe-import review (no estimate)', bare, ['The source didn’t say — set it.']);
  refute('recipe-import review (no estimate)', bare, ['≈ estimate']);

  /**
   * D1 — the video-stills rung's three review changes.
   *
   * Same argument as C8 above: these live on a phase no server render of the
   * whole screen can reach, and what they claim is a HONESTY rule (this draft
   * came off a video, it cost this much, and these lines have no amount because
   * the audio was not heard). A rule about what the screen says is worth proving
   * against the screen.
   */
  const sampledDraft = {
    ...baseDraft,
    servings: 4,
    ingredients: [
      { raw_text: '2 tbsp miso', qty: 2, unit: 'tbsp', name: 'miso' },
      { raw_text: 'miso paste', qty: null, unit: null, name: 'miso paste' },
      { raw_text: 'soy sauce, to taste', qty: null, unit: null, name: 'soy sauce' },
    ],
    servings_estimate: null,
    sampling: {
      stills: 10,
      everySeconds: 44 / 9,
      usage: { inputTokens: 5000, outputTokens: 600, cacheReadTokens: 0, cacheWriteTokens: 0 },
    },
  };
  const sampled = render(
    'recipe-import review (from a video)',
    ReviewDraft,
    {},
    { draft: sampledDraft, onSaved: () => {} }
  );
  expect('recipe-import review (from a video)', sampled, [
    // The eyebrow says which rung produced it — twelve characters, inside the
    // seventeen the accessory slot already holds.
    '≈ from video',
    // The measurements, in mono, ending in the Coach's own cost caption.
    '10 stills',
    'about 1 per 4.9 s',
    '5.0k in',
    '600 out',
    // …and the caveat, over the two lines the video could not put a number on.
    'These lines carry no amount',
    'the video’s audio was not read',
  ]);
  refute('recipe-import review (from a video)', sampled, [
    // It is not the generic AI eyebrow any more, and it must never claim the
    // ingredients were SHOWN — for an unlabelled jar that would be the app
    // asserting what the model judged.
    '≈ extracted',
    'were shown',
  ]);

  // Every line priced: nothing was unheard, so nothing is explained away —
  // the caveat is computed from the lines, not from the fact of being a video.
  const allPriced = render(
    'recipe-import review (video, every amount read)',
    ReviewDraft,
    {},
    {
      draft: {
        ...sampledDraft,
        ingredients: [{ raw_text: '2 tbsp miso', qty: 2, unit: 'tbsp', name: 'miso' }],
      },
      onSaved: () => {},
    }
  );
  expect('recipe-import review (video, every amount read)', allPriced, ['≈ from video']);
  refute('recipe-import review (video, every amount read)', allPriced, [
    'These lines carry no amount',
  ]);

  // And with no `sampling` at all — every other rung — none of it is drawn,
  // including over a draft whose lines happen to carry no amounts.
  const unsampled = render(
    'recipe-import review (not a video)',
    ReviewDraft,
    {},
    {
      draft: {
        ...baseDraft,
        servings: 4,
        ingredients: [{ raw_text: 'miso paste', qty: null, unit: null, name: 'miso paste' }],
        servings_estimate: null,
      },
      onSaved: () => {},
    }
  );
  expect('recipe-import review (not a video)', unsampled, ['≈ extracted']);
  refute('recipe-import review (not a video)', unsampled, [
    '≈ from video',
    'stills',
    'These lines carry no amount',
  ]);
}

/**
 * 20. 0059 — a composite says how many pieces it is.
 *
 * Numbered above the maximum rather than by position: this file's order is
 * non-monotonic (§7b at :995 follows §8 at :989), so "the next one down" is not
 * a number.
 *
 * TWO SURFACES, and they are split for a reason a device pass should know
 * about. The logged row's sub-line renders from `meal-detail` directly. The
 * count CONTROL lives inside a disclosure whose open/closed state is local
 * React state, so a server render always draws it collapsed — the same wall
 * §19 hit, and the same answer: assert the control through the exported
 * component that owns it (`ReviewItemsPlate`, which both estimator screens
 * draw). What a server render still cannot say is whether `meal-detail`'s own
 * copy of those rows reads well once expanded; that is a device claim.
 */
console.log('20. 0059 — the count of pieces, on the record and on the control');
{
  // RE-CUT 2026-09-23 on the owner's device note: *"grams are still being used
  // as the unit of measurement, when it should've changed to slices. and the
  // whole interaction when slices comes up is funky."* Every surface below that
  // prints a counted dish's amount now prints it in pieces, and the control is
  // one sentence — ATE [3] OF [8] SLICES — instead of a field whose label
  // switched from THIS IS to I ATE as it moved up a row.
  const today = todayISODate();
  // A counted pizza: 270 g of parts, said to be three slices.
  const { mealId: countedId } = logMealWithItems(db, {
    date: today,
    time: '18:40',
    name: 'Three slices',
    items: [
      {
        name: 'Pepperoni pizza',
        serving_qty: 3,
        piece_name: 'slice',
        components: [
          { name: 'Pizza crust', amount: 170, kcal: 450, protein_g: 15 },
          { name: 'Mozzarella', amount: 100, kcal: 300, protein_g: 22 },
        ],
      },
    ],
  });
  const counted = render('meal-detail (counted)', MealDetailScreen, { id: countedId });
  // THE RECORD: the count leads, in pieces; the grams follow in brackets.
  expect('meal-detail (counted)', counted, ['3 slices (270 g)']);
  refute('meal-detail (counted)', counted, ['3 × slice']);

  // MIXED UNITS: 0058 invariant 5 refuses a fabricated amount, so the count is
  // the only whole-dish figure the row has — and it still prints.
  const { mealId: mixedId } = logMealWithItems(db, {
    date: today,
    time: '18:45',
    name: 'Affogato, thirds',
    items: [
      {
        name: 'Affogato',
        serving_qty: 3,
        piece_name: 'glass',
        components: [
          { name: 'Espresso', amount: 60, unit: 'ml', kcal: 5 },
          { name: 'Gelato', amount: 90, unit: 'g', kcal: 200 },
        ],
      },
    ],
  });
  const mixed = render('meal-detail (mixed units)', MealDetailScreen, { id: mixedId });
  expect('meal-detail (mixed units)', mixed, ['3 glasses']);
  refute('meal-detail (mixed units)', mixed, ['3 glasses (', '3 × glass']);

  // THE ADJUST SCREEN's "As logged" plate printed a composite's summed grams
  // straight off fmtAmount and never asked whether it was counted — so the same
  // three slices read `270 g` there. Drawn from its own export, because the
  // screen only draws it once a model key is set.
  const loggedPlate = render(
    'meal-revise "As logged" (counted)',
    AsLoggedPlate,
    {},
    {
      tree: assembleMealItems(listMealItems(db, countedId)),
      volume: 'ml',
    }
  );
  expect('meal-revise "As logged" (counted)', loggedPlate, [
    '3 slices',
    // The grams are still on the plate — on the parts, drawn open beneath it.
    '170 g',
    '100 g',
  ]);
  refute('meal-revise "As logged" (counted)', loggedPlate, ['270 g', '3 × slice']);
  const { mealId: uncountedId } = logMealWithItems(db, {
    date: today,
    time: '18:50',
    name: 'A whole pizza',
    items: [
      {
        name: 'Margherita',
        components: [
          { name: 'Pizza crust', amount: 400, kcal: 1000 },
          { name: 'Mozzarella', amount: 320, kcal: 900 },
        ],
      },
    ],
  });
  expect(
    'meal-revise "As logged" (uncounted)',
    render(
      'meal-revise "As logged" (uncounted)',
      AsLoggedPlate,
      {},
      {
        tree: assembleMealItems(listMealItems(db, uncountedId)),
        volume: 'ml',
      }
    ),
    // A dish with no count still reads in grams, exactly as before.
    ['720 g']
  );

  // THE CONTROL. Both states of the same expanded composite, through the plate
  // the two estimator screens share.
  const part = (name, amount, kcal, protein = null) => ({
    key: `p-${name}`,
    name,
    foodId: null,
    food: undefined,
    confidence: 'medium',
    unit: 'g',
    base: {
      amount,
      kcal,
      protein_g: protein,
      carbs_g: null,
      fat_g: null,
      fiber_g: null,
      micros: null,
    },
    amountText: String(amount),
  });
  const composite = (pieces, wholeCount, components) => [
    {
      ...part('Pepperoni pizza', 0, 0),
      key: 'pizza',
      name: 'Pepperoni pizza',
      components,
      expanded: true,
      scaleFrom: null,
      pieces,
      wholeCount,
      countText: null,
      wholeText: null,
      countFrom: null,
    },
  ];
  const noop = () => {};
  const handlers = {
    onAmountChange: noop,
    onRemove: noop,
    onToggle: noop,
    onScale: noop,
    onScaleTo: noop,
    onScaleBegin: noop,
    onScaleEnd: noop,
    onCountChange: noop,
    onWholeChange: noop,
    onCountBegin: noop,
    onCountEnd: noop,
    onPiecesName: noop,
  };
  /** The value a labelled field holds in the markup, or null when it is absent. */
  const fieldValue = (html, label) =>
    (new RegExp(`<input[^>]*aria-label="${label}"[^>]*value="([^"]*)"`).exec(html ?? '') ??
      [])[1] ?? null;

  // UNCOUNTED: a whole pizza as priced, 720 g.
  const uncounted = render(
    'review plate (uncounted)',
    ReviewItemsPlate,
    {},
    {
      rows: composite(null, null, [part('Crust', 400, 800), part('Cheese', 320, 750)]),
      label: 'Items',
      emptyNote: 'x',
      handlers,
    }
  );
  expect('review plate (uncounted)', uncounted, [
    // The sentence's labels, set in the label voice and uppercased by it.
    '>Ate<',
    '>of<',
    'Pieces in Pepperoni pizza',
    '>pieces<',
    // An uncounted dish's amount is still its grams, in the whole-dish field…
    'Pepperoni pizza grams',
    // …and "I ate half" is still one tap away.
    'I ate half of the Pepperoni pizza',
  ]);
  fieldValue(uncounted, 'Pieces in Pepperoni pizza') === ''
    ? ok('review plate (uncounted): OF waits empty for the declaration')
    : bad('uncounted OF value', String(fieldValue(uncounted, 'Pieces in Pepperoni pizza')));
  refute('review plate (uncounted)', uncounted, [
    // ATE is an em-dash, not a field, until the dish has an OF.
    'Pepperoni pizza, pieces eaten',
    // The noun is a readout, not a control, while there is no count to name.
    'Name one piece of Pepperoni pizza',
    // The old field's switching label is gone for good.
    'This is',
  ]);

  // COUNTED: ate 3 of 8 — the parts already scaled to three eighths.
  const countedPlate = render(
    'review plate (counted)',
    ReviewItemsPlate,
    {},
    {
      rows: composite({ name: 'slice', count: 3 }, 8, [
        part('Crust', 150, 300, 10),
        part('Cheese', 120, 281.25, 12),
      ]),
      label: 'Items',
      emptyNote: 'x',
      handlers,
    }
  );
  expect('review plate (counted)', countedPlate, [
    // The dish's amount, in the column the grams field stands in for an
    // uncounted one — and the grams demoted to the head of the sub-line.
    '>3 slices<',
    // …the grams LEADING the sub-line, ahead of the macros they now follow.
    '>270 g · P 22g<',
    // The one control.
    'Pepperoni pizza, pieces eaten',
    'Pieces in Pepperoni pizza',
    'Name one piece of Pepperoni pizza',
    '>slices<',
  ]);
  fieldValue(countedPlate, 'Pepperoni pizza, pieces eaten') === '3' &&
  fieldValue(countedPlate, 'Pieces in Pepperoni pizza') === '8'
    ? ok('review plate (counted): the sentence holds ate [3] of [8]')
    : bad(
        'counted field values',
        `${fieldValue(countedPlate, 'Pepperoni pizza, pieces eaten')} of ${fieldValue(countedPlate, 'Pieces in Pepperoni pizza')}`
      );
  // …and it reads as ONE sentence, in order, in one row's markup.
  const at = (s) => (countedPlate ?? '').indexOf(s);
  at('>Ate<') < at('aria-label="Pepperoni pizza, pieces eaten"') &&
  at('aria-label="Pepperoni pizza, pieces eaten"') < at('>of<') &&
  at('>of<') < at('aria-label="Pieces in Pepperoni pizza"') &&
  at('aria-label="Pieces in Pepperoni pizza"') < at('>slices<') &&
  at('>Ate<') > at('Cheese')
    ? ok('review plate (counted): ATE [3] OF [8] SLICES, in that order, under the parts')
    : bad('sentence order');
  refute('review plate (counted)', countedPlate, [
    // Grams no longer lead a counted dish: its whole-dish grams field is gone…
    'Pepperoni pizza grams',
    // …and so are the chips, which on a counted dish could only print 2.7 slices.
    'I ate half of the Pepperoni pizza',
    '3 × slice',
    'This is',
  ]);

  // A RECORD'S COUNT — the Adjust screen's rows, built from a logged meal: the
  // count eaten, and no whole. There is no OF to type the pizza's eight into.
  const recordPlate = render(
    'review plate (a record’s count)',
    ReviewItemsPlate,
    {},
    {
      rows: composite({ name: 'slice', count: 3 }, null, [
        part('Crust', 150, 300),
        part('Cheese', 120, 281.25),
      ]),
      label: 'Revised',
      emptyNote: 'x',
      handlers,
    }
  );
  expect('review plate (a record’s count)', recordPlate, [
    '>3 slices<',
    'Pepperoni pizza, pieces eaten',
    'Name one piece of Pepperoni pizza',
    '>slices<',
  ]);
  fieldValue(recordPlate, 'Pepperoni pizza, pieces eaten') === '3'
    ? ok('review plate (a record’s count): ate [3] slices')
    : bad('record field value', String(fieldValue(recordPlate, 'Pepperoni pizza, pieces eaten')));
  refute('review plate (a record’s count)', recordPlate, [
    'Pieces in Pepperoni pizza',
    '>of<',
    'Pepperoni pizza grams',
    'I ate half of the Pepperoni pizza',
  ]);

  // One slice is a slice.
  const onePlate = render(
    'review plate (one of one)',
    ReviewItemsPlate,
    {},
    {
      rows: composite({ name: 'slice', count: 1 }, 1, [part('Crust', 90, 180)]),
      label: 'Items',
      emptyNote: 'x',
      handlers,
    }
  );
  expect('review plate (one of one)', onePlate, ['>1 slice<', '>slice<']);
  refute('review plate (one of one)', onePlate, ['1 slices']);
}

// -------------------------------------------------------------------------
console.log('\n21. The Plan screen — today, a day ahead, and the past days behind it');
{
  // The only headless gate on app/mission-day.tsx: its `useState` initializer
  // reads the day, and on a FUTURE day that read is a whole `planForDay` with
  // the projection rules. A crash there is a crash on the first render.
  const today = todayISODate();
  const tomorrow = shiftISODate(today, 1);
  const longAgo = shiftISODate(today, -30);

  createProtocolWithVersion(
    db,
    { name: 'Day picker check', type: 'daily_routine', startedOn: today },
    {
      schema: 2,
      phases: [
        {
          id: 'dp',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'walk',
              title: 'Evening walk',
              scheduled_time: '19:00',
              dose: null,
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    }
  );
  rederiveMissionForDay(db, today);

  // TODAY. The way home has retired, because it is satisfied.
  const onToday = render('mission-day (today)', MissionDayScreen, {});
  expect('mission-day (today)', onToday, [
    'Plan',
    'Back to Home',
    'Previous mission',
    'Next mission',
    'Today',
    'Evening walk',
    'The day',
  ]);
  refute('mission-day (today)', onToday, ['Back to today']);

  // A DAY AHEAD. The chin says Tomorrow, the way home is back, and the rows are
  // spoken as PLANNED — on a day that has not happened, "not done" is a claim
  // about a miss that cannot have occurred yet.
  const ahead = render('mission-day (tomorrow)', MissionDayScreen, { date: tomorrow });
  // The way home is asserted on its visible words: its aria-label carries an
  // apostrophe, which react-dom escapes to `&#x27;`, and a test that matched
  // the raw label would be asserting the escaping rather than the control.
  expect('mission-day (tomorrow)', ahead, ['Tomorrow', 'Evening walk', 'planned', 'Back to today']);
  refute('mission-day (tomorrow)', ahead, ['not done']);
  // AND NOTHING WAS WRITTEN BY LOOKING. This is the rule the whole design rests
  // on, and a render is the only place it can be observed end to end.
  db.get('SELECT count(*) c FROM daily_logs WHERE date = ?', [tomorrow]).c === 0
    ? ok('mission-day (tomorrow) wrote no daily_log — a future day is computed, never committed')
    : bad('rendering a future day committed it');

  // A PAST DAY nobody ever opened: authored in one sentence, never a blank and
  // never a grid of zeros.
  const past = render('mission-day (a day nobody opened)', MissionDayScreen, { date: longAgo });
  expect('mission-day (a day nobody opened)', past, [
    'No plan was generated on this day.',
    'Back to today',
  ]);
  refute('mission-day (a day nobody opened)', past, ['The day', 'Evening walk']);

  // A PAST DAY INSIDE THE WINDOW, holding a carried copy. The row is drawn and
  // says in one serif line where the gesture belongs — never a checkbox that
  // silently refuses.
  const fiveBack = shiftISODate(today, -5);
  const fourBack = shiftISODate(today, -4);
  createProtocolWithVersion(
    db,
    {
      name: 'Backfill check',
      type: 'therapy_protocol',
      startedOn: fiveBack,
      carryOver: true,
    },
    {
      schema: 2,
      phases: [
        {
          id: 'bf',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'sauna',
              title: 'Sauna session',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'every_n_days', n: 5 },
            },
          ],
        },
      ],
    }
  );
  generateMissionForDay(db, fiveBack); // left untouched: the debt
  generateMissionForDay(db, fourBack); // re-offers it as a carried copy
  const carriedDay = render('mission-day (a carried copy in the past)', MissionDayScreen, {
    date: fourBack,
  });
  expect('mission-day (a carried copy in the past)', carriedDay, [
    'Sauna session',
    'live on today',
    'tick it there',
  ]);
  refute('mission-day (a carried copy in the past)', carriedDay, ['This day is settled']);

  // A PAST DAY BEYOND IT. One line for the whole day: a miss older than a week
  // is a fact about the protocol, which is what mission-history answers.
  const tenBack = shiftISODate(today, -10);
  createProtocolWithVersion(
    db,
    { name: 'Old course', type: 'daily_routine', startedOn: shiftISODate(today, -12) },
    {
      schema: 2,
      phases: [
        {
          id: 'oc',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'dose',
              title: 'Old dose',
              scheduled_time: null,
              dose: null,
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    }
  );
  generateMissionForDay(db, tenBack);
  const settled = render('mission-day (beyond the carry window)', MissionDayScreen, {
    date: tenBack,
  });
  expect('mission-day (beyond the carry window)', settled, [
    'Old dose',
    'More than a week back, the record stands as it is.',
  ]);
  // Slop pass 3 (§10): the line opened "This day is settled." and then said it
  // again with the boundary attached. The boundary and the consequence are the
  // fact; the restatement may not come back.
  refute('mission-day (beyond the carry window)', settled, ['This day is settled']);

  // A `?date=` past the horizon is clamped, exactly as the arrow is.
  const beyond = render('mission-day (beyond the horizon)', MissionDayScreen, {
    date: shiftISODate(today, 60),
  });
  expect('mission-day (beyond the horizon)', beyond, ['Plan']);
  refute('mission-day (beyond the horizon)', beyond, ['2026-1']);

  // And Home draws BOTH links, under the list. (The hints are iOS-only and
  // react-native-web emits nothing for them, so what is asserted here is the
  // words and the count — the device checks the rest.)
  const home = render('home (the two links)', HomeScreen);
  expect('home (the two links)', home, ['Protocols', 'Plan']);
  (home.match(/aria-label="Plan"/g) || []).length === 1
    ? ok('home draws exactly one Plan link')
    : bad('the Plan link is missing or duplicated');

  // THE EMPTY DAY IS THE ONE THAT MOST NEEDS THEM. An every-3-days stack has
  // empty days by design, and those are the days worth checking tomorrow on —
  // so the links sit outside the `planned` branch. Every protocol is paused
  // here, then put back, so the surrounding suite is undisturbed.
  const active = db.all('SELECT id FROM protocols WHERE is_active = 1').map((r) => r.id);
  for (const id of active) db.run('UPDATE protocols SET is_active = 0 WHERE id = ?', [id]);
  db.run(
    `DELETE FROM log_entries WHERE daily_log_id IN
            (SELECT id FROM daily_logs WHERE date = ?)`,
    [today]
  );
  const emptyHome = render('home (an empty day)', HomeScreen);
  expect('home (an empty day)', emptyHome, ['Protocols', 'Plan']);
  (emptyHome.match(/aria-label="Plan"/g) || []).length === 1
    ? ok('…and an empty day draws them too, which is the day that most needs them')
    : bad('the empty day lost the Plan link');
  for (const id of active) db.run('UPDATE protocols SET is_active = 1 WHERE id = ?', [id]);
  rederiveMissionForDay(db, today);
}

/**
 * 22. The set clock fills from the right. Owner, on device, 2026-09-23:
 * *"plank time should not require me to put in a colon, should automatically
 * fill right to left"*.
 *
 * What a render proves is the half a keystroke cannot: that every set grid's
 * time field is a NUMBER PAD — react-native-web turns `number-pad` into
 * `inputMode="numeric"`, while the retired `numbers-and-punctuation` emits no
 * inputMode at all, so the attribute IS the keyboard — that it carries the Done
 * bar (`enterKeyHint`), and that a duration the field did not type itself draws
 * as its clock: a stored set in the editor, and a draft on resume. The
 * keystrokes are pure rules, pinned in db/exercise.test.mjs §12; a server render
 * fires no events.
 */
console.log(
  '\n22. The set clock — a number pad in every set grid, and a stored 90 s set draws 1:30'
);
{
  /** Every `<input>` whose aria-label starts with `label`, as attribute maps, in document order. */
  const inputsFor = (html, label) =>
    (html?.match(/<input[^>]*>/g) || [])
      .filter((tag) => tag.includes(`aria-label="${label}`))
      .map((tag) =>
        Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
      );
  const clockPad = (name, input, draws) => {
    if (!input) {
      bad(`${name}: no time field rendered`);
      return;
    }
    input.inputMode === 'numeric'
      ? ok(`${name}: the time field is a number pad, not the punctuation keyboard`)
      : bad(`${name}: time field keyboard`, JSON.stringify(input));
    input.enterKeyHint === 'done'
      ? ok(`${name}: …with the Done bar`)
      : bad(`${name}: no Done bar on the time field`);
    input.value === draws
      ? ok(`${name}: it draws "${draws}"`)
      : bad(`${name}: expected "${draws}"`, `value="${input.value}"`);
  };

  // THE EDITOR. A stored plank of 90 s, and a run long enough to need the hour.
  const storedId = logWorkout(db, { date: todayISODate(), kind: 'strength' }, [
    { exercise: 'Plank', exerciseId: 'plank', durationSec: 90 },
    {
      exercise: 'Treadmill Run',
      exerciseId: 'treadmill-run',
      durationSec: 5450,
      distanceM: 8000,
    },
  ]);
  const editor = render('workout-live (editing a stored session)', WorkoutLiveScreen, {
    workoutId: storedId,
  });
  expect('workout-live (editing a stored session)', editor, [
    'Plank',
    'Treadmill Run',
    'mm:ss', // the column label, in the label voice, unchanged
    'Save changes',
  ]);
  const [plankTime, runTime] = inputsFor(editor, 'Time for set 1');
  clockPad('workout-live (editing) · a stored 90 s plank', plankTime, '1:30');
  clockPad('workout-live (editing) · a stored 5,450 s run', runTime, '1:30:50');

  // THE LIVE LOGGER, RESUMED. Three sets, three ways a time reaches the field.
  saveWorkoutDraft(db, 'live', {
    version: DRAFT_VERSION,
    startedAt: Date.now() - 5 * 60_000,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [
      {
        key: 1,
        exerciseId: 'plank',
        name: 'Plank',
        loggingType: 'duration',
        measures: 'time',
        mechanic: 'isolation',
        restSec: 60,
        prev: [],
        bestE1rm: null,
        linkedToNext: false,
        sets: [
          // Typed by the previous build on the punctuation keyboard, where a
          // bare number was SECONDS — so it must draw 1:30, not 0:90.
          { key: 1, weight: '', reps: '', rpe: '', time: '90', distance: '' },
          // Typed on the new field and left mid-number: not normalised until
          // commit, so it comes back exactly as it was left.
          { key: 2, weight: '', reps: '', rpe: '', time: '1:90', distance: '' },
          { key: 3, weight: '', reps: '', rpe: '', time: '', distance: '' },
        ].map((s) => ({ ...s, setType: 'normal', done: false, pr: false })),
      },
    ],
  });
  const resumed = render('workout-live (resumed draft)', WorkoutLiveScreen, { resume: '1' });
  expect('workout-live (resumed draft)', resumed, ['Plank', 'Finish workout']);
  clockPad(
    'workout-live (resumed) · a bare 90 from the old keyboard',
    inputsFor(resumed, 'Time for set 1')[0],
    '1:30'
  );
  clockPad(
    'workout-live (resumed) · a set left mid-typing',
    inputsFor(resumed, 'Time for set 2')[0],
    '1:90'
  );
  clockPad('workout-live (resumed) · an empty set', inputsFor(resumed, 'Time for set 3')[0], '');
  clearWorkoutDraft(db, 'live');

  // THE FREE-FORM LOGGER, RESUMED on a plank: its entry row is the other set grid.
  saveWorkoutDraft(db, 'manual', {
    version: DRAFT_VERSION,
    startedAt: Date.now(),
    mode: 'past',
    kind: 'strength',
    durationText: '',
    sets: [],
    exercise: 'Plank',
    repsText: '',
    weightText: '',
    timeText: '1:30',
    distanceText: '',
    measures: 'time',
    entryDirty: true,
  });
  const freeForm = render('workout-log (resumed on a plank)', WorkoutLogScreen, { resume: '1' });
  // The margin note says what is optional, and stops (slop pass 4, §11.D). It
  // had narrated the new field — "Type the digits and they fill from the right
  // — 1 3 0 is 1:30" — on a field that draws its own colon as the digits
  // arrive, under a `Time (mm:ss)` placeholder. The mechanism is still spoken
  // to VoiceOver by the field's own hint, pinned by source below, because
  // react-native-web drops accessibilityHint and a render cannot see it.
  expect('workout-log (resumed on a plank)', freeForm, ['>Time is optional.<']);
  // The margin note described the old field; it must not come back.
  refute('workout-log (resumed on a plank)', freeForm, [
    'A bare number is seconds',
    'they fill from the right',
    '1 3 0 is 1:30',
  ]);
  readFileSync(
    new URL('../src/components/exercise/duration-field.tsx', import.meta.url),
    'utf8'
  ).includes('accessibilityHint="Type the digits; they fill from the right."')
    ? ok('the clock field still tells VoiceOver how its digits fill')
    : bad('duration-field: the accessibility hint went with the margin note');
  clockPad(
    'workout-log (resumed on a plank)',
    inputsFor(freeForm, 'Time in minutes and seconds')[0],
    '1:30'
  );
  clearWorkoutDraft(db, 'manual');

  // THE SWEEP, over source: a keyboard type and an `onFocus` leave no trace a
  // render could show when the field is not on screen, so the rule that no set
  // grid kept its own clock input is read where it is written.
  const source = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  const GRIDS = ['app/workout-live.tsx', 'app/workout-log.tsx'];
  const field = source('src/components/exercise/duration-field.tsx');
  [...GRIDS.map(source), field].every(
    (text) => !text.includes('keyboardType="numbers-and-punctuation"')
  )
    ? ok('no set duration is typed on the punctuation keyboard any more')
    : bad('a set grid still offers keyboardType="numbers-and-punctuation"');
  GRIDS.every((file) => source(file).includes('<DurationField'))
    ? ok('both set grids draw the one DurationField')
    : bad('a set grid has its own time input');
  field.includes('keyboardType="number-pad"') &&
  field.includes('returnKeyType={KEYPAD_DONE}') &&
  field.includes('selectAllOnFocus(')
    ? ok('the field is a number pad with the Done bar, and still selects on focus (A3)')
    : bad('DurationField lost its keyboard, its Done bar or A3');

  // Leave the database as the section found it: Home renders next.
  deleteWorkout(db, storedId);
}

// -------------------------------------------------------------------------
console.log('\n17b. A blank metric is one tap from an Apple Health sync (2026-09-23)');
{
  // Owner, from the device: "when hrv is blank, put quick apple health sync
  // button there". Home itself cannot reach the control here — under node the
  // HealthKit module is absent, so every blank is the plain blank — which is
  // exactly the first assertion. The other states are drawn by rendering the
  // grid with the facts passed in (MetricsGrid), the way the status components
  // are rendered in isolation above. The decision behind each state is pinned
  // in db/readiness.test.mjs; this is that the screen DRAWS it.
  const today = todayISODate();
  const home = render('home (no HealthKit module in this build)', HomeScreen);
  expect('home (no HealthKit module in this build)', home, ['Metrics', 'HRV', 'No data yet']);
  refute('home (no HealthKit module in this build)', home, [
    // Never a sync that cannot run, and never a door to a screen with no switch.
    'Sync Apple Health',
    'Apple Health sync is off',
    'Syncing',
  ]);

  const metrics = [
    { id: 'sleep', label: 'Sleep', value: '7h 12m', detail: 'Deep 42m', level: 'good' },
    { id: 'hrv', label: 'HRV', value: '—', detail: 'No data yet', level: 'unknown' },
    { id: 'rhr', label: 'Resting HR', value: '—', detail: 'No data yet', level: 'unknown' },
    { id: 'steps', label: 'Steps', value: '4,210', detail: 'today', level: 'unknown' },
  ];
  const [y, m, d] = today.split('-').map(Number);
  const checkedAt = new Date(y, m - 1, d, 7, 2).toISOString();
  const logOf = (hrvReturned) => ({
    at: checkedAt,
    windowDays: 14,
    rowsWritten: 3,
    metrics: [
      ['hrv', hrvReturned],
      ['rhr', 14],
      ['sleep', 30],
      ['steps', 14],
    ].map(([metric, returned]) => ({
      metric,
      label: metric,
      returned,
      rows: returned > 0 ? 1 : 0,
      exclusion: 'source',
      error: null,
      rejected: null,
    })),
    publish: { armed: false, stalled: false, attempted: 0, succeeded: 0, types: [] },
  });
  const context = (over = {}) => ({
    link: 'connected',
    available: true,
    running: false,
    lastSyncedAt: checkedAt,
    failedAt: null,
    log: logOf(12),
    sources: [],
    today,
    ...over,
  });
  const grid = (name, over) =>
    render(
      name,
      MetricsGrid,
      {},
      {
        metrics,
        context: context(over),
        onSync: () => {},
        onOpenSettings: () => {},
      }
    );
  const count = (html, needle) => (html === null ? 0 : html.split(needle).length - 1);

  // THE OFFER — the blank becomes the control, and only the blanks do.
  const offer = grid('metrics (the offer)');
  expect('metrics (the offer)', offer, [
    'Sync Apple Health',
    `none as of ${clockFromISO(checkedAt)}`,
    // The whole cell speaks as one button.
    'aria-label="HRV, no reading today, none as of',
    // The readings beside it are untouched.
    '7h 12m',
    'Deep 42m',
    '4,210',
  ]);
  count(offer, '>Sync Apple Health<') === 2
    ? ok('exactly the two blank cells became the control; the two readings did not')
    : bad('the control landed on the wrong cells', String(count(offer, '>Sync Apple Health<')));
  // The em-dash is REPLACED, not joined: nothing is added around the grid.
  count(offer, '>—<') === 0
    ? ok('the control replaces the em-dash rather than sitting beside it')
    : bad('the blank and the control are both drawn');
  // No accent: Home's is spent on the hero, the stamps and the tab. Checked on
  // the SOURCE — react-native-web hashes class names away in this render, so a
  // search of the markup for `pine` could never fail.
  const stripSource = readFileSync(
    new URL('../src/components/home/metrics-strip.tsx', import.meta.url),
    'utf8'
  );
  !/pine/i.test(stripSource)
    ? ok('the control spends no accent (no pine class or colour anywhere in the strip)')
    : bad('the metrics strip reaches for the accent');

  // SYNCING — shown, and not tappable while it runs.
  const syncing = grid('metrics (a pass is running)', { running: true });
  expect('metrics (a pass is running)', syncing, ['Syncing', 'reading Apple Health']);
  refute('metrics (a pass is running)', syncing, ['>Sync Apple Health<']);
  count(syncing, 'aria-disabled="true"') >= 2
    ? ok('both syncing cells are disabled — a second pass cannot be started from them')
    : bad('a syncing cell is still tappable', String(count(syncing, 'aria-disabled="true"')));

  // SENT NONE — the statement is the news, and the cell is still the button the
  // owner asked for: the verb changes to "Sync again" rather than repeating the
  // first offer forever.
  const none = grid('metrics (Apple Health sends no HRV)', { log: logOf(0) });
  expect('metrics (Apple Health sends no HRV)', none, [
    'Apple Health sent none in 14 days',
    '>Sync again<',
    'aria-label="HRV, no reading today, Apple Health sent none in 14 days. Sync again."',
  ]);
  count(none, '>Sync Apple Health<') === 1 && count(none, '>Sync again<') === 1
    ? ok(
        'HRV says what the last pass found and offers Sync again; Resting HR still offers the first sync'
      )
    : bad(
        'wrong offer count',
        `${count(none, '>Sync Apple Health<')} / ${count(none, '>Sync again<')}`
      );
  count(none, '>—<') === 0
    ? ok('…and the sent-none cell replaces the em-dash too — nothing is added around the grid')
    : bad('a sent-none cell drew the blank and the control');

  // THE CAUSE — a Garmin among the recent sources, and the audit pins HRV as a
  // type a Garmin never exports. The owner's setup, and the likeliest HRV state
  // on his phone.
  const garmin = grid('metrics (a Garmin, which sends no HRV)', {
    log: logOf(0),
    sources: ['apple_health', 'garmin'],
  });
  expect('metrics (a Garmin, which sends no HRV)', garmin, [
    'Garmin never sends this to Apple Health',
    '>Sync again<',
  ]);
  refute('metrics (a Garmin, which sends no HRV)', garmin, ['Apple Health sent none in 14 days']);

  // FAILED — quiet and honest, and the retry is still there.
  const failedAt = new Date(y, m - 1, d, 9, 14).toISOString();
  const failed = grid('metrics (the last tap failed)', { failedAt });
  expect('metrics (the last tap failed)', failed, [
    `sync failed at ${clockFromISO(failedAt)}`,
    'Sync Apple Health',
  ]);

  // SWITCHED OFF — a door to the switch, never a sync.
  const off = grid('metrics (sync switched off)', { link: 'disconnected' });
  expect('metrics (sync switched off)', off, ['Connect', 'Apple Health sync is off']);
  refute('metrics (sync switched off)', off, ['>Sync Apple Health<', 'Syncing']);

  // MODULE ABSENT / DEVICE WITHOUT HEALTH DATA — the plain blank.
  for (const [name, over] of [
    ['metrics (module absent)', { link: 'unsupported' }],
    ['metrics (HealthKit unavailable)', { available: false }],
  ]) {
    const plain = grid(name, over);
    expect(name, plain, ['No data yet', 'aria-label="HRV, no data."']);
    refute(name, plain, ['>Sync Apple Health<', '>Connect<', 'Syncing']);
  }

  // The wearables ledger takes the statement half of the rule and not the
  // control (app/wearables.tsx says why). Under node the module is absent, so
  // it must keep "No data yet" even with a log on file that says "sent none" —
  // a log is only believed while the pipe it describes is running.
  setHealthSyncLog(db, logOf(0));
  const ledger = render('wearables (no HealthKit module in this build)', WearablesScreen);
  expect('wearables (no HealthKit module in this build)', ledger, ['HRV', 'No data yet']);
  refute('wearables (no HealthKit module in this build)', ledger, [
    'Apple Health sent none',
    'Sync Apple Health',
  ]);
}

// -------------------------------------------------------------------------
console.log('\n18. D4 — the timezone line reaches Home, and only on the day it happened');
{
  // LAST on purpose, and it cleans up after itself: a `timezone_changes` row is
  // read by the mission ledger (it excuses the day's skips) and by readiness's
  // baselines, so leaving one behind would quietly re-judge §10's and §14's
  // assertions from underneath them.
  const today = todayISODate();

  refute('home (no timezone change)', render('home', HomeScreen), ['Timezone changed']);

  db.run(
    `INSERT INTO timezone_changes
       (id, changed_at, from_offset_min, to_offset_min, from_local_date, to_local_date)
     VALUES ('render-tz', ?, -480, 60, ?, ?)`,
    [`${today}T20:00:00.000Z`, today, today]
  );
  const travelled = render('home (timezone changed today)', HomeScreen);
  expect('home (timezone changed today)', travelled, [
    // The fact, and the consequence that makes it worth one line on the one
    // screen that is meant to stay empty: the day is not 24 hours long.
    'Timezone changed (UTC−8 → UTC+1)',
    '15 hours long',
  ]);
  // It is a calendar fact, so it takes neither the accent nor a signal colour
  // (status-rail.tsx states that firewall in exactly this context).
  refute('home (timezone changed today)', travelled, ['You travelled', 'America/']);

  db.run(`DELETE FROM timezone_changes WHERE id = 'render-tz'`);
  refute('home (the row removed again)', render('home', HomeScreen), ['Timezone changed']);
}

// ---------------------------------------------------------------------------
// 22. Slop pass 3 (docs/ai-slop-candidates-2026-09.md §10) — the retired lines
// no page render in this suite reaches.
//
// One is a component that renders straight from props: the estimator's
// questions plate. The rest are Alert bodies (a native sheet — RN's Alert has
// no DOM), an accessibilityHint (react-native-web drops the prop, so a render
// cannot see it either way), the Coach's confirmation card (it imports the
// tools barrel, a directory import this harness does not resolve), and strings
// no screen here draws: the Coach's preview replies and two delivery notes the
// model relays. Those are a SOURCE SCAN, honest about being one — the
// long-press sweep in §0 is the precedent.
{
  console.log('\n22. Slop pass 3 — the retired lines, where a page render cannot reach them');

  // The questions plate is labelled by what is filed under it. "A few things"
  // was the "How it is going" shape (the list's §0) on the one plate that asks.
  const plate = render(
    'questions plate',
    QuestionsPlate,
    {},
    {
      questions: [
        {
          id: 'shots',
          ask: 'How many shots?',
          allowOther: false,
          options: [
            { label: 'One', effect: { kind: 'scale_item', name: 'Latte', factor: 1 } },
            { label: 'Two', effect: { kind: 'scale_item', name: 'Latte', factor: 2 } },
          ],
        },
      ],
      answers: {},
      otherFor: null,
      otherText: '',
      otherBusy: false,
      handlers: {
        onAnswer: () => {},
        onOpenOther: () => {},
        onOtherText: () => {},
        onApplyOther: () => {},
        onCancelOther: () => {},
      },
    }
  );
  expect('questions plate', plate, ['Questions', 'How many shots?']);
  refute('questions plate', plate, ['A few things']);

  // OTHER, IN PLACE (device round 3, item 60): "clicking on other should
  // instantly bring up typing and type directly into the other box". Open, the
  // chip IS the field — focused on arrival, Return answers it — and the chip it
  // replaced is gone from the row rather than drawn beside a well below.
  const shotsQ = {
    id: 'shots',
    ask: 'How many shots?',
    allowOther: true,
    options: [
      { label: 'Two', effect: { kind: 'scale_item', name: 'Latte', factor: 1 } },
      { label: 'Three', effect: { kind: 'scale_item', name: 'Latte', factor: 1.5 } },
    ],
  };
  const noop = () => {};
  const quietHandlers = {
    onAnswer: noop,
    onOpenOther: noop,
    onOtherText: noop,
    onApplyOther: noop,
    onCancelOther: noop,
  };
  const plateWith = (name, props) =>
    render(
      name,
      QuestionsPlate,
      {},
      {
        questions: [shotsQ],
        answers: {},
        otherFor: null,
        otherText: '',
        otherBusy: false,
        handlers: quietHandlers,
        ...props,
      }
    );
  const field = (html) =>
    html?.match(/<input[^>]*aria-label="Your answer to: How many shots\?"[^>]*>/)?.[0] ?? '';

  const closed = plateWith('questions plate (Other closed)', {});
  expect('questions plate (Other closed)', closed, [
    'Type another answer to: How many shots?',
    '>Other<',
  ]);
  field(closed) === ''
    ? ok('closed, Other is a chip and there is no field')
    : bad('closed Other drew a field', field(closed));

  const open = plateWith('questions plate (Other open)', { otherFor: 'shots' });
  const input = field(open);
  input !== ''
    ? ok('open, the answer field is drawn')
    : bad('open Other drew no field', open?.slice(0, 400));
  /\bautofocus\b/i.test(input)
    ? ok('…focused on arrival, so the keyboard is up in the same tap that opened it')
    : bad('the Other field does not autofocus', input);
  /enterkeyhint="done"/i.test(input)
    ? ok('…and Return is Done, which commits the answer (onSubmitEditing)')
    : bad('no Done key on the Other field', input);
  !/\bautofocus\b/i.test(closed ?? '')
    ? ok('…and nothing on the closed plate grabs focus')
    : bad('the closed plate autofocuses something');
  refute('questions plate (Other open)', open, [
    'Type another answer to: How many shots?', // the chip became the field
    '>Other<',
  ]);
  expect('questions plate (Other open, empty)', open, ['Cancel this typed answer', '>Cancel<']);
  // Two shots are still offered beside it — the field takes Other's slot only.
  expect('questions plate (Other open)', open, ['How many shots? Two', 'How many shots? Three']);

  const typing = plateWith('questions plate (Other typed into)', {
    otherFor: 'shots',
    otherText: 'a triple, iced',
  });
  expect('questions plate (Other typed into)', typing, [
    'Apply this answer',
    '>Apply<',
    'a triple, iced',
  ]);
  const busy = plateWith('questions plate (Other applying)', {
    otherFor: 'shots',
    otherText: 'a triple, iced',
    otherBusy: true,
  });
  expect('questions plate (Other applying)', busy, ['Working…']);
  /readonly/i.test(field(busy))
    ? ok('…and the field is read-only while the answer is applied')
    : bad('field editable while busy', field(busy));

  // Answered by typing, the chip comes back filled with what was typed.
  const answeredTyped = plateWith('questions plate (answered by typing)', {
    answers: { shots: -1 },
    typed: { shots: 'a triple, iced' },
  });
  expect('questions plate (answered by typing)', answeredTyped, [
    'Change your typed answer to: How many shots?',
    'a triple, iced',
    '1 of 1',
  ]);

  // The markup shows autofocus and Done; that Return actually CALLS the apply
  // (onSubmitEditing) is a handler, invisible to a server render — so it is
  // pinned at the source, on the field itself.
  const reviewSrc = readFileSync(
    new URL('../src/components/nutrition/estimate-review.tsx', import.meta.url),
    'utf8'
  );
  const fieldSrc = reviewSrc.slice(
    reviewSrc.indexOf('function OtherField('),
    reviewSrc.indexOf('function QuestionsPlate(') > 0
      ? reviewSrc.indexOf('function QuestionsPlate(')
      : undefined
  );
  /<TextInput\s+autoFocus\b/.test(fieldSrc) &&
  fieldSrc.includes('onSubmitEditing=') &&
  fieldSrc.includes('returnKeyType="done"') &&
  !reviewSrc.includes('<Block device="well">')
    ? ok('the Other field focuses on arrival, submits on Return, and no well nests in the plate')
    : bad('Other field source pins', fieldSrc.slice(0, 300));

  // Everything else, by source. Each pattern is the CODE form of the line, so a
  // docblock that quotes a retired sentence (several do, as history) is not a
  // hit — and each target must exist and be read, or the scan fails loudly
  // rather than passing over nothing.
  const RETIRED = [
    // Eleven Alert and error bodies said "Please try again." — the only
    // "Please" in the app's copy. The house form is "Try again.": five sibling
    // error bodies end with it, and it is the label on every retry button.
    ['app', /'[^'\n]*Please try again[^'\n]*'/, 'Please try again'],
    ['src/components', /'[^'\n]*Please try again[^'\n]*'/, 'Please try again'],
    // Home's Protocols link: the editorial the 2026-09-15 pass cut from its
    // accessibilityLabel, back through the hint slot.
    ['app/(tabs)/index.tsx', /hint="What builds the day"/, 'the Protocols hint'],
    // The confirmation card's ON APPROVE lane ended "…, and the Coach carries
    // on from there" — the NOW lane above it already says the Coach is
    // suspended until you answer. Where the write goes, and that it happens
    // once, are the fact; they are pinned just below.
    [
      'src/components/coach/pending-write-card.tsx',
      /'[^'\n]*carries on from there[^'\n]*'/,
      'the ON APPROVE tail',
    ],
    // Save as template: a sheet opened by choosing to save a template.
    [
      'app/meal-detail.tsx',
      /'Name it so you can log it again in one tap\.'/,
      'the template sheet body',
    ],
    // The Coach's preview replies (no key connected).
    [
      'src/lib/ai/coach-service.ts',
      /Good question|built to answer|straight with you|the chat foundation|becomes the real thing/,
      'the preview replies',
    ],
    // Two delivery notes documented as "safe to relay to the user as-is" that
    // spoke of the user in the third person, and instructed the model.
    [
      'src/lib/notifications/reminders.ts',
      /'[^'\n]*(?:The user can enable|do not promise a phone alert)[^'\n]*'/,
      'the delivery notes',
    ],
  ];
  const sourcesUnder = (path) => {
    const url = new URL(`../${path}`, import.meta.url);
    if (!statSync(url).isDirectory()) return [path];
    return readdirSync(url, { recursive: true })
      .map((entry) => `${path}/${String(entry).replace(/\\/g, '/')}`)
      .filter((file) => /\.(ts|tsx)$/.test(file));
  };
  for (const [path, pattern, what] of RETIRED) {
    const files = sourcesUnder(path);
    const hits = files.filter((file) =>
      pattern.test(readFileSync(new URL(`../${file}`, import.meta.url), 'utf8'))
    );
    files.length === 0
      ? bad(`slop scan: ${path} matched no source files`)
      : hits.length === 0
        ? ok(`slop scan (${files.length} file${files.length === 1 ? '' : 's'}): ${what} stays cut`)
        : bad(`slop scan: ${what} is back`, hits.join(', '));
  }
  // …and the card's facts are still there to be read.
  const card = readFileSync(
    new URL('../src/components/coach/pending-write-card.tsx', import.meta.url),
    'utf8'
  );
  card.includes("'This is written to your on-device record, once.'") &&
  // The delete twin was rewritten when the Coach gained real deletion
  // (2026-09-23 ADR): "leaves … once" became "deleted … for good. There is no
  // undo." — the same fact, now that no undo sits behind it. The owner then cut
  // "for good" (2026-09-25, slop doc §11.G): it said the permanence twice. The
  // fact stays pinned; the doubled half is refuted.
  card.includes("'This row is deleted from your on-device record. There is no undo.'") &&
  !card.includes("'This row is deleted from your on-device record for good") &&
  card.includes('Nothing has been written. The Coach is suspended until you answer.')
    ? ok('the card still states where a write goes, that it happens once, and what NOW means')
    : bad('a consequence line went with the tail');
}

// -------------------------------------------------------------------------
// Owner, on the device, 2026-09-23: "confirm in progress workouts not getting
// cleared, should be same for going to rest of the app" · "workout duration
// should be editable" · "be able to reorder exercises in a workout". What a
// server render can prove is the first frame of each: the way back in from
// Home, the controls each mode draws, and the ones it must not. The taps, the
// focus check and the back gesture are device facts.
console.log('\n23. the live logger — the way back in, reorder, and a session’s minutes');
{
  refute('home (no session open)', render('home (no session open)', HomeScreen), [
    'Workout in progress',
  ]);

  const set = (key, over) => ({
    key,
    weight: '',
    reps: '',
    rpe: '',
    time: '',
    distance: '',
    setType: 'normal',
    done: false,
    pr: false,
    ...over,
  });
  const block = (key, exerciseId, name, linkedToNext, sets) => ({
    key,
    exerciseId,
    name,
    loggingType: 'weight_reps',
    measures: 'reps,load',
    mechanic: 'compound',
    restSec: 180,
    prev: [],
    bestE1rm: null,
    linkedToNext,
    sets,
  });
  saveWorkoutDraft(db, 'live', {
    version: DRAFT_VERSION,
    sessionId: 'render-session',
    startedAt: Date.now() - 12 * 60_000,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [
      block(1, 'barbell-bench-press', 'Barbell Bench Press', true, [
        set(1, { weight: '80', reps: '8', done: true }),
      ]),
      block(2, 'barbell-row', 'Barbell Row', false, [set(2, { weight: '70', reps: '10' })]),
      block(3, 'lat-pulldown', 'Lat Pulldown', false, [set(3)]),
    ],
  });

  // Leaving the logger keeps the session, so Home has to be a way back to it —
  // one quiet line, not a card.
  const home = render('home (a session open)', HomeScreen);
  expect('home (a session open)', home, ['Workout in progress · 1 set done · started ', 'Resume']);

  // The resumed logger: the start and its correction, the reorder door (two
  // units — the superset and the pulldown), and Discard as its own control now
  // that leaving no longer discards.
  const resumed = render('workout-live (resumed)', WorkoutLiveScreen, { resume: '1' });
  expect('workout-live (resumed)', resumed, [
    'elapsed',
    'started ',
    '−5 min',
    '+5 min',
    'Reorder',
    'Barbell Bench Press',
    'Finish workout',
    'Discard workout',
  ]);
  refute('workout-live (resumed)', resumed, [
    'Save changes',
    'Delete session',
    'Duration in minutes',
  ]);
  clearWorkoutDraft(db, 'live');

  // A blank session: nothing typed, so nothing to discard and nothing to order.
  const blank = render('workout-live (new, blank)', WorkoutLiveScreen);
  // `aria-disabled` is the control for the 0-minute case below: Finish on an
  // empty sheet is off, and this is how the render says so.
  expect('workout-live (new, blank)', blank, [
    'elapsed',
    'started ',
    'Nothing logged yet.',
    'aria-disabled="true"',
  ]);
  refute('workout-live (new, blank)', blank, ['Discard workout', 'Reorder']);

  // A logged session: its minutes are a field (a number pad, so the Done-key
  // check above sees it too), and the live-only controls are gone.
  const edited = logWorkout(db, { date: todayISODate(), kind: 'strength', durationMin: 47 }, [
    { exercise: 'Barbell Row', exerciseId: 'barbell-row', reps: 8, weightKg: 70 },
    { exercise: 'Barbell Bench Press', exerciseId: 'barbell-bench-press', reps: 5, weightKg: 90 },
  ]);
  const session = render('workout-live (editing)', WorkoutLiveScreen, { workoutId: edited });
  expect('workout-live (editing)', session, [
    'Duration in minutes',
    'value="47"',
    'Reorder',
    'Save changes',
    'Delete session',
  ]);
  refute('workout-live (editing)', session, ['elapsed', '−5 min', 'Discard workout']);
  db.run('DELETE FROM workouts WHERE id = ?', [edited]);

  // --- the review round ------------------------------------------------------
  // A session with nothing typed is still a session: left to check Home, it is
  // offered back there and on the logger, with Discard as its way out.
  saveWorkoutDraft(db, 'live', {
    version: DRAFT_VERSION,
    sessionId: 'render-untouched',
    startedAt: Date.now() - 4 * 60_000,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [
      block(1, 'barbell-bench-press', 'Barbell Bench Press', false, [set(1), set(2)]),
      block(2, 'barbell-row', 'Barbell Row', false, [set(3)]),
    ],
  });
  const homeUntouched = render('home (an untouched session open)', HomeScreen);
  expect('home (an untouched session open)', homeUntouched, [
    'Workout in progress · started ',
    'Resume',
  ]);
  refute('home (an untouched session open)', homeUntouched, ['set done', 'sets done']);
  const untouched = render('workout-live (resumed, untouched)', WorkoutLiveScreen, { resume: '1' });
  expect('workout-live (resumed, untouched)', untouched, [
    'Barbell Bench Press',
    'Barbell Row',
    'Discard workout',
  ]);
  // A NEW logger opened over that session (past the hub's Resume it / Start new
  // question) writes its draft on mount, so it reads the slot first and closes
  // to the notice rather than overwriting the session there.
  const intruder = render('workout-live (new, over an open session)', WorkoutLiveScreen, {
    exerciseIds: 'barbell-row',
  });
  expect('workout-live (new, over an open session)', intruder, [
    'A different workout is in progress now.',
  ]);
  refute('workout-live (new, over an open session)', intruder, ['Finish workout']);
  clearWorkoutDraft(db, 'live');

  // An untouched stored figure never holds Save, whatever it is — the Coach can
  // store 0 minutes, and the field cannot show a whole minute for it.
  const zero = logWorkout(db, { date: todayISODate(), kind: 'strength', durationMin: 0 }, [
    { exercise: 'Barbell Row', exerciseId: 'barbell-row', reps: 8, weightKg: 70 },
  ]);
  const zeroHtml = render('workout-live (editing, 0 min stored)', WorkoutLiveScreen, {
    workoutId: zero,
  });
  expect('workout-live (editing, 0 min stored)', zeroHtml, ['value="0"', 'Save changes']);
  refute('workout-live (editing, 0 min stored)', zeroHtml, [
    'The duration won’t save',
    'aria-disabled="true"',
  ]);
  db.run('DELETE FROM workouts WHERE id = ?', [zero]);

  // A lone bench moved above a Bench + Row superset reopens with the superset
  // drawn — the seam chip — rather than merged into one Bench block.
  const reordered = logWorkout(db, { date: todayISODate(), kind: 'strength', durationMin: 40 }, [
    { exercise: 'Barbell Bench Press', exerciseId: 'barbell-bench-press', reps: 5, weightKg: 90 },
    {
      exercise: 'Barbell Bench Press',
      exerciseId: 'barbell-bench-press',
      reps: 5,
      weightKg: 90,
      supersetGroup: 1,
    },
    {
      exercise: 'Barbell Row',
      exerciseId: 'barbell-row',
      reps: 8,
      weightKg: 70,
      supersetGroup: 1,
    },
  ]);
  const reopened = render('workout-live (editing, bench then bench+row)', WorkoutLiveScreen, {
    workoutId: reordered,
  });
  expect('workout-live (editing, bench then bench+row)', reopened, [
    'Supersetted with the exercise above',
  ]);
  const benchPlates = (reopened ?? '').split('Barbell Bench Press. Open history').length - 1;
  benchPlates === 2
    ? ok('workout-live (editing, bench then bench+row): two Bench plates, not one merged block')
    : bad('workout-live (editing, bench then bench+row): Bench plates', String(benchPlates));
  db.run('DELETE FROM workouts WHERE id = ?', [reordered]);

  // The free-form logger follows the same rule: leaving keeps its draft, so
  // throwing it away is its own control, shown once there is something to lose.
  refute('workout-log (new)', render('workout-log (new)', WorkoutLogScreen, { mode: 'past' }), [
    'Discard session',
  ]);
  saveWorkoutDraft(db, 'manual', {
    version: DRAFT_VERSION,
    startedAt: Date.now() - 6 * 60_000,
    mode: 'past',
    kind: 'cardio',
    durationText: '30',
    sets: [],
    exercise: '',
    repsText: '',
    weightText: '',
    timeText: '',
    distanceText: '',
    measures: 'reps,load',
    entryDirty: false,
  });
  expect(
    'workout-log (resumed)',
    render('workout-log (resumed)', WorkoutLogScreen, { resume: '1' }),
    ['value="30"', 'Save session', 'Discard session']
  );
  clearWorkoutDraft(db, 'manual');
}

console.log('\n24. 2026-09-23 — Undo, Combine, and a multi-scan meal’s name');
{
  // The owner's three food-logging notes from the device. A server render runs
  // no taps, so each state is drawn the way the screen draws it: an offer made
  // in the store (as the screen's handlers make it), a plan built from real
  // rows, a component rendered from its own export.
  const today = todayISODate();
  const noop = () => {};
  const offer = (scope, said, spoken, figure = null) => ({
    scope,
    icon: 'restaurant-outline',
    said,
    figure,
    spoken,
    refusal: `Could not put ${said.replace(/^\w+ /, '')} back — the meal has changed since.`,
    undo: noop,
    settle: noop,
  });

  // RESTING: one word on the list's label line, and no row is a checkbox.
  const resting = render('nutrition hub (combine available)', NutritionScreen);
  expect('nutrition hub (combine available)', resting, [
    'Combine meals that were one meal',
    '>Combine<',
  ]);
  refute('nutrition hub (combine available)', resting, [
    'role="checkbox"',
    // The foot's opening sentence, worded as slop pass 4 left it (§11.B).
    'Tap the meals that were one meal.',
    'Undo',
  ]);

  // A MEAL DELETED on its own screen comes back from the list it returns to.
  offerUndo(offer({ on: 'list', date: today }, 'Deleted Lunch', 'Undo deleting Lunch', '640 kcal'));
  const deleted = render('nutrition hub (a deleted meal)', NutritionScreen);
  expect('nutrition hub (a deleted meal)', deleted, [
    'Deleted Lunch',
    ' · 640 kcal',
    'Undo deleting Lunch',
    '>Undo<',
  ]);
  expect(
    'nutrition-history (a deleted meal)',
    render('nutrition-history (a deleted meal)', NutritionHistoryScreen, {}),
    ['Deleted Lunch', 'Undo deleting Lunch']
  );
  closeUndo();

  // A meal deleted from a PAST day is offered under that day only — history
  // drawing another day, and the Eat tab, draw nothing for it.
  const dayBefore = shiftISODate(today, -1);
  offerUndo(
    offer({ on: 'list', date: dayBefore }, 'Deleted Tapas', 'Undo deleting Tapas', '480 kcal')
  );
  expect(
    'nutrition-history (its own day)',
    render('nutrition-history (its own day)', NutritionHistoryScreen, { date: dayBefore }),
    ['Deleted Tapas', 'Undo deleting Tapas']
  );
  refute(
    'nutrition-history (another day)',
    render('nutrition-history (another day)', NutritionHistoryScreen, {}),
    ['Deleted Tapas']
  );
  refute(
    'nutrition hub (a past day’s deletion)',
    render('nutrition hub (a past day’s deletion)', NutritionScreen),
    ['Deleted Tapas']
  );
  closeUndo();

  // An Undo that was REFUSED keeps its row and loses its button: the tap is
  // answered in a sentence.
  offerUndo(offer({ on: 'list', date: today }, 'Deleted Lunch', 'Undo deleting Lunch', '640 kcal'));
  const slot = currentUndo();
  offerUndo({
    ...slot,
    undo: () => {
      throw new Error('changed');
    },
  });
  runUndo();
  const refusedRow = render('nutrition hub (a refused Undo)', NutritionScreen);
  expect('nutrition hub (a refused Undo)', refusedRow, [
    'Could not put Lunch back — the meal has changed since.',
  ]);
  refute('nutrition hub (a refused Undo)', refusedRow, ['Undo deleting Lunch', '>Undo<']);
  closeUndo();

  // AN ITEM REMOVED on the meal screen — drawn there, on that meal only.
  const { mealId } = logMealWithItems(db, {
    date: today,
    time: '07:40',
    name: 'Porridge',
    items: [
      { name: 'Oats', amount: 60, kcal: 228, protein_g: 8 },
      { name: 'Milk', amount: 200, unit: 'ml', kcal: 92, protein_g: 7 },
    ],
  });
  const { mealId: otherId } = logMealWithItems(db, {
    date: today,
    time: '07:45',
    name: 'Coffee',
    items: [{ name: 'Espresso', amount: 30, unit: 'ml', kcal: 3 }],
  });
  offerUndo(offer({ on: 'meal', mealId }, 'Removed Banana', 'Undo removing Banana', '107 kcal'));
  const detail = render('meal-detail (an item removed)', MealDetailScreen, { id: mealId });
  expect('meal-detail (an item removed)', detail, [
    'Removed Banana',
    ' · 107 kcal',
    'Undo removing Banana',
    // The receipt sits above the plate's closing row, where the item was.
    'Add food to this meal',
  ]);
  detail !== null && detail.indexOf('Removed Banana') < detail.indexOf('Add food to this meal')
    ? ok('meal-detail: the receipt is the plate’s row above Add food')
    : bad('meal-detail: receipt placement');
  refute(
    'meal-detail (another meal)',
    render('meal-detail (another meal)', MealDetailScreen, { id: otherId }),
    ['Removed Banana']
  );
  refute(
    'nutrition hub (an item offer)',
    render('nutrition hub (an item offer)', NutritionScreen),
    ['Removed Banana']
  );
  closeUndo();

  // THE COMBINE FOOT, in its three states, from the planner the repository runs.
  const porridge = getMeal(db, mealId);
  const coffee = getMeal(db, otherId);
  const ready = render(
    'combine foot (ready)',
    CombineFooter,
    {},
    { plan: planCombine([coffee, porridge]), name: null, onName: noop, onCombine: noop }
  );
  expect('combine foot (ready)', ready, [
    'Name of the combined meal',
    'value="Porridge"',
    'On combine: these 2 become one meal, “Porridge”, at 07:40 — 323 kcal, so the day’s total does not change.',
    'Combine 2 meals',
  ]);
  expect(
    'combine foot (named)',
    render(
      'combine foot (named)',
      CombineFooter,
      {},
      { plan: planCombine([coffee, porridge]), name: 'Breakfast', onName: noop, onCombine: noop }
    ),
    ['value="Breakfast"', '“Breakfast”', 'Combine 2 meals into Breakfast']
  );
  const few = render(
    'combine foot (one chosen)',
    CombineFooter,
    {},
    { plan: planCombine([porridge]), name: null, onName: noop, onCombine: noop }
  );
  expect('combine foot (one chosen)', few, ['Tap at least one more.', 'aria-disabled="true"']);
  refute('combine foot (one chosen)', few, ['Name of the combined meal', 'On combine']);
  // Slop pass 4 (§11.B). The foot's first sentence lost its "really" — the
  // toggle it opens from already says "Combine meals that were one meal" —
  // and the day refusal states its rule once instead of twice.
  const none = render(
    'combine foot (none chosen)',
    CombineFooter,
    {},
    { plan: planCombine([]), name: null, onName: noop, onCombine: noop }
  );
  expect('combine foot (none chosen)', none, ['>Tap the meals that were one meal.<']);
  refute('combine foot (none chosen)', none, ['really']);
  const twoDays = render(
    'combine foot (two days)',
    CombineFooter,
    {},
    {
      plan: planCombine([porridge, { ...coffee, date: shiftISODate(coffee.date, -1) }]),
      name: null,
      onName: noop,
      onCombine: noop,
    }
  );
  expect('combine foot (two days)', twoDays, [
    'These were logged on different days, and a meal belongs to one day.',
    'aria-disabled="true"',
  ]);
  refute('combine foot (two days)', twoDays, ['only meals from the same day combine']);
  const refused = render(
    'combine foot (refused)',
    CombineFooter,
    {},
    {
      plan: planCombine([coffee, porridge], new Set([otherId])),
      name: null,
      onName: noop,
      onCombine: noop,
    }
  );
  expect('combine foot (refused)', refused, [
    '“Coffee” is still waiting on its estimate.',
    'aria-disabled="true"',
  ]);
  // A TAP the repository refused (the screen's copy of the day was stale): the
  // foot stays, and says why above the button.
  const tapRefused = render(
    'combine foot (a tap refused)',
    CombineFooter,
    {},
    {
      plan: planCombine([coffee, porridge]),
      name: null,
      refused: 'One of those meals is no longer logged, so nothing was combined.',
      onName: noop,
      onCombine: noop,
    }
  );
  expect('combine foot (a tap refused)', tapRefused, [
    'One of those meals is no longer logged, so nothing was combined.',
    'Combine 2 meals',
  ]);
  const reason = planCombine([coffee, porridge], new Set([otherId])).reason;
  const echoed = render(
    'combine foot (a refusal the plan already says)',
    CombineFooter,
    {},
    {
      plan: planCombine([coffee, porridge], new Set([otherId])),
      name: null,
      refused: reason,
      onName: noop,
      onCombine: noop,
    }
  );
  echoed !== null && echoed.split('is still waiting on its estimate').length === 2
    ? ok('combine foot: a refusal the re-read plan already states is said once, not twice')
    : bad('combine foot: refusal repeated');

  // An item's Undo refused on the meal screen (a revision drained under it):
  // the row stays on the Items plate and says so, with no button.
  offerUndo(offer({ on: 'meal', mealId }, 'Removed Banana', 'Undo removing Banana', '107 kcal'));
  offerUndo({
    ...currentUndo(),
    undo: () => {
      throw new Error('changed');
    },
  });
  runUndo();
  const itemRefused = render('meal-detail (a refused Undo)', MealDetailScreen, { id: mealId });
  expect('meal-detail (a refused Undo)', itemRefused, [
    'Could not put Banana back — the meal has changed since.',
  ]);
  refute('meal-detail (a refused Undo)', itemRefused, ['Undo removing Banana']);
  closeUndo();

  // THE MULTI-SCAN NAME — prefilled, a count in the note, no button of its own.
  const named = render(
    'barcode scan (meal name)',
    SessionMealName,
    {},
    {
      value: 'Greek Yogurt · Fage',
      current: 'Greek Yogurt · Fage',
      count: 2,
      onChange: noop,
      onCommit: noop,
    }
  );
  expect('barcode scan (meal name)', named, [
    'Meal name',
    '2 foods',
    'value="Greek Yogurt · Fage"',
    'aria-label="Meal name"',
  ]);
  refute('barcode scan (meal name)', named, ['role="button"']);
  // …and the screen itself, before any add, draws no name field.
  refute('barcode scan (fresh)', render('barcode scan (fresh)', BarcodeScanScreen), [
    'aria-label="Meal name"',
  ]);
}

console.log('\n25. 2026-09-23 — the water screen says when a glass cannot reach Apple Health');
{
  // Until *Allow publishing* was tapped, every glass stalled with nothing on the
  // water screen saying so. The rule (sync on, water unasked or refused) is
  // pinned in db/wearables.test.mjs §24b. Here: that the screen draws the line
  // where it should, and draws nothing where it cannot help.
  //
  // Under node the HealthKit module is absent, so the screen itself can only
  // show the "no line" state, which is what the web preview and a build
  // without the module must show. The shown state is drawn by rendering the
  // row the screen uses, with the line passed in.
  const wdb = getDb();
  setHealthSyncEnabled(wdb, true);
  const water = render('water (sync on, no HealthKit module)', WaterScreen);
  expect('water (sync on, no HealthKit module)', water, ['Add', 'Entries']);
  refute('water (sync on, no HealthKit module)', water, [
    WATER_UNASKED_LINE,
    WATER_REFUSED_LINE,
    'Not sent to Apple Health',
    'Settings › Apple Health',
  ]);
  setHealthSyncEnabled(wdb, false);
  refute('water (sync off)', render('water (sync off)', WaterScreen), [
    'Not sent to Apple Health',
    'Settings › Apple Health',
  ]);

  const noop = () => undefined;
  for (const [name, line] of [
    ['unasked', WATER_UNASKED_LINE],
    ['refused', WATER_REFUSED_LINE],
  ]) {
    const html = render(
      `water pointer (${name})`,
      WaterPublishPointer,
      {},
      { line, onPress: noop }
    );
    expect(`water pointer (${name})`, html, [
      line,
      'role="button"',
      `aria-label="${line}. Opens Settings, Apple Health."`,
    ]);
  }

  // Where it sits, what it opens, and what it may not spend. react-native-web
  // hashes class names out of the markup, so these are read off the source.
  const src = readFileSync(new URL('../app/water.tsx', import.meta.url), 'utf8');
  const add = src.slice(
    src.indexOf('<SectionLabel label="Add"'),
    src.indexOf('<SectionLabel label="Entries"')
  );
  add.includes('<WaterPublishPointer') && add.includes("router.push('/settings-health')")
    ? ok('water: the line is a row of the Add plate, and it opens Settings › Apple Health')
    : bad('water: the pointer is not in the Add plate, or goes somewhere else');
  src.includes('publishPointer: waterPublishPointer(waterPublishFacts(db))')
    ? ok(
        'water: the line is re-read with the screen (on focus, on a return to the foreground, after every write), from the shared rule'
      )
    : bad('water: the pointer is not read through waterPublishPointer');
  const row = readFileSync(
    new URL('../src/components/water/publish-pointer.tsx', import.meta.url),
    'utf8'
  );
  !/\b(bg|text|border)-pine\b|signal-/.test(row) && /min-h-\[44px\]/.test(row)
    ? ok('water pointer: no accent, no signal colour, and a 44pt target')
    : bad('water pointer spends the accent or a signal colour, or is under 44pt');
}

console.log('\n26. 2026-09-23 — the estimate review’s × has an Undo');
{
  // The plate draws the receipt from its own export, as §7c2 and §20 do: the
  // screens show the review only once a model has answered, which a server
  // render never reaches. The screens' wiring is pinned by source below.
  const noop = () => {};
  const handlers = {
    onAmountChange: noop,
    onRemove: noop,
    onToggle: noop,
    onScale: noop,
    onScaleTo: noop,
    onScaleBegin: noop,
    onScaleEnd: noop,
    onCountChange: noop,
    onWholeChange: noop,
    onCountBegin: noop,
    onCountEnd: noop,
    onPiecesName: noop,
  };
  const juice = {
    key: '0-Orange juice',
    name: 'Orange juice',
    foodId: null,
    food: undefined,
    confidence: 'high',
    unit: 'ml',
    base: {
      amount: 250,
      kcal: 112,
      protein_g: 2,
      carbs_g: 26,
      fat_g: 0,
      fiber_g: null,
      micros: null,
    },
    amountText: '250',
    components: [],
    expanded: false,
    scaleFrom: null,
    pieces: null,
    wholeCount: null,
    countText: null,
    wholeText: null,
    countFrom: null,
  };
  const words = {
    icon: 'restaurant-outline',
    said: 'Removed Almond croissant',
    figure: '380 kcal',
    spoken: 'Undo removing Almond croissant',
  };
  const plate = (label, rows, undo) =>
    render(
      label,
      ReviewItemsPlate,
      {},
      { rows, label: 'Items', emptyNote: 'No items left.', handlers, undo }
    );

  const offered = plate('review plate (Undo offered)', [juice], { offer: words, onUndo: noop });
  expect('review plate (Undo offered)', offered, [
    'Removed Almond croissant',
    // The figure in mono after the sentence, as the meal screen's receipt.
    ' · 380 kcal',
    'aria-label="Undo removing Almond croissant"',
    '>Undo<',
  ]);
  (offered ?? '').indexOf('Orange juice') < (offered ?? '').indexOf('Removed Almond croissant')
    ? ok('review plate (Undo offered): the receipt is the foot of the same plate, under the rows')
    : bad('receipt placement');

  // The last row removed: the empty note, and the way back under it.
  const emptied = plate('review plate (emptied, Undo offered)', [], { offer: words, onUndo: noop });
  expect('review plate (emptied, Undo offered)', emptied, [
    'No items left.',
    'Removed Almond croissant',
    'aria-label="Undo removing Almond croissant"',
  ]);

  // Nothing offered: no row, no button.
  refute('review plate (no Undo)', plate('review plate (no Undo)', [juice], null), [
    'Removed ',
    'Undo removing',
  ]);

  // THE WIRING, by source. Both screens hold the rows in the one hook, route
  // the × through it (it is in `draft.handlers`, never a bare removeRow), pass
  // the offer to the plate, and hand the question hook the CLOSING setter so an
  // answer closes an open Undo.
  const src = (file) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');
  for (const file of ['app/meal-estimate.tsx', 'app/meal-revise.tsx']) {
    const s = src(file);
    s.includes('const draft = useReviewDraft();') &&
    s.includes('handlers={draft.handlers}') &&
    s.includes('undo={draft.offer ? { offer: draft.offer, onUndo: draft.undo } : null}') &&
    s.includes('setRows: draft.replace,') &&
    s.includes('draft.replace(rowsFromEstimate(') &&
    !s.includes('removeRow') &&
    !s.includes('useState<ReviewItem[]>')
      ? ok(`${file}: rows, ×, Undo and answers all go through useReviewDraft`)
      : bad(`${file}: review wiring`);
  }
  const hook = src('src/hooks/use-review-draft.ts');
  hook.includes('onRemove: (key) => setDraft((d) => removeRowWithUndo(d, key))') &&
  !/onRemove:[^\n]*edit\(/.test(hook)
    ? ok('the hook’s × is the one that remembers what it took')
    : bad('hook onRemove');
  // The setter the screens hand the question hook must be the CLOSING one:
  // `replaceDraft`, which nutrition-v2 §70 drives with an answer that keeps
  // every key (the case `editDraft` would leave open). Pinned by its body, so a
  // `replace` rebuilt on `editDraft` fails here rather than on a lit chip.
  const replaceBody = hook.slice(
    hook.indexOf('const replace = useCallback'),
    hook.indexOf('const undo = useCallback')
  );
  replaceBody.includes('setDraft((d) => replaceDraft(d, next))') &&
  !replaceBody.includes('editDraft') &&
  !replaceBody.includes('removed:')
    ? ok('the hook’s replace is replaceDraft — every answer and fresh estimate closes the Undo')
    : bad('hook replace', replaceBody);
}

// ---------------------------------------------------------------------------
// 27. Slop pass 4 (docs/ai-slop-candidates-2026-09.md §11) — the two cuts no
// page render here reaches. Every other §11 cut is pinned beside the render
// that draws it (settings-health, nutrition-micros, progress photo compare,
// protocol-item, workout-log, the combine foot, and the four key gates:
// meal-estimate, meal-revise, lab-import, recipe-revise) or in its own suite
// (the Coach's delete card, db/coach-domains.test.mjs).
//
// Settings › Backups is not rendered by this suite, and the status sheet is a
// native Modal that draws nothing until it is opened. Both are read as source,
// with whitespace collapsed so a sentence wrapped across JSX lines is one
// string — and each scan must find its file, or it fails rather than passing
// over nothing.
console.log('\n27. Slop pass 4 — the retired lines no render here reaches');
{
  const flat = (file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const screens = readdirSync(new URL('../app', import.meta.url), { recursive: true })
    .map((entry) => `app/${String(entry).replace(/\\/g, '/')}`)
    .filter((file) => file.endsWith('.tsx'));

  // "…and this screen goes live — nothing else to set up." closed the
  // build-gate sentence on BOTH Settings screens that have one. It narrated
  // the screen, and it was not even true: after the build, Apple Health still
  // has Enable and a permission sheet, and Backups still has its first snapshot.
  const live = screens.filter((file) =>
    /this screen goes live|nothing else to set up/.test(flat(file))
  );
  screens.length > 0 && live.length === 0
    ? ok(`slop scan (${screens.length} screens): "this screen goes live" stays cut`)
    : bad('slop scan: the build-gate tail is back', live.join(', ') || 'no screens read');
  flat('app/settings-backups.tsx').includes(
    'there is nowhere to write a snapshot. Run the next EAS build (docs/dev-build.md).'
  )
    ? ok('Settings › Backups still says why there is no snapshot, and the way out')
    : bad('settings-backups: the build-gate fact went with its tail');

  // The status sheet's closing note: "just" was the tell. The sentence keeps
  // the fact that a free-text status exists, and the consequence line after it
  // is untouched.
  const sheet = flat('src/components/status/status-control.tsx');
  !sheet.includes('just tell the Coach') &&
  sheet.includes(
    'For anything else, tell the Coach. Skips on these days stop counting against you; their readings sit out of your 30-day baselines.'
  )
    ? ok('the status sheet: "just" cut, the route and the consequence line kept')
    : bad('status sheet closing note');
}

console.log('\n28. 2026-09-25 — a Start taken straight back, and the Trend’s range chips');
{
  const today = todayISODate();
  // --- the quiet drop, through the logger's own way out ------------------------
  // Owner: "Quietly drop a session with nothing typed if you leave within a few
  // seconds of starting." A server render runs no effects, so the screen's
  // `beforeRemove` never fires here. What it calls is `leaveLiveLogger`, the
  // whole of the way out, exported for this: it is driven over the real slot,
  // and Home and the Train hub are drawn after it.
  const set = (key, over) => ({
    key,
    weight: '',
    reps: '',
    rpe: '',
    time: '',
    distance: '',
    setType: 'normal',
    done: false,
    pr: false,
    ...over,
  });
  const block = (key, exerciseId, name, sets) => ({
    key,
    exerciseId,
    name,
    loggingType: 'weight_reps',
    measures: 'reps,load',
    mechanic: 'compound',
    restSec: 180,
    prev: [],
    bestE1rm: null,
    linkedToNext: false,
    sets,
  });
  const T0 = Date.now();
  // What Start builds from a saved workout, and writes on mount.
  const started = {
    blocks: [
      block(1, 'barbell-bench-press', 'Barbell Bench Press', [set(1), set(2)]),
      block(3, 'barbell-row', 'Barbell Row', [set(4)]),
    ],
    startedAt: T0,
    away: false,
    restEndsAt: null,
  };
  // The baseline comes through `liveStartFor`, the call the screen's own
  // initializer makes (pinned below), not a hand-built one.
  const start = liveStartFor({ draft: null, workoutId: undefined }, started);
  const writtenAtStart = (sessionId, state) =>
    saveWorkoutDraft(db, 'live', {
      version: DRAFT_VERSION,
      sessionId,
      routineId: null,
      ingestId: null,
      ...state,
    });
  const slotHolds = () => readWorkoutDraft(db, 'live') !== null;
  const leave = (sessionId, state, baseline, at, over = {}) => {
    const seen = { prevented: 0, stopped: 0, slotAtStop: null };
    const outcome = leaveLiveLogger(
      { preventDefault: () => seen.prevented++, data: { action: { type: 'GO_BACK' } } },
      {
        settled: false,
        editing: false,
        dirty: false,
        writeFailed: false,
        sessionId,
        start: baseline,
        session: state,
        ...over,
      },
      {
        db,
        at,
        stop: () => {
          seen.stopped++;
          seen.slotAtStop = slotHolds();
        },
        dispatch: () => {},
      }
    );
    return { outcome, ...seen };
  };

  // Start, nothing typed, back out after four seconds: gone, quietly.
  writtenAtStart('quiet-drop', started);
  const dropped = leave('quiet-drop', started, start, T0 + 4_000);
  dropped.outcome === 'drop' &&
  dropped.prevented === 0 &&
  dropped.stopped === 1 &&
  dropped.slotAtStop === true &&
  !slotHolds()
    ? ok(
        'left 4 s after Start with nothing typed: nothing asked, writes and the rest alert stopped first, then the slot cleared'
      )
    : bad('quiet drop', JSON.stringify(dropped));
  refute('home (after a quiet drop)', render('home (after a quiet drop)', HomeScreen), [
    'Workout in progress',
  ]);
  refute(
    'exercise hub (after a quiet drop)',
    render('exercise hub (after a quiet drop)', ExerciseScreen),
    ['Session in progress']
  );

  // One weight typed: kept, exactly as since 2026-09-23.
  const typed = {
    ...started,
    blocks: [{ ...started.blocks[0], sets: [set(1, { weight: '80' }), set(2)] }, started.blocks[1]],
  };
  writtenAtStart('quiet-typed', typed);
  const keptTyped = leave('quiet-typed', typed, start, T0 + 4_000);
  keptTyped.outcome === 'leave' &&
  keptTyped.stopped === 0 &&
  keptTyped.prevented === 0 &&
  slotHolds()
    ? ok('left 4 s after Start with a weight typed: kept, nothing asked')
    : bad('typed kept', JSON.stringify(keptTyped));
  expect('home (typed, left at 4 s)', render('home (typed, left at 4 s)', HomeScreen), [
    'Workout in progress',
  ]);
  expect(
    'exercise hub (typed, left at 4 s)',
    render('exercise hub (typed, left at 4 s)', ExerciseScreen),
    ['Session in progress']
  );
  clearWorkoutDraft(db, 'live');

  // Nothing typed, but left after the window: kept.
  writtenAtStart('quiet-late', started);
  const keptLate = leave('quiet-late', started, start, T0 + 12_000);
  keptLate.outcome === 'leave' && keptLate.stopped === 0 && slotHolds()
    ? ok('left 12 s after Start with nothing typed: kept — the window is ten seconds')
    : bad('late kept', JSON.stringify(keptLate));
  clearWorkoutDraft(db, 'live');

  // Force-quit 4 s after Start. A kill runs no code, so the way out is never
  // asked: the draft Start wrote is what the next launch finds, and Home, the
  // hub and the logger all offer it back. Resuming it and backing straight out
  // keeps it too — a resumed screen holds no Start baseline.
  writtenAtStart('quiet-killed', started);
  expect('home (killed 4 s after Start)', render('home (killed 4 s after Start)', HomeScreen), [
    'Workout in progress · started ',
    'Resume',
  ]);
  expect(
    'exercise hub (killed 4 s after Start)',
    render('exercise hub (killed 4 s after Start)', ExerciseScreen),
    ['Session in progress']
  );
  expect(
    'workout-live (resumed after the kill)',
    render('workout-live (resumed after the kill)', WorkoutLiveScreen, { resume: '1' }),
    ['Barbell Bench Press', 'Barbell Row', 'Discard workout']
  );
  // The resumed screen's baseline, as its initializer takes it: over the draft
  // it reopened, which `liveStartFor` answers with none.
  const resumedDraft = parseLiveDraft(readWorkoutDraft(db, 'live')?.value);
  const resumedStart = liveStartFor({ draft: resumedDraft, workoutId: undefined }, started);
  const resumedBack = leave('quiet-killed', started, resumedStart, T0 + 5_000);
  resumedDraft !== null &&
  resumedStart === null &&
  resumedBack.outcome === 'leave' &&
  resumedBack.stopped === 0 &&
  slotHolds()
    ? ok('resumed after the kill and left at once: kept — only a NEW session is dropped')
    : bad('resumed kept', JSON.stringify({ resumedStart, resumedBack }));
  clearWorkoutDraft(db, 'live');

  // The other ways out are unchanged.
  const editStart = liveStartFor({ draft: null, workoutId: 'stored-session' }, typed);
  const settled = leave('x', started, start, T0 + 1_000, { settled: true });
  const failedTyped = leave('x', typed, start, T0 + 1_000, { writeFailed: true });
  const failedQuiet = leave('x', started, start, T0 + 1_000, { writeFailed: true });
  const edit = leave('', typed, editStart, T0 + 1_000, { editing: true, dirty: true });
  settled.outcome === 'settled' &&
  settled.stopped === 0 &&
  failedTyped.outcome === 'ask-unsaved-copy' &&
  failedTyped.prevented === 1 &&
  failedQuiet.outcome === 'drop' &&
  failedQuiet.prevented === 0 &&
  editStart === null &&
  edit.outcome === 'ask-discard-changes' &&
  edit.prevented === 1
    ? ok(
        'settled leaves; a failed write still asks, unless there is nothing typed to lose; an edit with changes still asks'
      )
    : bad('other ways out', JSON.stringify([settled, failedTyped, failedQuiet, editStart, edit]));

  // What a server render cannot run: the screen's own inputs to all of the
  // above. Its Start snapshot is `liveStartFor` over the screen's draft and
  // workout id, and the snapshot and the way out read ONE `liveState` object
  // built from the four session states — so a snapshot that stopped being
  // taken, or a leave fed a different session, fails here rather than
  // silently turning the drop off. (The shape is pinned from the source; the
  // behaviour of each piece is pinned above and in db/exercise.test.mjs §15.)
  const liveSource = readFileSync(new URL('../app/workout-live.tsx', import.meta.url), 'utf8');
  const leaveCall = liveSource.slice(
    liveSource.indexOf("addListener('beforeRemove'"),
    liveSource.indexOf('dispatch: (action) => navigation.dispatch(action)')
  );
  const feeds = {
    'one liveState from the four states':
      /const liveState = useMemo<LiveSessionState>\(\s*\(\) => \(\{ blocks, startedAt, away, restEndsAt \}\),\s*\[blocks, startedAt, away, restEndsAt\]\s*\)/.test(
        liveSource
      ),
    'the snapshot is liveStartFor over draft, workoutId and liveState':
      /const \[start\] = useState<LiveStart \| null>\(\(\) =>\s*liveStartFor\(\{ draft, workoutId \}, liveState\)\s*\)/.test(
        liveSource
      ),
    'beforeRemove calls leaveLiveLogger':
      /^\s*addListener\('beforeRemove', \(e\) => \{\s*leaveLiveLogger\(/.test(leaveCall),
    'the leave gets the snapshot and liveState': /\bstart,\s*session: liveState,/.test(leaveCall),
    'the leave reads the clock when it runs': /at: Date\.now\(\),/.test(leaveCall),
  };
  const unfed = Object.entries(feeds)
    .filter(([, holds]) => !holds)
    .map(([what]) => what);
  unfed.length === 0
    ? ok(
        'the logger feeds the drop what it tests: liveStartFor for the snapshot, one liveState for both sides'
      )
    : bad('workout-live feeds', unfed.join('; '));

  // --- the Trend's range chips ---------------------------------------------------
  // Owner: "Add range chips". Seven hip-thrust sessions over 500 days, dated in
  // the past with created_at to match, so no freshness reading moves.
  const past = (back, kg) => {
    const date = shiftISODate(today, -back);
    const id = logWorkout(db, { date, kind: 'strength' }, [
      { exercise: 'Hip Thrust', exerciseId: 'hip-thrust', reps: 5, weightKg: kg },
    ]);
    db.run('UPDATE workouts SET created_at = ? WHERE id = ?', [`${date}T12:00:00.000Z`, id]);
    return id;
  };
  const hipIds = [
    [500, 100],
    [300, 105],
    [200, 110],
    [80, 115],
    [60, 118],
    [20, 120],
    [5, 125],
  ].map(([back, kg]) => past(back, kg));
  const chipLabel = (range) => `Show ${TREND_RANGE_WORDS[range]}`;
  const findEl = (node, match) => {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (match(node)) return node;
    for (const child of React.Children.toArray(node.props?.children ?? [])) {
      const hit = findEl(child, match);
      if (hit) return hit;
    }
    return null;
  };
  // react-native-web drops `accessibilityState.selected` on a button, so which
  // chip is selected is read from the field's own element tree — what iOS
  // hands VoiceOver — rather than from the markup.
  const selectedChips = (props) =>
    TREND_RANGES.filter(
      (r) =>
        findEl(TrendField(props), (el) => el.props?.accessibilityLabel === chipLabel(r))?.props
          .accessibilityState?.selected === true
    );

  // The screen opens on All: seven sessions over 500 days are more than 1Y
  // holds, and the default never hides one the old 24-session view showed.
  const hipDetail = render('exercise detail (range chips)', ExerciseDetailScreen, {
    id: 'hip-thrust',
  });
  expect('exercise detail (range chips)', hipDetail, [
    ...TREND_RANGES.map((r) => `aria-label="${chipLabel(r)}"`),
    '>1M<',
    '>3M<',
    '>1Y<',
    '>All<',
    // First the hub row's figure, then the change across the range.
    'aria-label="up 6 percent on the previous 3 sessions"',
    'aria-label="up 19 percent on the first 3 sessions on record"',
    '· 7 sessions',
  ]);
  hipDetail.indexOf('up 6 percent on the previous 3 sessions') <
  hipDetail.indexOf('up 19 percent on the first 3 sessions on record')
    ? ok('exercise detail: the hub row’s figure is the first line, the range’s the second')
    : bad('exercise detail: direction line order');

  // Each chip, drawn: its sessions, the hub's figure on every one, and a
  // second line naming the range when it says something the first does not.
  const hipRows = workingSets(db, 'hip-thrust');
  let pressed = null;
  const fieldProps = (range) => ({
    view: trendView(hipRows, 'reps,load', 'total', { metric: null, range }, today),
    units: DEFAULT_UNIT_PREFERENCES,
    basisNote: 'lb · total',
    onMetric: () => {},
    onRange: (r) => {
      pressed = r;
    },
  });
  // 3M holds exactly the latest home session and the three before it, so its
  // range line would be the first line again ("+6% on the first 3 sessions of
  // the last 3 months") and is left out.
  const perChip = {
    '1m': ['up 4 percent on the first session of the last month', 2],
    '3m': [null, 4],
    '1y': ['up 14 percent on the first 3 sessions of the last year', 6],
    all: ['up 19 percent on the first 3 sessions on record', 7],
  };
  for (const range of TREND_RANGES) {
    const [spoken, sessions] = perChip[range];
    const name = `trend field (${range})`;
    const html = render(name, TrendField, {}, fieldProps(range));
    expect(name, html, [
      'aria-label="up 6 percent on the previous 3 sessions"',
      ...(spoken ? [`aria-label="${spoken}"`] : []),
      `· ${sessions} sessions`,
      'Latest',
    ]);
    if (!spoken) refute(name, html, ['of the last 3 months']);
    selectedChips(fieldProps(range)).join() === range
      ? ok(`${name}: only its own chip is selected`)
      : bad(`${name}: selected chips`, selectedChips(fieldProps(range)).join() || 'none');
  }
  selectedChips(fieldProps(null)).join() === 'all'
    ? ok('trend field (no pick): the default range, All, is the chip selected')
    : bad('trend field (no pick): selected', selectedChips(fieldProps(null)).join() || 'none');

  // …and each chip, pressed through the element tree, asks for its range.
  const unpressed = TREND_RANGES.filter((range) => {
    pressed = null;
    const chip = findEl(
      TrendField(fieldProps('all')),
      (el) => el.props?.accessibilityLabel === chipLabel(range)
    );
    chip?.props.onPress();
    return pressed !== range;
  });
  unpressed.length === 0
    ? ok('trend field: pressing 1M, 3M, 1Y and All each asks for that range')
    : bad('trend field: chip presses', unpressed.join());

  // A range with nothing in it keeps the chips and says what to do.
  const emptyMonth = trendView(
    hipRows.filter((r) => r.date < shiftISODate(today, -40)),
    'reps,load',
    'total',
    { metric: null, range: '1m' },
    today
  );
  const emptyHtml = render(
    'trend field (1M, nothing in it)',
    TrendField,
    {},
    {
      ...fieldProps('1m'),
      view: emptyMonth,
    }
  );
  expect('trend field (1M, nothing in it)', emptyHtml, [
    'Nothing to plot in the last month. Choose a longer range.',
    `aria-label="${chipLabel('3m')}"`,
  ]);
  refute('trend field (1M, nothing in it)', emptyHtml, ['Latest']);

  // The review's case (2026-09-25): a lift whose last three sessions are down
  // on the three before them, but up on where the month began. The hub row
  // says −8%; the screen it opens must say −8% first, in the same words, and
  // then — separately, naming its range — the +20% across the month. Before
  // the fix it said only "+20%".
  const squatIds = [
    [27, 100],
    [23, 100],
    [19, 100],
    [15, 130],
    [11, 130],
    [7, 130],
    [3, 120],
  ].map(([back, kg]) => {
    const date = shiftISODate(today, -back);
    const id = logWorkout(db, { date, kind: 'strength' }, [
      { exercise: 'Front Squat', exerciseId: 'front-squat', reps: 5, weightKg: kg },
    ]);
    db.run('UPDATE workouts SET created_at = ? WHERE id = ?', [`${date}T12:00:00.000Z`, id]);
    return id;
  });
  const hubSquat = render('exercise hub (front squat, down on 3, up on the month)', ExerciseScreen);
  expect('exercise hub (front squat, down on 3, up on the month)', hubSquat, [
    'down 8 percent on the previous 3 sessions.',
  ]);
  const squatDetail = render('exercise detail (front squat)', ExerciseDetailScreen, {
    id: 'front-squat',
  });
  expect('exercise detail (front squat)', squatDetail, [
    'aria-label="down 8 percent on the previous 3 sessions"',
    'aria-label="up 20 percent on the first 3 sessions of the last month"',
    '· 7 sessions',
  ]);
  squatDetail.indexOf('down 8 percent on the previous 3 sessions') <
  squatDetail.indexOf('up 20 percent on the first 3 sessions of the last month')
    ? ok('the row says −8%, and the screen it opens says −8% first, then +20% across the month')
    : bad('front squat: line order');
  for (const id of [...hipIds, ...squatIds]) deleteWorkout(db, id);
}

// ---------------------------------------------------------------------------
// 29. Screen time (2026-09-25, docs/screen-time.md) — typed on Log or the
// keypad, sent by a Shortcut's link, read on Data and in Settings.
//
// A server render runs no effects and fires no taps, so what is proved here is
// what each screen DRAWS from the record, and — for the link, whose write
// happens in its state initializer on purpose — that rendering it writes
// exactly once. Every row is taken back at the end, so nothing later reads it.
console.log('\n29. Screen time — the keypad, the receipt, the link, Data and Settings');
{
  const sdb = getDb();
  const today = todayISODate();
  const yesterday = shiftISODate(today, -1);
  const rows = () =>
    sdb.all(`SELECT * FROM wearable_data WHERE metric_type = 'screen_time_min' ORDER BY date`);

  // --- Nothing on record yet ------------------------------------------------
  const emptyData = render('data tab (no screen time)', DataScreen);
  expect('data tab (no screen time)', emptyData, ['Screen time', 'No screen time logged yet']);

  // The keypad on its chip: the `.` key types h, the placeholder names the
  // format, and the day chips offer both days with the noon rule's selected.
  const defaultDay = defaultScreenTimeDay(new Date());
  const defaultDate = screenTimeDate(defaultDay, new Date());
  const keypad = render('metric-entry (screen time, empty)', MetricEntryScreen, {
    metric: 'screen_time',
    from: 'Data',
  });
  expect('metric-entry (screen time, empty)', keypad, [
    'Screen time',
    '0h 0m',
    'Yesterday',
    'Today',
    '>h<',
    'aria-label="Hours"',
    `${weekdayDate(defaultDate)} · nothing on record`,
    'Log Screen time',
  ]);
  refute('metric-entry (screen time, empty)', keypad, ['Replace Screen time']);

  // --- A typed number, and the Log tab's receipt -----------------------------
  const typed = recordScreenTime(sdb, yesterday, 200, 'typed');
  noteTypedScreenTime(typed.id);
  const logTyped = render('log tab (screen time typed)', LogScreen);
  expect('log tab (screen time typed)', logTyped, [
    `Screen time filed to yesterday, ${weekdayDate(yesterday)}`,
    ' · 3h 20m',
    `Undo screen time 3h 20m for ${weekdayDate(yesterday)}`,
    // Plan (a)'s door: a Quick add tile, beside Weight's, so the number can be
    // found on the Log tab without knowing the grammar.
    'aria-label="Screen time"',
  ]);
  // A day's total is not a capture at a moment: it is not in "Logged today",
  // where it would carry a clock time from the morning after.
  refute('log tab (screen time typed)', logTyped, ['>3h 20m<']);
  {
    const grid = readFileSync(
      new URL('../src/components/log/quick-add-grid.tsx', import.meta.url),
      'utf8'
    );
    /pathname: '\/metric-entry', params: \{ metric: 'screen_time' \}/.test(grid)
      ? ok('the Screen time door opens the keypad on its own chip')
      : bad('the Screen time door lost its keypad route');
  }

  // After an Undo the receipt says what happened and offers NOTHING — it must
  // not re-read the record into a fresh Undo, or a double tap takes back two
  // numbers. A render cannot tap, so this reads the handler, and says so.
  {
    const receipt = readFileSync(
      new URL('../src/components/log/screen-time-receipt.tsx', import.meta.url),
      'utf8'
    );
    const handler = /const undo = \(\) => \{[\s\S]*?\n {2}\};/.exec(receipt)?.[0] ?? '';
    handler.includes("kind: 'undone'") &&
    !handler.includes('refresh(') &&
    !handler.includes('readReceipt(') &&
    handler.includes('forgetTypedScreenTime(')
      ? ok('the receipt’s Undo leaves an "Undone" line and re-arms nothing')
      : bad('the receipt’s Undo re-reads the record', handler.slice(0, 200));
  }

  // The keypad shows what the chosen day already holds, and says Replace. The
  // chosen day is the noon rule's, so the number goes on THAT day — whichever
  // side of noon this suite runs — and comes off again straight after.
  const held = recordScreenTime(sdb, defaultDate, 95, 'typed');
  expect(
    'metric-entry (screen time, on record)',
    render('metric-entry (screen time, on record)', MetricEntryScreen, { metric: 'screen_time' }),
    [`${weekdayDate(defaultDate)} · 1h 35m on record`, 'Replace Screen time']
  );
  undoScreenTime(sdb, held.id);

  const dataTyped = render('data tab (screen time typed)', DataScreen);
  expect('data tab (screen time typed)', dataTyped, [
    'Screen time',
    'Daily total · last 14 days',
    '3h 20m',
    'Yesterday',
  ]);

  // --- The link ---------------------------------------------------------------
  // Over a number he TYPED, a link does not write alone: it draws a confirm
  // card naming both numbers, and the record is untouched until a tap.
  const link = { minutes: '210', date: yesterday };
  const asked = render('screen-time link (over a typed number)', ScreenTimeLinkScreen, link);
  expect('screen-time link (over a typed number)', asked, [
    '3h 30m',
    `${weekdayDate(yesterday)} · from Shortcuts, not saved yet`,
    `${weekdayDate(yesterday)} holds 3h 20m, typed on Log. The Shortcut sent 3h 30m.`,
    'Replace with 3h 30m',
    'Keep 3h 20m',
  ]);
  refute('screen-time link (over a typed number)', asked, ['>Undo<', 'Saved for']);
  rows().length === 1 && rows()[0].value === 200
    ? ok('a link over a typed number writes nothing until the card is answered')
    : bad('link wrote over a typed number', JSON.stringify(rows()));

  // Over an empty day (or an earlier Shortcuts number) for yesterday, it
  // writes once, as the Shortcut's, with no tap — the automation's own case.
  undoScreenTime(sdb, typed.id);
  forgetTypedScreenTime();
  const landed = render('screen-time link (filed)', ScreenTimeLinkScreen, link);
  expect('screen-time link (filed)', landed, [
    'Screen time',
    '3h 30m',
    `${weekdayDate(yesterday)} · from Shortcuts`,
    `Saved for yesterday, ${weekdayDate(yesterday)}.`,
    'Undo',
  ]);
  const afterLink = rows();
  afterLink.length === 1 &&
  afterLink[0].value === 210 &&
  JSON.parse(afterLink[0].metadata).via === 'shortcuts'
    ? ok('rendering the link wrote one row, marked as the Shortcut’s')
    : bad('link write', JSON.stringify(afterLink));

  // The same link again is not a second write.
  const again = render('screen-time link (repeated)', ScreenTimeLinkScreen, link);
  expect('screen-time link (repeated)', again, ['Already on record for yesterday']);
  rows().length === 1 && rows()[0].id === afterLink[0].id
    ? ok('the same link twice leaves the same single row')
    : bad('repeated link wrote again', JSON.stringify(rows()));

  // The Log tab finds the Shortcut's write from the record — the path taken
  // when iOS reclaimed the app before the owner opened it...
  expect('log tab (screen time from a Shortcut)', render('log tab (shortcut)', LogScreen), [
    `Shortcuts filed screen time to yesterday, ${weekdayDate(yesterday)}`,
    ' · 3h 30m',
  ]);
  // ...and once it has been shown (stamped when he leaves the tab), it is not
  // drawn again: a nightly automation is one receipt a night, not a fixture.
  markReceiptSeen(sdb, afterLink[0].created_at);
  const seenLog = render('log tab (seen)', LogScreen);
  expect('log tab (Shortcut write already seen)', seenLog, ['Quick add']);
  refute('log tab (Shortcut write already seen)', seenLog, ['Shortcuts filed screen time']);
  expect('data tab (screen time from a Shortcut)', render('data (shortcut)', DataScreen), [
    'Yesterday · Shortcuts',
  ]);

  // A bad link writes nothing and says why.
  const future = shiftISODate(today, 2);
  const refused = render('screen-time link (future)', ScreenTimeLinkScreen, {
    minutes: '200',
    date: future,
  });
  expect('screen-time link (future)', refused, [
    `Nothing saved. ${future} is in the future.`,
    'The link format and the Shortcut steps are in Settings › Screen time.',
  ]);
  refute('screen-time link (future)', refused, ['from Shortcuts', '>Undo<']);
  rows().length === 1 && rows()[0].value === 210
    ? ok('a refused link leaves the record as it was')
    : bad('refused link touched the record', JSON.stringify(rows()));

  // --- Settings ---------------------------------------------------------------
  // Settings itself cannot be imported here: it reads the backup snapshot,
  // whose `migrations.generated` import this suite's resolver does not reach
  // (the same reason §27 reads Settings › Backups as source). So the row that
  // leads to the setup is pinned the way §27 pins that screen.
  const settingsSource = readFileSync(new URL('../app/settings.tsx', import.meta.url), 'utf8');
  settingsSource.includes('label="Screen time"') &&
  settingsSource.includes("router.push('/settings-screen-time')")
    ? ok('Settings carries a Screen time row that opens the setup screen')
    : bad('Settings lost its Screen time row');
  expect('settings-screen-time', render('settings-screen-time', SettingsScreenTimeScreen), [
    'On record',
    `3h 30m for yesterday, ${weekdayDate(yesterday)}, from Shortcuts`,
    `Last sent 3h 30m for yesterday, ${weekdayDate(yesterday)}`,
    'only if the check returns a total',
    'Website Data',
    'arc://log/screen-time?minutes=N&amp;date=YYYY-MM-DD',
    'Round Number',
    'yyyy-MM-dd',
    'Open URLs.',
    'For an older day, or a day that holds a number you typed, it asks',
  ]);

  // A typed correction replaces the Shortcut's row the morning after — and
  // Settings still says the Shortcut ran, because it reads the Shortcuts
  // record rather than the rows.
  const correction = recordScreenTime(sdb, yesterday, 215, 'typed');
  expect(
    'settings-screen-time (after a typed correction)',
    render('settings-screen-time (corrected)', SettingsScreenTimeScreen),
    [
      `3h 35m for yesterday, ${weekdayDate(yesterday)}, typed`,
      `Last sent 3h 30m for yesterday, ${weekdayDate(yesterday)}`,
    ]
  );
  refute(
    'settings-screen-time (after a typed correction)',
    render('settings-screen-time (corrected)', SettingsScreenTimeScreen),
    ['No Shortcut has sent a number yet']
  );
  undoScreenTime(sdb, correction.id);

  // A link for a day older than yesterday is accepted but not written alone:
  // an automation never sends one, and its Undo would never be offered again.
  const older = shiftISODate(today, -5);
  const olderLink = render('screen-time link (older day)', ScreenTimeLinkScreen, {
    minutes: '200',
    date: older,
  });
  expect('screen-time link (older day)', olderLink, [
    `The Shortcut sent 3h 20m for ${weekdayDate(older)}. ARC saves a Shortcut’s number without asking only for today and yesterday.`,
    'Save 3h 20m',
    'Don’t save',
  ]);
  rows().length === 1 && rows()[0].date === yesterday
    ? ok('a link for an older day writes nothing until the card is answered')
    : bad('older link wrote alone', JSON.stringify(rows()));

  // --- Take it all back ------------------------------------------------------
  undoScreenTime(sdb, afterLink[0].id);
  sdb.run(`DELETE FROM health_sync_state WHERE key = 'screen_time'`);
  rows().length === 0
    ? ok('Undo of the link empties the day, and the Shortcuts record is cleared')
    : bad('cleanup', JSON.stringify(rows()));
}

// ---------------------------------------------------------------------------
// 0064 — COACH NOTIFICATIONS on screen: the Coach tab's Scheduled list, the
// tapped reminder with "Talk about this", the check-in line, and Settings ›
// Coach's Notifications section.
// ---------------------------------------------------------------------------
{
  console.log('\n30. Coach notifications: the Scheduled list, the tapped reminder, Settings');

  const today = todayISODate(new Date());
  const tomorrow = shiftISODate(today, 1);
  const list = render(
    'nudges-card',
    NudgesCard,
    {},
    {
      nudges: [
        { id: 'n1', day: today, time: '15:00', body: 'Walk after lunch.' },
        { id: 'n2', day: tomorrow, time: '07:30', body: 'Leg day. Eat before you lift.' },
      ],
      today,
      onCancel() {},
    }
  );
  expect('nudges-card', list, [
    'Scheduled by the Coach',
    '2 notifications',
    'Walk after lunch.',
    'today · 15:00',
    'tomorrow · 07:30',
    '>Cancel<',
    // Each Cancel names the notification it cancels, for VoiceOver.
    'Cancel the notification for tomorrow · 07:30: Leg day. Eat before you lift.',
  ]);
  refute('nudges-card', list, ['iOS Settings', 'will not reach']);

  const blocked = render(
    'nudges-card (permission refused)',
    NudgesCard,
    {},
    {
      nudges: [{ id: 'n1', day: tomorrow, time: '07:30', body: 'Leg day.' }],
      today,
      onCancel() {},
      blocked: true,
    }
  );
  expect('nudges-card (permission refused)', blocked, [
    '1 notification',
    'Notifications are off for ARC in iOS Settings, so these will not reach your lock screen.',
  ]);
  const empty = render('nudges-card (none)', NudgesCard, {}, { nudges: [], today, onCancel() {} });
  empty === ''
    ? ok('nudges-card renders nothing when the Coach has planned nothing')
    : bad('nudges-card (none) drew something', String(empty).slice(0, 120));

  const reminderRow = (overrides) => ({
    id: 'r1',
    title: 'The knee',
    time: '20:00',
    date: today,
    repeat: 'once',
    status: 'active',
    created_by: 'ai',
    notes: null,
    checkin: 1,
    created_at: '',
    updated_at: '',
    ...overrides,
  });
  const tapped = render(
    'reminders-card (tapped check-in)',
    RemindersCard,
    {},
    {
      reminders: [
        reminderRow({}),
        reminderRow({ id: 'r2', title: 'Take creatine', time: '15:00', checkin: 0 }),
      ],
      onComplete() {},
      onDismiss() {},
      highlightId: 'r1',
      onTalk() {},
    }
  );
  expect('reminders-card (tapped check-in)', tapped, [
    'The knee',
    ' · check-in',
    'Talk about this',
    'Talk about &quot;The knee&quot; with the Coach',
  ]);
  (tapped?.match(/Talk about this/g) ?? []).length === 1
    ? ok('reminders-card: only the tapped row offers "Talk about this"')
    : bad('reminders-card: Talk about this on more than one row');
  refute(
    'reminders-card (untapped)',
    render(
      'reminders-card (untapped)',
      RemindersCard,
      {},
      { reminders: [reminderRow({})], onComplete() {}, onDismiss() {} }
    ),
    ['Talk about this']
  );

  const waiting = render(
    'checkin-line (answering)',
    CheckinLine,
    {},
    { answering: true, outcome: null }
  );
  expect('checkin-line (answering)', waiting, ['· checking in…']);
  const silent = render(
    'checkin-line (silent)',
    CheckinLine,
    {},
    { answering: false, outcome: { request: { kind: 'morning' }, result: 'silent' } }
  );
  expect('checkin-line (silent)', silent, [
    'The Coach looked and had nothing to add. Ask it anything below.',
  ]);
  checkinNote({ request: { kind: 'morning' }, result: 'spoke' }) === null &&
  checkinNote({ request: { kind: 'morning' }, result: 'shown' }) === null &&
  checkinNote(null) === null
    ? ok('checkin-line: when the Coach answered, the thread is the answer and the line is silent')
    : bad('checkin-line spoke/shown drew a line');
  checkinNote({ request: { kind: 'morning' }, result: 'no-key' }) ===
  'The Coach needs an API key to check in. Add one in Settings › Coach.'
    ? ok('checkin-line: no key says where to add one')
    : bad('checkin-line no-key');

  const settings = render('settings-coach', SettingsCoachScreen);
  expect('settings-coach', settings, [
    'Notifications',
    'Coach nudges',
    'Up to two a day, planned when ARC opens',
    'Quiet from',
    '21:30',
    'Quiet until',
    '07:00',
    'Morning check-in',
    'A nudge timed inside quiet hours is dropped, not moved.',
    'set Show Previews to When Unlocked for ARC in iOS Settings',
    // ON by default since 2026-09-26, just after quiet hours end, following them.
    'A daily notification; tap it and the Coach speaks first',
    'Check-in at',
    '07:05',
    '5 minutes after quiet hours end, and moves with them',
    // Record checks (findings thresholds): every knob, at its default.
    'Record checks',
    'Gap: times your usual spacing',
    'Weight: jump between readings',
    '4 %',
    'Lab change: z',
    '1.96',
    'nothing in your record moves unless you approve it',
  ]);
  refute('settings-coach', settings, ['Follow quiet hours', 'Your time.', 'Reset to defaults']);

  saveNudgeSettings(db, { checkinTime: '07:15', quietStart: '22:00' });
  const settingsOwn = render('settings-coach (his own time)', SettingsCoachScreen);
  expect('settings-coach (his own time)', settingsOwn, [
    'Check-in at',
    '07:15',
    '22:00',
    'Your time. Moving quiet hours leaves it here.',
    'Follow quiet hours',
  ]);
  refute('settings-coach (his own time)', settingsOwn, ['and moves with them']);

  saveNudgeSettings(db, { checkinTime: null });
  const settingsOff = render('settings-coach (check-in off)', SettingsCoachScreen);
  refute('settings-coach (check-in off)', settingsOff, ['Check-in at', 'Follow quiet hours']);
  saveNudgeSettings(db, { checkinFollowsQuiet: true, quietStart: '21:30' });
}

console.log('\n31. 2026-09-25 — combine on a past day, and `2 eggs` read as a count');
{
  // A day of its own, well behind every other section's meals.
  const past = shiftISODate(todayISODate(), -10);
  logMeal(db, { date: past, time: '12:30', name: 'Soup', kcal: 220 });
  logMeal(db, { date: past, time: '12:40', name: 'Bread roll', kcal: 150 });
  queueNewMealEstimate(
    db,
    { date: past, time: '19:00', name: 'a green curry' },
    { kind: 'text', description: 'a green curry' }
  );
  // HISTORY: the Eat tab's own control on the day's label line, resting — no
  // row is a checkbox until it is asked for — and the queued meal says why it
  // has no numbers, as it does on the Eat tab.
  const day = render('nutrition-history (a past day to combine)', NutritionHistoryScreen, {
    date: past,
  });
  expect('nutrition-history (a past day to combine)', day, [
    'Combine meals that were one meal',
    '>Combine<',
    'Estimate pending — offline',
  ]);
  refute('nutrition-history (a past day to combine)', day, [
    'role="checkbox"',
    'Tap the meals that were one meal.',
  ]);
  // A day with one meal has nothing to combine, and draws no control.
  const lone = shiftISODate(todayISODate(), -11);
  logMeal(db, { date: lone, time: '08:00', name: 'Porridge', kcal: 300 });
  refute(
    'nutrition-history (one meal)',
    render('nutrition-history (one meal)', NutritionHistoryScreen, { date: lone }),
    ['Combine meals that were one meal']
  );

  // THE RECORD: a plain item counted in its own pieces reads as a count.
  const { mealId: eggsId } = logMealWithItems(db, {
    date: past,
    time: '08:10',
    name: 'Eggs',
    items: [
      {
        name: 'Boiled egg',
        amount: 100,
        kcal: 143,
        protein_g: 13,
        serving_qty: 2,
        piece_name: 'egg',
      },
    ],
  });
  const eggs = render('meal-detail (plain count)', MealDetailScreen, { id: eggsId });
  expect('meal-detail (plain count)', eggs, ['2 eggs (100 g)']);
  refute('meal-detail (plain count)', eggs, ['2 × egg', '2 × 1 egg']);
  expect(
    'meal-revise "As logged" (plain count)',
    render(
      'meal-revise "As logged" (plain count)',
      AsLoggedPlate,
      {},
      { tree: assembleMealItems(listMealItems(db, eggsId)), volume: 'ml' }
    ),
    ['2 eggs']
  );

  // THE REVIEW: `2 eggs` leading the sub-line, the grams field kept in the
  // amount column (the independent review: with no parts, it is the row's only
  // handle on its grams), and ATE — never OF — beneath it.
  const noop = () => {};
  const handlers = {
    onAmountChange: noop,
    onRemove: noop,
    onToggle: noop,
    onScale: noop,
    onScaleTo: noop,
    onScaleBegin: noop,
    onScaleEnd: noop,
    onCountChange: noop,
    onWholeChange: noop,
    onCountBegin: noop,
    onCountEnd: noop,
    onPiecesName: noop,
  };
  const eggRow = {
    key: 'egg',
    name: 'Boiled egg',
    foodId: null,
    food: undefined,
    confidence: 'high',
    unit: 'g',
    base: {
      amount: 100,
      kcal: 143,
      protein_g: 13,
      carbs_g: null,
      fat_g: null,
      fiber_g: null,
      micros: null,
    },
    amountText: '100',
    components: [],
    expanded: false,
    scaleFrom: null,
    pieces: { name: 'egg', count: 2 },
    wholeCount: null,
    countText: null,
    wholeText: null,
    countFrom: null,
  };
  const plate = render(
    'review plate (plain count)',
    ReviewItemsPlate,
    {},
    { rows: [eggRow], label: 'Items', emptyNote: '', handlers }
  );
  expect('review plate (plain count)', plate, [
    '2 eggs · P 13g',
    'aria-label="Boiled egg grams"',
    'value="100"',
    'aria-label="Boiled egg, pieces eaten"',
    'value="2"',
    'Name one piece of Boiled egg',
  ]);
  refute('review plate (plain count)', plate, [
    // No OF on a plain count, and the grams are the field's, not the sub-line's.
    'aria-label="Pieces in Boiled egg"',
    '100 g · P 13g',
  ]);
  // Un-counted, the same row is the grams row it always was.
  const grams = render(
    'review plate (plain, uncounted)',
    ReviewItemsPlate,
    {},
    { rows: [{ ...eggRow, pieces: null }], label: 'Items', emptyNote: '', handlers }
  );
  expect('review plate (plain, uncounted)', grams, ['aria-label="Boiled egg grams"']);
  refute('review plate (plain, uncounted)', grams, ['pieces eaten', '2 eggs']);

  // ITEM 4: a counted dish arrives OPEN from the estimate, so ATE and OF are
  // on screen without a tap; its parts are drawn beneath the header.
  const { rowsFromEstimate } = await import('../src/lib/nutrition/review-rows.ts');
  const { parseMealEstimate } = await import('../src/lib/nutrition/estimate.ts');
  const opened = rowsFromEstimate(
    db,
    parseMealEstimate(
      JSON.stringify({
        title: 'Pizza',
        items: [
          {
            name: 'Pepperoni pizza',
            confidence: 'medium',
            pieces: { name: 'slice', count: 8 },
            components: [
              { name: 'Pizza crust', amount: 400, kcal: 1000 },
              { name: 'Mozzarella', amount: 320, kcal: 900 },
            ],
          },
        ],
      })
    )
  );
  const pizza = render(
    'review plate (counted dish, fresh)',
    ReviewItemsPlate,
    {},
    { rows: opened, label: 'Items', emptyNote: '', handlers }
  );
  expect('review plate (counted dish, fresh)', pizza, [
    'aria-label="Pepperoni pizza, pieces eaten"',
    'aria-label="Pieces in Pepperoni pizza"',
    'Mozzarella',
  ]);
}

// ---------------------------------------------------------------------------
// 32. The owner's parity answers (2026-09-25), on the screens: a × on every
// Log-tab row and the Undo row it offers; Add food's Delete, armed and at
// rest, and its Undo; and the three approved lines from the slop walks. A
// server render taps nothing, so each state is drawn the way the screen draws
// it — an offer made in the store as the handler makes it, and the expanded
// row's editor rendered from its own export with the armed consequence.
console.log('\n32. 2026-09-25 — the Log tab’s ×, Add food’s Delete, and three approved lines');
{
  const today = todayISODate();
  const noop = () => {};
  const creatine = logCapture(db, today, 'supplement', 'Creatine · 5 g');
  const note = logNote(db, today, 'Slept badly, 3am wake');
  const at = (id) => listEntriesOn(db, today).find((e) => e.id === id)?.time;
  expect('log tab (a × on every row)', render('log tab (a × on every row)', LogScreen), [
    `Remove Supplements, Creatine · 5 g, logged at ${at(creatine)}`,
    `Remove the note, logged at ${at(note)}`,
  ]);

  // A capture removed from TODAY is offered under today's record, and nowhere
  // else — not on the Eat tab, whose slot this shares.
  const logOffer = (date) => ({
    scope: { on: 'log', date },
    icon: 'scale-outline',
    said: 'Removed weight',
    figure: '176.4 lb',
    spoken: 'Undo removing weight, 176.4 lb',
    refusal: 'Could not put weight 176.4 lb back.',
    undo: noop,
    settle: noop,
  });
  offerUndo(logOffer(today));
  expect('log tab (a capture removed)', render('log tab (a capture removed)', LogScreen), [
    'Removed weight',
    ' · 176.4 lb',
    'Undo removing weight, 176.4 lb',
    '>Undo<',
  ]);
  refute(
    'nutrition hub (a Log tab removal)',
    render('nutrition hub (a Log tab removal)', NutritionScreen),
    ['Removed weight']
  );
  closeUndo();
  offerUndo(logOffer(shiftISODate(today, -1)));
  refute('log tab (yesterday’s removal)', render('log tab (yesterday’s removal)', LogScreen), [
    'Removed weight',
  ]);
  closeUndo();
  db.run('DELETE FROM log_entries WHERE id IN (?, ?)', [creatine, note]);

  // ADD FOOD: a deleted food comes back from the closing catalog plate.
  offerUndo({
    scope: { on: 'catalog' },
    icon: 'restaurant-outline',
    said: 'Deleted Oats from the catalog',
    figure: null,
    spoken: 'Undo deleting Oats',
    refusal: 'Could not put Oats back in the catalog.',
    undo: noop,
    settle: noop,
  });
  expect('food-search (a food deleted)', render('food-search (a food deleted)', FoodSearchScreen), [
    'Deleted Oats from the catalog',
    'Undo deleting Oats',
    '>Undo<',
    'Create a food',
  ]);
  closeUndo();
  refute(
    'food-search (nothing deleted)',
    render('food-search (nothing deleted)', FoodSearchScreen),
    ['from the catalog']
  );

  // The expanded row's editor: the bin at rest, then armed with the
  // consequence line and the one control that deletes.
  const food = {
    id: 'food-oats',
    name: 'Oats',
    brand: null,
    basis: 'g',
    serving_name: null,
    serving_amount: null,
    kcal_100g: 379,
    is_favorite: 0,
    source: 'user',
  };
  const props = {
    expanded: { food, portion: { mode: 'amount', qty: 1, amountText: '100' }, section: 'results' },
    amountPreview: 100,
    kcalPreview: 379,
    onStep: noop,
    onEditAmount: noop,
    onToggleFavorite: noop,
    onAdd: noop,
    onArmDelete: noop,
    onDelete: noop,
  };
  const resting = render(
    'food-search editor (at rest)',
    PortionEditor,
    {},
    {
      ...props,
      deleteConsequence: null,
    }
  );
  expect('food-search editor (at rest)', resting, ['Delete Oats from the catalog', '>Add<']);
  refute('food-search editor (at rest)', resting, ['Deletes “Oats”', '>Delete<']);
  const armed = render(
    'food-search editor (Delete armed)',
    PortionEditor,
    {},
    {
      ...props,
      deleteConsequence: foodDeleteConsequence('Oats', {
        meals: 3,
        templates: 0,
        recipes: 0,
        counted: 0,
      }),
    }
  );
  expect('food-search editor (Delete armed)', armed, [
    'Keep Oats in the catalog',
    'Deletes “Oats” from the catalog. It is used by 3 meals, which keep their own numbers.',
    '>Delete<',
    '>Add<',
  ]);

  // THE THREE APPROVED LINES (docs/ai-slop-candidates-2026-09.md §10.G and
  // §11.G). Two are an Alert body and a scope-gated note no render here
  // reaches, so they are read as source with whitespace collapsed; the third
  // (the Coach's delete card) is pinned in §22 above.
  const flat = (file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const kb = flat('app/knowledge.tsx');
  kb.includes('Archived entries can be restored. Deleted ones can’t.') &&
  !kb.includes('undelete does not')
    ? ok('knowledge: "Restore exists; undelete does not." is now the two plain sentences')
    : bad('knowledge delete line');
  const hr = flat('app/settings-health.tsx');
  hr.includes(
    'Heart rate during workouts shows on each session. It was added after you connected, so it has to be asked for on its own.'
  ) && !hr.includes('ARC can read the heart rate')
    ? ok('settings-health: the heart-rate ask opens on where the figure shows, rest as it was')
    : bad('heart-rate ask');
}

// ---------------------------------------------------------------------------
// 33. A Log-tab capture opens for correction (owner, 2026-09-26: "Yes, an edit
// on the Log tab, and the Coach too."). A server render taps nothing, so the
// row's own control is read off the tab as drawn, and each editor is rendered
// from its own export for each kind of row: its words, its figure in the
// unit the row prints, or a symptom's name and severity.
console.log('\n33. 2026-09-26 — a Log-tab capture opens to its words, its figure or its severity');
{
  const today = todayISODate();
  const noop = () => null;
  const units = getPreferences(db).units;
  const creatine = logCapture(db, today, 'supplement', 'Creatine · 5 g');
  const note = logNote(db, today, 'Slept badly, 3am wake');
  logMetric(db, today, 'weight', 80);
  const symptom = logSymptom(db, {
    date: today,
    time: '14:00',
    name: 'Headache',
    severity: 6,
    bodyArea: null,
    notes: null,
  });
  const feed = listEntriesOn(db, today, units);
  const weight = feed.find((e) => e.category === 'Weight');
  const at = (id) => feed.find((e) => e.id === id)?.time;

  // THE ROW IS THE CONTROL: every row says it opens, and keeps its ×.
  const tab = render('log tab (rows open for correction)', LogScreen);
  expect('log tab (rows open for correction)', tab, [
    `Supplements, Creatine · 5 g, logged at ${at(creatine)}. Edit.`,
    `Note, Slept badly, 3am wake, logged at ${at(note)}. Edit.`,
    `Weight, 176.4 lb, logged at ${weight.time}. Edit.`,
    `Remove Supplements, Creatine · 5 g, logged at ${at(creatine)}`,
  ]);

  // EACH EDITOR, opened to what its row shows.
  const editorFor = (name, id) =>
    render(
      name,
      CaptureEditor,
      {},
      {
        capture: getCapture(db, id, units),
        units,
        onSave: noop,
        onCancel: noop,
      }
    );
  const line = editorFor('capture editor (a supplement line)', creatine);
  expect('capture editor (a supplement line)', line, [
    'value="Creatine · 5 g"',
    'aria-label="Corrected Creatine · 5 g"',
    '>Save<',
    '>Cancel<',
  ]);
  const noteEditor = editorFor('capture editor (a note)', note);
  expect('capture editor (a note)', noteEditor, ['Slept badly, 3am wake', 'Corrected note']);
  const figure = editorFor('capture editor (a weight)', weight.id);
  expect('capture editor (a weight)', figure, [
    'value="176.4"',
    'aria-label="Corrected weight in lb"',
    '>lb<',
  ]);
  const felt = editorFor('capture editor (a symptom)', symptom);
  expect('capture editor (a symptom)', felt, ['value="Headache"', 'value="6"', 'Severity', '/10']);
  // No accent on the Log tab past the command field: Save is ink.
  [line, noteEditor, figure, felt].every((html) => html && !/bg-pine/.test(html))
    ? ok('the editors spend no accent: Save is ink, the command field keeps the one')
    : bad('an editor spends the accent');
  // The time is not offered: no clock field in any editor.
  [line, noteEditor, figure, felt].every((html) => html && !/Corrected time|HH:MM/.test(html))
    ? ok('no editor offers the time — it stays as logged')
    : bad('an editor offers the time');

  // INSIDE THE PLATE, under its own row: the open editor is part of the row.
  const open = render(
    'recent logs (the weight open)',
    RecentLogs,
    {},
    {
      entries: feed,
      onRemove: noop,
      onEdit: noop,
      editingId: weight.id,
      editor: React.createElement(CaptureEditor, {
        capture: getCapture(db, weight.id, units),
        units,
        onSave: noop,
        onCancel: noop,
      }),
    }
  );
  const rowAt = open?.indexOf(`Weight, 176.4 lb, logged at ${weight.time}. Close.`) ?? -1;
  const editorAt = open?.indexOf('value="176.4"') ?? -1;
  // The next row's own control, not this row's ×, which also names its time.
  const nextRowAt = open?.indexOf('. Edit.', rowAt) ?? -1;
  rowAt >= 0 && editorAt > rowAt && (nextRowAt === -1 || editorAt < nextRowAt)
    ? ok('the open editor sits beneath its own row, before the next, and the row reads Close')
    : bad('editor placement', JSON.stringify({ rowAt, editorAt, nextRowAt }));

  // THE UNITS ARE PINNED TO THE OPEN EDITOR (review, 2026-09-26). A server
  // render cannot switch a unit under an open editor, so the tab's source is
  // read: the editor is drawn in the units the row was opened in, Save hands
  // over the opened row whole (db/log.test.mjs §23 proves the read-back), and
  // the editor closes when the tab is left, as the Undo does.
  const logTabSource = readFileSync(new URL('../app/(tabs)/log.tsx', import.meta.url), 'utf8');
  logTabSource.includes('units={editing.units}') &&
  logTabSource.includes('saveCaptureEdit(getDb(), editing, draft)') &&
  logTabSource.includes('useFocusEffect(useCallback(() => () => setEditing(null), []))') &&
  !/getPreferences\(/.test(logTabSource)
    ? ok(
        'the Log tab draws and saves an open editor in the units it opened in, and closes it on leaving'
      )
    : bad('log tab units pin');

  db.run('DELETE FROM log_entries WHERE id IN (?, ?)', [creatine, note]);
  db.run('DELETE FROM symptoms WHERE id = ?', [symptom]);
  db.run('DELETE FROM body_metrics WHERE id = ?', [weight.id.split(':')[0]]);
}

// ---------------------------------------------------------------------------
// 34. Food-logging quick fixes (owner, 2026-10-21): the scanner's Done and its
// label rows (79, 81), a catalog food's edit screen (85), and a logged dish's
// whole amount (92). A server render taps nothing, so each control that only
// a tap reaches is drawn from its own export.
console.log('\n34. 2026-10-21 — Done, the label both ways, a food edited, a dish’s whole amount');
{
  const noop = () => {};

  // 79 — DONE CLOSES THE FLOW. Nothing added yet: no Done in the header.
  refute('barcode-scan (nothing added)', render('barcode-scan (nothing added)', BarcodeScanScreen), [
    '>Done<',
  ]);
  doneDismissCount('search') === 2 &&
  doneDismissCount('camera') === 2 &&
  doneDismissCount(undefined) === 1 &&
  doneDismissCount('elsewhere') === 1
    ? ok('Done closes the scanner and Add food / the camera together, and only the scanner from Eat')
    : bad('done dismiss count');
  const flat = (file) =>
    readFileSync(new URL(`../${file}`, import.meta.url), 'utf8').replace(/\s+/g, ' ');
  flat('app/food-search.tsx').includes("params: { mealId: targetMealId, via: 'search' }") &&
  flat('app/meal-estimate.tsx').includes("params: { code, via: 'camera' }") &&
  flat('app/barcode-scan.tsx').includes('router.dismiss(doneDismissCount(via))') &&
  !flat('app/barcode-scan.tsx').includes('accessibilityLabel="Done" onPress={done} className="mt-6')
    ? ok('both in-flow pushers say so with `via`, and the one Done (in the header) dismisses by it')
    : bad('done wiring');

  // 81 — THE LABEL, BOTH WAYS: per 100 ml and per 250 ml serving.
  const milk = {
    id: 'food-milk',
    name: 'Fresh Chocolate Milk',
    brand: 'Lewis Road Creamery',
    basis: 'ml',
    serving_name: '0.33 of bottle (250 ml)',
    serving_amount: 250,
    kcal_100g: 132.887,
    protein_g_100g: 4.32,
    carbs_g_100g: 12.4,
    fat_g_100g: 7.32,
    source: 'openfoodfacts',
  };
  const rows = render('barcode-scan label rows', LabelRows, {}, { food: milk });
  expect('barcode-scan label rows', rows, [
    'Per 100 ml',
    '133 kcal · P 4.3g · C 12.4g · F 7.3g',
    'Per serving · 250 ml',
    '332 kcal · P 10.8g · C 31g · F 18.3g',
  ]);
  // A doubtful reading says so in ONE quiet line; a clean one says nothing.
  const doubtful = render('barcode-scan notes (doubtful)', LabelNotes, {}, {
    food: milk,
    label: { read: 'rescaled', servingDropped: null, doubtful: true },
    healed: true,
  });
  expect('barcode-scan notes (doubtful)', doubtful, [
    'Label data looks inconsistent — check per 100 ml.',
    'Updated from Open Food Facts just now',
    'per-serving figures in its per-100 column',
  ]);
  refute('barcode-scan notes (doubtful)', doubtful, ['role="button"']);
  refute(
    'barcode-scan notes (clean)',
    render('barcode-scan notes (clean)', LabelNotes, {}, {
      food: milk,
      label: { read: 'per100', servingDropped: null, doubtful: false },
      healed: false,
    }),
    ['inconsistent', 'Updated from', 'divided']
  );
  // A cached row whose energy disagrees with its macros is flagged offline too.
  expect(
    'barcode-scan notes (cached, energy off)',
    render('barcode-scan notes (cached, energy off)', LabelNotes, {}, {
      food: { ...milk, kcal_100g: 50, protein_g_100g: 10, carbs_g_100g: 10, fat_g_100g: 10 },
      label: null,
      healed: false,
    }),
    ['Label data looks inconsistent — check per 100 ml.']
  );
  // …but a FRESH reading's verdict wins: it was judged with the polyols the
  // row does not keep, so a clean sugar-free mint says nothing (2026-10-21).
  refute(
    'barcode-scan notes (fresh reading wins)',
    render('barcode-scan notes (fresh reading wins)', LabelNotes, {}, {
      food: { ...milk, basis: 'g', kcal_100g: 240, protein_g_100g: 0, carbs_g_100g: 98, fat_g_100g: 0 },
      label: { read: 'per100', servingDropped: null, doubtful: false },
      healed: false,
    }),
    ['inconsistent']
  );
  // …and with NO reading (offline, or before the re-read lands) the same mint
  // is not called inconsistent either: its only excess is carbohydrate, which
  // the polyols the row does not keep can explain (2026-10-21 fix round).
  refute(
    'barcode-scan notes (cached sugar-free mint)',
    render('barcode-scan notes (cached sugar-free mint)', LabelNotes, {}, {
      food: { ...milk, basis: 'g', serving_amount: 2, kcal_100g: 240, protein_g_100g: 0, carbs_g_100g: 98, fat_g_100g: 0 },
      label: null,
      healed: false,
    }),
    ['inconsistent']
  );

  // 85 — A CATALOG FOOD, EDITED. The form opens on the row; Describe it is
  // not offered; Save is inert until something changes; micros are fields.
  const oatsId = createFood(db, {
    name: 'Edit-me oats',
    brand: 'Mill',
    serving_name: '1 cup',
    serving_amount: 80,
    kcal_100g: 379,
    protein_g_100g: 13,
    carbs_g_100g: 67,
    fat_g_100g: 6.5,
    micros: JSON.stringify({ iron_mg: 4.25 }),
  });
  const editHtml = render('food-new (edit)', FoodNewScreen, { id: oatsId });
  expect('food-new (edit)', editHtml, [
    'Edit food',
    'value="Edit-me oats"',
    'value="Mill"',
    'value="379"',
    'value="6.5"',
    'value="4.25"',
    'aria-label="Iron mg"',
    'aria-label="Vitamin D mcg"',
    'Save changes',
  ]);
  refute('food-new (edit)', editHtml, ['Describe it', 'Fill from description', 'Changes the catalog entry']);
  /aria-label="Save changes to this food"[^>]*aria-disabled="true"|aria-disabled="true"[^>]*aria-label="Save changes to this food"/.test(
    editHtml ?? ''
  )
    ? ok('food-new (edit): Save is inert until something changes')
    : bad('food-new (edit): Save enabled on open');
  expect('food-new (gone)', render('food-new (gone)', FoodNewScreen, { id: 'no-such-food' }), [
    'This food is gone',
  ]);
  // A refused scan opens Create with OFF's name and brand filled.
  expect(
    'food-new (refused scan)',
    render('food-new (refused scan)', FoodNewScreen, {
      name: 'Mystery bar',
      brand: 'Somebody',
      barcode: '5000000000041',
    }),
    ['value="Mystery bar"', 'value="Somebody"', '5000000000041', 'Create a food']
  );
  db.run('DELETE FROM foods WHERE id = ?', [oatsId]);
  // The pencil on Add food's open row.
  expect(
    'food-search editor (edit)',
    render('food-search editor (edit)', PortionEditor, {}, {
      expanded: {
        food: { ...milk, is_favorite: 0 },
        portion: { mode: 'serving', qty: 1, amountText: '250' },
        section: 'results',
      },
      amountPreview: 250,
      kcalPreview: 332,
      onStep: noop,
      onEditAmount: noop,
      onToggleFavorite: noop,
      onAdd: noop,
      deleteConsequence: null,
      onArmDelete: noop,
      onDelete: noop,
      onEditFood: noop,
    }),
    ['Edit Fresh Chocolate Milk in the catalog', '>Add<']
  );

  // 92 — THE WHOLE DISH, typed: at rest it is a field holding the parts' sum;
  // typed, the consequence and the accent Save.
  const rolled = {
    amount: 510,
    unit: 'g',
    kcal: 1550,
    protein_g: 71,
    carbs_g: 167,
    fat_g: 66,
    fiber_g: null,
  };
  const dish = (text, open) =>
    render(`meal-detail dish (${text ?? 'untouched'})`, DishAmountRow, {}, {
      name: 'Pepperoni pizza',
      rolled,
      text,
      open,
      onOpen: noop,
      onChange: noop,
      onSave: noop,
    });
  const rest = dish(null, false);
  expect('meal-detail dish (at rest)', rest, [
    'Whole dish',
    'value="510"',
    'aria-label="Pepperoni pizza, whole dish in grams"',
  ]);
  refute('meal-detail dish (at rest)', rest, ['On save', '>Save<', '>Close<']);
  const typed = dish('255', true);
  expect('meal-detail dish (typed)', typed, [
    'On save: every part scales by × 0.50 — 510 g becomes 255 g.',
    '>Save<',
    'aria-label="Save the whole Pepperoni pizza"',
  ]);
  const opened = dish(null, true);
  expect('meal-detail dish (opened, untouched)', opened, [
    '>Close<',
    'aria-label="Close the whole-dish amount for Pepperoni pizza"',
  ]);
  refute('meal-detail dish (opened, untouched)', opened, ['>Save<']);
}


/**
 * 35. Round 3 (2026-10-21) — the live logger's per-set targets, Prev as a
 * button, swipe-to-delete with Undo, Resume over Start on the Train hub, and
 * Add with AI standing in the exercise picker.
 *
 * A server render fires no gestures, so the swipe itself is a device fact; the
 * gesture-handler stub draws the OPEN frame (the row and the Delete it
 * reveals), which is what lets this suite see the action and press it through
 * the element tree. The rules under all of it are db/exercise.test.mjs §16.
 */
console.log('\n35. Round 3 — set targets, Prev, swipe-to-delete, Resume first, Add with AI');
{
  const findEl = (node, match) => {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (match(node)) return node;
    for (const child of React.Children.toArray(node.props?.children ?? [])) {
      const hit = findEl(child, match);
      if (hit) return hit;
    }
    return null;
  };
  const labelled = (label) => (el) => el.props?.accessibilityLabel === label;
  /** Every `<input>` whose aria-label is exactly `label`, as an attribute map. */
  const inputFor = (html, label) => {
    const tag = (html?.match(/<input[^>]*>/g) || []).find((t) =>
      t.includes(`aria-label="${label}"`)
    );
    return tag
      ? Object.fromEntries([...tag.matchAll(/([a-zA-Z-]+)="([^"]*)"/g)].map((m) => [m[1], m[2]]))
      : null;
  };
  const placeholders = (html, field, n) =>
    Array.from({ length: n }, (_, i) => inputFor(html, `${field} for set ${i + 1}`)?.placeholder)
      .map(String)
      .join(',');

  // Last time: a 45 lb warm-up, then 95 × 8 · 8 · 7. Overhead Press is used by
  // no other section, so its history is exactly this (compound: 6–10 reps).
  clearWorkoutDraft(db, 'live');
  const ohp = (reps, lb, setType = 'normal') => ({
    exercise: 'Overhead Press',
    exerciseId: 'overhead-press',
    reps,
    weightKg: lbToKg(lb),
    setType,
  });
  const lastOhp = logWorkout(db, { date: todayISODate(), kind: 'strength' }, [
    ohp(10, 45, 'warmup'),
    ohp(8, 95),
    ohp(8, 95),
    ohp(7, 95),
  ]);

  // THE LIVE LOGGER, NEW, from the hub's freshest-muscle start (3 working sets).
  const live = render('workout-live (round 3 targets)', WorkoutLiveScreen, {
    exerciseIds: 'overhead-press',
  });
  expect('workout-live (round 3 targets)', live, [
    'Overhead Press',
    // The engine's own why, under the title, while rows show its target.
    'Hold the load — add a rep toward the top of the range.',
    // Last time's warm-up comes back as a warm-up row, ahead of the working sets.
    'aria-label="Set 1 type: warmup. Tap to change."',
    // Prev is a button now (67), and says what it will copy.
    'aria-label="Last time, set 2: 8 reps, 95 lb. Fill this set with it."',
    // Swipe-to-delete's revealed action, one per row (69).
    'aria-label="Delete set 1 of Overhead Press"',
    'aria-label="Delete set 4 of Overhead Press"',
  ]);
  const weights = placeholders(live, 'Weight', 4);
  const reps = placeholders(live, 'Reps', 4);
  weights === '45,95,95,95' && reps === '10,9,9,8'
    ? ok(
        'the grey numbers: the warm-up as it was, then 95 × 9 · 9 · 8 — hold the load, one rep more per set'
      )
    : bad('round 3 placeholders', `weights ${weights} · reps ${reps}`);
  refute('workout-live (round 3 targets)', live, ['Delete set 5 of Overhead Press']);

  // AWAY: the same session resumed with Away on — last time's numbers, no why-line.
  const target = {
    kind: 'hold',
    weightKg: lbToKg(95),
    reps: 9,
    repHigh: 10,
    note: 'Hold the load — add a rep toward the top of the range.',
  };
  const prevRows = [
    {
      reps: 8,
      weightKg: lbToKg(95),
      rpe: null,
      durationSec: null,
      distanceM: null,
      setType: 'normal',
    },
    {
      reps: 7,
      weightKg: lbToKg(95),
      rpe: null,
      durationSec: null,
      distanceM: null,
      setType: 'normal',
    },
  ];
  const blankRow = (key) => ({
    key,
    weight: '',
    reps: '',
    rpe: '',
    time: '',
    distance: '',
    setType: 'normal',
    done: false,
    pr: false,
  });
  const ohpBlock = {
    key: 1,
    exerciseId: 'overhead-press',
    name: 'Overhead Press',
    loggingType: 'weight_reps',
    measures: 'reps,load',
    mechanic: 'compound',
    restSec: 120,
    prev: prevRows,
    bestE1rm: null,
    linkedToNext: false,
    sets: [blankRow(1), blankRow(2)],
    target,
  };
  saveWorkoutDraft(db, 'live', {
    version: DRAFT_VERSION,
    startedAt: Date.now() - 60_000,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: true,
    blocks: [ohpBlock],
  });
  const awayHtml = render('workout-live (round 3, away)', WorkoutLiveScreen, { resume: '1' });
  placeholders(awayHtml, 'Reps', 2) === '8,7'
    ? ok('Away on: the rows show last time (8 · 7), not a progression step for another machine')
    : bad('away placeholders', placeholders(awayHtml, 'Reps', 2));
  refute('workout-live (round 3, away)', awayHtml, ['Hold the load']);
  clearWorkoutDraft(db, 'live');

  // fix3: a draft the phone's 0061 build wrote — no target, rows ticked with
  // nothing typed, last time grey beside them. Resumed, a row with last time
  // takes it (what the old build showed) and stays done; a row with nothing to
  // show is un-ticked; and the hub's count agrees before the resume.
  const doneEmpty = (key) => ({ ...blankRow(key), done: true });
  const { target: _oldTarget, ...oldBlock } = ohpBlock;
  saveWorkoutDraft(db, 'live', {
    version: DRAFT_VERSION,
    startedAt: Date.now() - 60_000,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [{ ...oldBlock, sets: [doneEmpty(1), doneEmpty(2), doneEmpty(3)] }],
  });
  expect('exercise hub (fix3, old ticked draft)', render('exercise hub (fix3, old ticked draft)', ExerciseScreen), [
    '2 sets logged',
  ]);
  const oldHtml = render('workout-live (fix3, old ticked draft)', WorkoutLiveScreen, { resume: '1' });
  expect('workout-live (fix3, old ticked draft)', oldHtml, [
    'aria-label="Mark set 1 incomplete"',
    'aria-label="Mark set 2 incomplete"',
    'aria-label="Mark set 3 complete"',
  ]);
  const oldValues = [1, 2]
    .map((i) => `${inputFor(oldHtml, `Weight for set ${i}`)?.value}×${inputFor(oldHtml, `Reps for set ${i}`)?.value}`)
    .join(',');
  oldValues === '95×8,95×7'
    ? ok('…the ticked rows now hold last time’s 95 × 8 · 7, the numbers the old build showed')
    : bad('settled values', oldValues);
  clearWorkoutDraft(db, 'live');

  // fix3: Add set copies the row above's exact kilograms with its text, so a
  // held cross-unit load (137.5 lb shown as 62.4 kg) does not drift on Finish.
  const above = { ...blankRow(1), weight: '62.4', reps: '9', storedWeightKg: lbToKg(137.5), storedWeightText: '62.4' };
  const copied = blankSet(above);
  const retyped = blankSet({ ...above, weight: '65' });
  copied.weight === '62.4' && copied.storedWeightKg === lbToKg(137.5) && copied.storedWeightText === '62.4' &&
  retyped.storedWeightKg === undefined && retyped.weight === '65'
    ? ok('fix3: Add set carries the exact kg behind an untouched weight, and not behind a retyped one')
    : bad('blankSet carry', JSON.stringify({ copied, retyped }));

  // THE EDITOR of last time's session: no targets, no why-line — it happened.
  const editHtml = render('workout-live (round 3, editing)', WorkoutLiveScreen, {
    workoutId: lastOhp,
  });
  expect('workout-live (round 3, editing)', editHtml, [
    'Save changes',
    'aria-label="Delete set 2 of Overhead Press"',
  ]);
  refute('workout-live (round 3, editing)', editHtml, ['Hold the load']);

  // THE BLOCK'S OWN WIRING, pressed through the element tree. ExerciseBlock is
  // hook-free (the RoutineLinesSection precedent), so each control's onPress is
  // the screen's own handler as passed in.
  const calls = [];
  const units = DEFAULT_UNIT_PREFERENCES;
  const hints = ohpBlock.sets.map((set, index) =>
    setHint({ block: ohpBlock, index, set, basis: null, away: false, editing: false, units })
  );
  const removed = removeSetWithUndo(
    [
      {
        ...ohpBlock,
        sets: [blankRow(1), blankRow(2), { ...blankRow(3), reps: '6', weight: '95' }],
      },
    ],
    1,
    3,
    units
  ).removed;
  const blockProps = (over = {}) => ({
    block: ohpBlock,
    loadBasis: null,
    units,
    spec: weightSpec(units),
    hints,
    targetNote: target.note,
    emptySetKey: null,
    undo: null,
    onUndo: () => calls.push('undo'),
    onUsePrev: (bk, sk) => calls.push(`prev ${bk}/${sk}`),
    onPatch: () => {},
    onAddSet: () => {},
    onRemoveSet: (bk, sk) => calls.push(`remove ${bk}/${sk}`),
    onCycleType: () => {},
    onToggleDone: (b, s) => calls.push(`tick ${b.key}/${s.key}`),
    onRemove: () => {},
    onOpenDetail: () => {},
    ...over,
  });
  const tree = ExerciseBlock(blockProps());
  findEl(
    tree,
    labelled('Last time, set 2: 7 reps, 95 lb. Fill this set with it.')
  )?.props.onPress();
  // The swipeable's revealed action: find the row's swipeable by its prop, draw
  // its action as the gesture would, and press it.
  const swipe = findEl(tree, (el) => typeof el.props?.renderRightActions === 'function');
  const action = swipe && swipe.props.renderRightActions();
  action?.props.accessibilityLabel === 'Delete set 1 of Overhead Press'
    ? ok('the first row’s swipe reveals "Delete set 1 of Overhead Press"')
    : bad('swipe action label', action?.props.accessibilityLabel);
  action?.props.onPress();
  const stamp = findEl(tree, labelled('Mark set 2 complete'));
  stamp?.props.onLongPress();
  stamp?.props.onAccessibilityAction({ nativeEvent: { actionName: 'delete' } });
  stamp?.props.onPress();
  calls.join(' | ') === 'prev 1/2 | remove 1/1 | remove 1/2 | remove 1/2 | tick 1/2'
    ? ok(
        'pressed: Prev copies into its own row; swipe, long-press and the VoiceOver action delete; ✓ ticks'
      )
    : bad('block wiring', calls.join(' | '));
  stamp?.props.accessibilityActions?.[0]?.label === 'Delete set 2'
    ? ok('VoiceOver, which cannot swipe, is offered "Delete set 2" on the stamp')
    : bad('a11y action', JSON.stringify(stamp?.props.accessibilityActions));

  // The Undo row, under the table, wired to the screen's undo.
  const withUndo = ExerciseBlock(blockProps({ undo: setRemovalWords(removed) }));
  const undoRow = findEl(withUndo, (el) => el.type === UndoRow);
  undoRow?.props.offer.said === 'Removed set 3 of Overhead Press' &&
  undoRow.props.offer.figure === '6 × 95 lb'
    ? ok('a deleted set leaves "Removed set 3 of Overhead Press · 6 × 95 lb" under the table')
    : bad('undo row', JSON.stringify(undoRow?.props.offer));
  undoRow?.props.onUndo();
  calls.at(-1) === 'undo' ? ok('…and its Undo is the screen’s') : bad('undo wiring');
  expect(
    'ExerciseBlock (undo + refused tick)',
    render(
      'ExerciseBlock (undo + refused tick)',
      ExerciseBlock,
      {},
      blockProps({
        undo: setRemovalWords(removed),
        emptySetKey: 2,
        hints: [null, null],
      })
    ),
    [
      'Removed set 3 of Overhead Press',
      'Undo removing set 3 of Overhead Press',
      'Nothing in this set yet. Type what you did, or tap Prev.',
    ]
  );

  // THE TRAIN HUB: with a session open, Resume is the one accent and the
  // largest control; Train today steps down to an outlined start.
  saveWorkoutDraft(db, 'live', {
    version: DRAFT_VERSION,
    startedAt: Date.now() - 10 * 60_000,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [{ ...ohpBlock, sets: [{ ...blankRow(1), weight: '95', reps: '8', done: true }] }],
  });
  const hubOpen = render('exercise hub (round 3, session open)', ExerciseScreen);
  expect('exercise hub (round 3, session open)', hubOpen, [
    'Session in progress',
    'Resume workout',
    'Start recommended instead',
  ]);
  // Where each control sits: Resume first, above Train today and its start.
  const resumeAt = hubOpen?.indexOf('Resume workout') ?? -1;
  const startAt = hubOpen?.indexOf('Start recommended instead') ?? -1;
  resumeAt >= 0 && startAt > resumeAt
    ? ok('Resume workout comes first; Train today’s start follows it, as the second choice')
    : bad('hub order', JSON.stringify({ resumeAt, startAt }));
  clearWorkoutDraft(db, 'live');
  const hubIdle = render('exercise hub (round 3, no session)', ExerciseScreen);
  refute('exercise hub (round 3, no session)', hubIdle, [
    'Resume workout',
    'Start recommended instead',
  ]);
  // The accent is a CLASS, which a server render does not print, so who wears
  // it is pinned from the source: Resume's button is the pine fill, and Train
  // today steps down (plate, no cap, outlined start) exactly while a session
  // is open — the screen's budget stays one either way.
  const hubSource = readFileSync(new URL('../app/exercise.tsx', import.meta.url), 'utf8');
  const lead = hubSource.slice(hubSource.indexOf('function ResumeLead'));
  /rounded-btn bg-pine[^"]*">\s*<Ionicons name="play"[^>]*\/>\s*<Text[^>]*>Resume workout/.test(
    lead
  ) &&
  hubSource.includes("<Block device={sessionOpen ? 'plate' : 'stamp'} cap={!sessionOpen}>") &&
  hubSource.includes(
    "sessionOpen ? 'border border-hairline active:bg-paper-dim' : 'bg-pine active:opacity-70'"
  ) &&
  hubSource.includes('sessionOpen={drafts.live !== null || drafts.manual !== null}')
    ? ok('the accent moves to Resume while a session is open, and back to Start when none is')
    : bad('hub accent source pin');
  /text: 'Resume it', onPress: resume, isPreferred: true/.test(hubSource)
    ? ok('the "already in progress" alert sets Resume it as the preferred (bold) answer')
    : bad('alert isPreferred');

  // THE PICKER: Add with AI stands at the foot of the catalog on every search.
  const catalog = listExercises(db);
  const browse = (search, filtered, door) =>
    render(
      `exercise picker (${search || 'empty'})`,
      BrowseCatalog,
      {},
      {
        search,
        setSearch: () => {},
        muscle: null,
        setMuscle: () => {},
        filtered,
        onSelect: () => {},
        onOpenDetail: () => {},
        onNew: () => {},
        aiDoor: door,
        onAi: () => {},
      }
    );
  expect(
    'exercise picker (empty)',
    browse(
      '',
      catalog,
      aiDoorCopy({ query: '', offered: false, shown: catalog.length, available: true })
    ),
    ['Not in the catalog?', 'Add with AI', 'aria-label="Add an exercise with AI"']
  );
  const benchHits = catalog.filter((e) => /bench/i.test(e.name));
  expect(
    'exercise picker (bench)',
    browse(
      'bench',
      benchHits,
      aiDoorCopy({ query: 'bench', offered: false, shown: benchHits.length, available: true })
    ),
    ['Barbell Bench Press', 'Not what you’re after?', 'aria-label="Add bench with AI"']
  );
  const noKeyHtml = browse(
    '',
    catalog,
    aiDoorCopy({ query: '', offered: false, shown: 69, available: false })
  );
  expect('exercise picker (no key)', noKeyHtml, ['needs a model key', 'Add with AI']);
  let aiPressed = 0;
  const browseTree = BrowseCatalog({
    search: '',
    setSearch: () => {},
    muscle: null,
    setMuscle: () => {},
    filtered: [],
    onSelect: () => {},
    onOpenDetail: () => {},
    onNew: () => {},
    aiDoor: aiDoorCopy({ query: '', offered: false, shown: 0, available: true }),
    onAi: () => aiPressed++,
  });
  findEl(browseTree, labelled('Add an exercise with AI'))?.props.onPress();
  aiPressed === 1 ? ok('…and the row opens Add with AI') : bad('ai door press');
  expect(
    'Add with AI (nothing typed yet)',
    render(
      'Add with AI (nothing typed yet)',
      AiAddDoor,
      {},
      { query: '', onCancel: () => {}, onCreated: () => {} }
    ),
    ['Name or describe the movement.', 'aria-label="Exercise to add with AI"', 'Write the entry']
  );

  deleteWorkout(db, lastOhp);
}

console.log('\n36. Items 95/84 — intake by the hour, the weight trendline, the recovery trends');
{
  const today = todayISODate();
  setNutritionTargets(db, {
    effective_date: today,
    kcal: 2400,
    protein_g: 180,
    carbs_g: 240,
    fat_g: 70,
  });

  // FOLDED, on the real Eat tab: one line under the bars, no chart drawn.
  const tab = render('Eat tab (intake by the hour, folded)', NutritionScreen, {}, { asTab: true });
  expect('Eat tab (intake by the hour, folded)', tab, [
    'By the hour',
    'data-testid="intake-pace-folded"',
  ]);
  refute('Eat tab (intake by the hour, folded)', tab, [
    'data-testid="intake-chart-kcal"',
    'stroke-dasharray',
  ]);

  // A learned curve from ten synthetic three-meal days — the model is pure, so
  // the component is rendered with a fixed clock and fixed inputs.
  const history = [];
  for (let k = 1; k <= 10; k++) {
    const d = shiftISODate(today, -k);
    history.push(
      { date: d, time: '08:00', kcal: 500, protein_g: 30 },
      { date: d, time: '12:30', kcal: 700, protein_g: 50 },
      { date: d, time: '19:00', kcal: 800, protein_g: 60 }
    );
  }
  const curves = {
    kcal: learnCurve(history, 'kcal', today, '00:00'),
    protein_g: learnCurve(history, 'protein_g', today, '00:00'),
  };
  const todayMeals = [
    { date: today, time: '08:00', kcal: 500, protein_g: 30 },
    { date: today, time: '12:30', kcal: 700, protein_g: 50 },
    { date: today, time: null, kcal: 100, protein_g: 5 },
  ];
  const base = {
    meals: todayMeals,
    curves,
    goals: { kcal: 2400, protein_g: 180 },
    levels: { kcal: 'good', protein_g: 'caution' },
    now: new Date(2026, 9, 21, 14, 0),
    dayStartsAt: '00:00',
    timezoneChanged: false,
  };

  const folded = render('intake by the hour (folded)', IntakeByHour, {}, base);
  expect('intake by the hour (folded)', folded, ['By the hour', '140 kcal behind']);
  refute('intake by the hour (folded)', folded, ['data-testid="intake-chart-kcal"']);

  const open = render(
    'intake by the hour (unfolded)',
    IntakeByHour,
    {},
    {
      ...base,
      initiallyOpen: true,
    }
  );
  expect('intake by the hour (unfolded)', open, [
    'data-testid="intake-pace-open"',
    'data-testid="intake-chart-kcal"',
    'data-testid="intake-chart-protein"',
    // What adjusts: the remainder, the landing range, the pace at this minute.
    '1,100 kcal left · 860–1,340 more lands the day in range',
    '~1,440 expected by 14:00 on your usual day · 140 kcal behind',
    '95 g left · ~103 expected by now',
    'Usual pace',
    '±10% of goal',
    'median of your last 4 weeks — 10 days with timed meals',
    'The goal stays fixed for the day',
    '1 meal with no time is drawn at now',
    // The ±10% band around 2,400, and the goal labelled in the gutter.
    'fill-opacity="0.55"',
    '2,400',
    '180 g',
  ]);
  if (open !== null) {
    const dashed = (open.match(/stroke-dasharray="4 3"/g) || []).length;
    check2(dashed === 2, 'the expected curve is dashed on both charts (2)', String(dashed));
    // The NOW dots wear the grades handed in — on the standard SWATCH cut, the
    // non-text fill — and nothing else on either chart takes a signal colour.
    check2(
      open.includes(`fill="${palette.signal.good}"`) &&
        open.includes(`fill="${palette.signal.caution}"`),
      'the kcal dot wears the kcal bar’s grade, the protein dot the protein bar’s — swatch cut'
    );
    // The `bar` cut is the macro bars' alone ("nothing else takes it",
    // project-status §3 and theme.ts): a chart dot must never borrow it.
    const barCut = Object.values(palette.signalBar).filter((hex) => open.includes(hex));
    check2(
      barCut.length === 0,
      'no chart mark takes the macro bars’ `bar` cut — it stays exclusive to MacroBar',
      barCut.join(', ')
    );
    check2(
      !open.includes(palette.pine) && !open.includes(palette.signal.poor),
      'no accent and no other signal colour anywhere in the charts (the firewall)'
    );
    check2(!open.includes('NaN'), 'no NaN in any coordinate');
    const steps = (open.match(/d="M[^"]* H[^"]* V[^"]*"/g) || []).length;
    check2(steps === 2, 'the eaten lines are STEP paths, one per chart', String(steps));
  }

  const def = render(
    'intake by the hour (default curve)',
    IntakeByHour,
    {},
    {
      ...base,
      curves: { kcal: defaultCurve('00:00', 3), protein_g: defaultCurve('00:00', 3) },
      initiallyOpen: true,
    }
  );
  expect('intake by the hour (default curve)', def, [
    'Default pace',
    '3 of the 7 days with timed meals needed to learn your own are logged',
    'on the default day',
  ]);

  const tz = render(
    'intake by the hour (timezone changed)',
    IntakeByHour,
    {},
    {
      ...base,
      timezoneChanged: true,
      initiallyOpen: true,
    }
  );
  expect('intake by the hour (timezone changed)', tz, [
    'not paced — timezone changed today',
    'no pace is drawn',
  ]);
  refute('intake by the hour (timezone changed)', tz, ['stroke-dasharray', 'Usual pace']);

  // After the usual day's last meal the band speaks, not the pace: 2,300 of
  // 2,400 at 21:30 is inside ±10%.
  const closed = render('intake by the hour (day closed)', IntakeByHour, {}, {
    ...base,
    meals: [...todayMeals, { date: today, time: '19:10', kcal: 1000, protein_g: 60 }],
    now: new Date(2026, 9, 21, 21, 30),
    initiallyOpen: true,
  });
  expect('intake by the hour (day closed)', closed, [
    'Your usual day is done eating by 21:30 — this one reads in range',
    'In range now · up to 340 more stays in it',
  ]);

  // EXACTLY the top edge (2,640 of 2,400) is IN range — bandStatus counts the
  // edges — so the landing line must not call it "0 kcal past the top".
  const topEdge = render('intake by the hour (day closed, top edge)', IntakeByHour, {}, {
    ...base,
    meals: [...todayMeals, { date: today, time: '19:10', kcal: 1340, protein_g: 60 }],
    now: new Date(2026, 9, 21, 21, 30),
    initiallyOpen: true,
  });
  expect('intake by the hour (day closed, top edge)', topEdge, [
    'this one reads in range',
    'In range now · up to 0 more stays in it',
  ]);
  refute('intake by the hour (day closed, top edge)', topEdge, ['past the top of the range']);
  const pastTop = render('intake by the hour (day closed, past the top)', IntakeByHour, {}, {
    ...base,
    meals: [...todayMeals, { date: today, time: '19:10', kcal: 1440, protein_g: 60 }],
    now: new Date(2026, 9, 21, 21, 30),
    initiallyOpen: true,
  });
  expect('intake by the hour (day closed, past the top)', pastTop, [
    '100 kcal past the top of the range',
    'this one reads 100 kcal over range',
  ]);

  // The DEFAULT curve before its first anchor expects nothing, and Home
  // withholds its verdict there — so a breakfast is not "ahead" of it.
  const early = render('intake by the hour (default curve, before 10:00)', IntakeByHour, {}, {
    ...base,
    meals: [{ date: today, time: '08:00', kcal: 500, protein_g: 30 }],
    curves: { kcal: defaultCurve('00:00', 3), protein_g: defaultCurve('00:00', 3) },
    now: new Date(2026, 9, 21, 9, 30),
    initiallyOpen: true,
  });
  expect('intake by the hour (default curve, before 10:00)', early, [
    'pace starts at 10:00',
    'Nothing is expected before 10:00 on the default day',
  ]);
  refute('intake by the hour (default curve, before 10:00)', early, [
    'kcal ahead',
    'kcal behind',
    'on pace',
  ]);

  // A meal timed AFTER now was still eaten by now: the step line stops at the
  // NOW dot, never runs on past it with the dot floating above.
  const future = render('intake by the hour (meal timed after now)', IntakeByHour, {}, {
    ...base,
    meals: [{ date: today, time: '19:00', kcal: 800, protein_g: 20 }],
    initiallyOpen: true,
  });
  if (future !== null) {
    const kcalChart = future.slice(
      future.indexOf('data-testid="intake-chart-kcal"'),
      future.indexOf('data-testid="intake-chart-protein"')
    );
    const step = /d="(M[^"]* H[^"]*)"/.exec(kcalChart)?.[1] ?? '';
    const hs = [...step.matchAll(/H(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const vs = [...step.matchAll(/V(-?[\d.]+)/g)].map((m) => Number(m[1]));
    const cx = Number(/<circle[^>]*cx="([^"]+)"/.exec(kcalChart)?.[1]);
    const cy = Number(/<circle[^>]*cy="([^"]+)"/.exec(kcalChart)?.[1]);
    // Paths print to one decimal, the circle's centre does not — hence 0.06.
    check2(
      hs.length > 0 && Math.max(...hs) <= cx + 0.06 && Math.abs(vs[vs.length - 1] - cy) < 0.06,
      'a meal timed 19:00 seen at 14:00 steps up AT now — the line ends on the dot, not past it',
      `${step} · dot ${cx},${cy}`
    );
  }

  // THE WEIGHT RECORD — the Data row now opens it; seven daily weigh-ins.
  const before = new Set(db.all('SELECT id FROM body_metrics').map((r) => r.id));
  for (let k = 0; k < 7; k++) logMetric(db, shiftISODate(today, -k), 'weight', 80 + k * 0.2);
  const weightHtml = render('weight record (7 weigh-ins)', WeightScreen);
  expect('weight record (7 weigh-ins)', weightHtml, [
    'Last 30 days',
    '7 weigh-ins',
    'data-testid="trend-chart-weight"',
    '7-day average',
    '7-day avg',
    'Log weight',
  ]);
  if (weightHtml !== null) {
    check2(!weightHtml.includes('NaN'), 'weight chart: no NaN');
    const dots = (weightHtml.match(/<circle/g) || []).length;
    check2(dots === 7, 'weight chart: one dot per weigh-in day (7)', String(dots));
  }
  const dataSource = readFileSync(new URL('../app/(tabs)/data.tsx', import.meta.url), 'utf8');
  check2(
    dataSource.includes("router.push('/weight')"),
    'the Data tab’s Weight row opens the weight record'
  );
  for (const r of db.all('SELECT id FROM body_metrics')) {
    if (!before.has(r.id)) db.run('DELETE FROM body_metrics WHERE id = ?', [r.id]);
  }
  // The walk's earlier sections leave older weigh-ins on the record, so the
  // window is empty while the latest-reading field is not — the chart says so
  // in words rather than drawing an empty frame.
  const emptyWeight = render('weight record (empty window)', WeightScreen);
  expect('weight record (empty window)', emptyWeight, ['No readings in this window yet']);
  refute('weight record (empty window)', emptyWeight, ['data-testid="trend-chart-weight"']);

  // RECOVERY TRENDS — HRV with ten days, resting HR with one.
  const rows = [];
  for (let k = 0; k < 10; k++) {
    const date = shiftISODate(today, -k);
    rows.push({
      date,
      metricType: 'hrv',
      value: 45 + k,
      unit: 'ms',
      sourceDevice: 'apple_watch',
      sourceRawId: `fb3:hrv:${date}`,
      startTime: null,
      endTime: null,
      metadata: {},
    });
  }
  rows.push({
    date: today,
    metricType: 'rhr',
    value: 52,
    unit: 'bpm',
    sourceDevice: 'apple_watch',
    sourceRawId: `fb3:rhr:${today}`,
    startTime: null,
    endTime: null,
    metadata: {},
  });
  upsertWearableRows(db, rows);
  const ledger = render('wearables (recovery trends)', WearablesScreen);
  expect('wearables (recovery trends)', ledger, [
    'Recovery trends',
    'Last 30 days',
    'data-testid="trend-chart-hrv"',
    '7-day avg 48 ms',
    'One reading so far — a trend needs at least two.',
  ]);
  if (ledger !== null) check2(!ledger.includes('NaN'), 'recovery trends: no NaN');
  db.run("DELETE FROM wearable_data WHERE source_raw_id LIKE 'fb3:%'");
}

function check2(cond, name, detail) {
  cond ? ok(name) : bad(name, detail);
}

// ---------------------------------------------------------------------------
// 37. Item 71 — the session bar. Owner: "should be able to use the rest of the
// app while in an exercise session." While a live workout is open, a slim bar
// above the tab bar (TabSessionBar, from app/(tabs)/_layout.tsx) and at the
// foot of every pushed screen (Screen) carries its name, elapsed clock and rest,
// and is one tap back to the logger. Never on the logger itself. The decisions
// are pinned in db/exercise.test.mjs §16; here they are drawn.
console.log('\n37. item 71 — the workout in progress rides along, and a tap goes back to it');
{
  clearWorkoutDraft(db, 'live');
  const BAR = /aria-label="Workout in progress, \d+:\d\d elapsed/;
  const barDraft = (over = {}) => ({
    version: DRAFT_VERSION,
    sessionId: 'bar-render',
    startedAt: Date.now() - 12 * 60_000,
    routineId: null,
    ingestId: null,
    restEndsAt: null,
    away: false,
    blocks: [
      {
        key: 1,
        exerciseId: 'barbell-bench-press',
        name: 'Barbell Bench Press',
        loggingType: 'weight_reps',
        measures: 'reps,load',
        mechanic: 'compound',
        restSec: 90,
        prev: [],
        bestE1rm: null,
        linkedToNext: false,
        sets: [
          {
            key: 2,
            weight: '185',
            reps: '5',
            rpe: '',
            time: '',
            distance: '',
            setType: 'normal',
            done: true,
            pr: false,
          },
        ],
      },
    ],
    ...over,
  });

  // --- no session, no bar ----------------------------------------------------------
  __setRoute({ name: 'water', navigator: 'stack' });
  const none = render('water (pushed, no session)', WaterScreen);
  none !== null && !BAR.test(none) && !none.includes('Return to the workout')
    ? ok('a pushed screen with no session open draws no bar')
    : bad('bar without a session');
  renderToString(React.createElement(TabSessionBar)) === ''
    ? ok('…and nor does the tab bar')
    : bad('tab bar without a session');

  // --- an open session: on a pushed screen and above the tab bar ---------------------
  saveWorkoutDraft(db, 'live', barDraft({ restEndsAt: Date.now() + 75_000 }));
  const pushed = render('water (pushed, session open, resting)', WaterScreen);
  pushed !== null && BAR.test(pushed) && /rest 1:1\d left\. Return to the workout"/.test(pushed)
    ? ok('a pushed screen ends in the bar: the workout, its elapsed clock and the rest left')
    : bad('pushed bar', pushed?.match(/aria-label="Workout[^"]*"/)?.[0] ?? 'no bar');
  pushed !== null &&
  pushed.indexOf('Return to the workout') > pushed.lastIndexOf('Add') &&
  pushed.indexOf('Return to the workout') > pushed.indexOf('Water')
    ? ok('…drawn after the screen content, not over it (the scroll view ends above the bar)')
    : bad('bar order');
  expect('water (pushed, session open, resting)', pushed, ['Rest', '12:0']);
  const tabBar = renderToString(React.createElement(TabSessionBar));
  BAR.test(tabBar) && tabBar.includes('Rest')
    ? ok('the tab bar carries the same bar above it')
    : bad('tab bar bar', tabBar.slice(0, 160));
  // The bar spends no accent and no signal colour: chrome, not a verdict.
  // Read from source: react-native-web renders NativeWind classes to atomic
  // CSS, so the class names are not in the markup to be checked there.
  const barSource = readFileSync(
    new URL('../src/components/exercise/session-bar.tsx', import.meta.url),
    'utf8'
  );
  barSource.includes('bg-paper-hi') &&
  !/(bg|text|border)-(pine|signal)|palette\.(pine|signal)/.test(barSource)
    ? ok('the bar is plate stock and spends no accent and no signal colour')
    : bad('bar colour budget');

  // A tab root never draws its own copy — the tab bar's is already there.
  __setRoute({ name: 'index', navigator: 'tab' });
  const home = render('home (tab root, session open)', HomeScreen);
  home !== null && !BAR.test(home)
    ? ok("a tab root's Screen draws no second bar (Home keeps its Resume row)")
    : bad('tab root drew a bar');

  // Never on the live logger itself.
  __setRoute({ name: 'workout-live', navigator: 'stack' });
  const logger = render('workout-live (resumed, with the bar logic live)', WorkoutLiveScreen, {
    resume: '1',
  });
  logger !== null && !BAR.test(logger) && !logger.includes('Return to the workout')
    ? ok('the live logger draws no bar of its own session')
    : bad('bar on the logger');

  // --- the rest ends: "Rest done" -----------------------------------------------------
  saveWorkoutDraft(db, 'live', barDraft({ restEndsAt: Date.now() - 4_000 }));
  __setRoute({ name: 'water', navigator: 'stack' });
  const rested = render('water (pushed, rest over)', WaterScreen);
  rested !== null &&
  rested.includes('Rest done') &&
  /rest done\. Return to the workout"/.test(rested)
    ? ok('a rest that has run out reads "Rest done"')
    : bad('rest done');

  // --- a tap returns to the logger ------------------------------------------------------
  // A server render taps nothing, so the bar's own element is built and its
  // press handler called: it must push the logger, resuming the slot.
  const view = sessionBarView(readOpenLiveSession(db), Date.now());
  const element = SessionBar({ view });
  const press = React.Children.toArray(element.props.children).find(
    (child) => typeof child?.props?.onPress === 'function'
  );
  const pushesBefore = __router.pushes.length;
  press?.props.onPress();
  const pushed1 = __router.pushes[pushesBefore];
  __router.pushes.length === pushesBefore + 1 &&
  pushed1?.pathname === '/workout-live' &&
  pushed1?.params?.resume === '1' &&
  press?.props.accessibilityRole === 'button'
    ? ok('a tap on the bar pushes the live logger with resume=1 — back into the session')
    : bad('tap route', JSON.stringify(pushed1));

  // --- …but never a second logger over the first (review, 2026-10-21) -----------------
  // The logger pushes exercise-detail (a `Screen`, so it draws the bar), and
  // Home can be pushed over it. From there a bare push stacked a second logger
  // and the first read "session ended". The tap now asks restTapTarget, as the
  // "Rest complete" tap does: a logger lower in the stack is gone back to.
  const stackOf = (routes) => ({
    stale: false,
    index: 0,
    routes: [{ name: '__root', state: { stale: false, index: routes.length - 1, routes } }],
  });
  const tapWith = (rootState, el = element) => {
    __setRootState(rootState);
    const before = {
      p: __router.pushes.length,
      d: __router.dismissTos.length,
      n: __router.dismisses.length,
    };
    const btn = React.Children.toArray(el.props.children).find(
      (child) => typeof child?.props?.onPress === 'function'
    );
    btn?.props.onPress();
    return {
      pushes: __router.pushes.slice(before.p),
      dismissTos: __router.dismissTos.slice(before.d),
      dismisses: __router.dismisses.slice(before.n),
    };
  };
  // A return pops BY COUNT to the live logger, never by name (fix4): a pop to
  // the nearest `workout-live` can stop at a past session's editor.
  const returned = (tap, pops) =>
    tap.pushes.length === 0 &&
    tap.dismissTos.length === 0 &&
    tap.dismisses.length === 1 &&
    tap.dismisses[0] === pops;
  const overDetail = tapWith(
    stackOf([
      { name: '(tabs)' },
      { name: 'workout-live', params: { routineId: 'r9' } },
      { name: 'exercise-detail', params: { id: 'barbell-bench-press' } },
    ])
  );
  returned(overDetail, 1)
    ? ok('from exercise-detail pushed by the logger: one pop, back to the logger as it was, no second push')
    : bad('bar over the logger', JSON.stringify(overDetail));
  const tabsOver = tapWith(
    stackOf([{ name: '(tabs)' }, { name: 'workout-live', params: { resume: '1' } }, { name: '(tabs)' }]),
    SessionBar({ view })
  );
  returned(tabsOver, 1)
    ? ok('the tab bar’s copy, with (tabs) pushed above a logger: back to that logger, not a new one')
    : bad('tab bar over the logger', JSON.stringify(tabsOver));
  // The reviewer's stack (popto.cjs): the live logger, the hub, a PAST
  // session's editor, and an exercise's detail. `dismissTo('/workout-live')`
  // stopped at the editor and gave it the live logger's params.
  const overEditor = tapWith(
    stackOf([
      { name: '(tabs)' },
      { name: 'workout-live', params: { resume: '1' } },
      { name: 'exercise' },
      { name: 'workout-live', params: { workoutId: 'W1' } },
      { name: 'exercise-detail', params: { id: 'bench' } },
    ])
  );
  returned(overEditor, 3)
    ? ok('a past session’s editor between: three pops, to the LIVE logger, the editor never handed its params')
    : bad('bar over an editor', JSON.stringify(overEditor));
  const editing = tapWith(
    stackOf([
      { name: '(tabs)' },
      { name: 'workout-live', params: { workoutId: 'w1' } },
      { name: 'exercise-detail', params: { id: 'x' } },
    ])
  );
  editing.dismissTos.length === 0 &&
  editing.dismisses.length === 0 &&
  editing.pushes[0]?.params?.resume === '1'
    ? ok('a logger correcting a SAVED session is not the live one: the live one is resumed by a push')
    : bad('editing logger', JSON.stringify(editing));
  const noLogger = tapWith(stackOf([{ name: '(tabs)' }, { name: 'water' }]));
  noLogger.dismissTos.length === 0 && noLogger.dismisses.length === 0 && noLogger.pushes.length === 1
    ? ok('no logger on the stack: a push, resuming the slot')
    : bad('no logger', JSON.stringify(noLogger));
  __setRootState(undefined);

  // --- finished or discarded: the bar goes ---------------------------------------------
  clearOwnLiveDraft(db, 'bar-render'); // what Finish and the logger's Discard call
  const finished = render('water (pushed, session finished)', WaterScreen);
  finished !== null &&
  !BAR.test(finished) &&
  renderToString(React.createElement(TabSessionBar)) === ''
    ? ok('after Finish/Discard empties the slot, neither host draws the bar')
    : bad('bar after finish');
  saveWorkoutDraft(db, 'live', barDraft());
  clearWorkoutDraft(db, 'live'); // the Train hub's trash
  renderToString(React.createElement(TabSessionBar)) === ''
    ? ok('…and the same after a discard from the Train hub')
    : bad('bar after hub discard');

  // --- one rest, one source -------------------------------------------------------------
  // The bar computes rest from the draft's `restEndsAt` with the logger's own
  // expression; if either side changes its rounding, this fails rather than
  // letting the two read a second apart. And the bar schedules nothing.
  const loggerSource = readFileSync(new URL('../app/workout-live.tsx', import.meta.url), 'utf8');
  const barLib = readFileSync(
    new URL('../src/lib/exercise/session-bar.ts', import.meta.url),
    'utf8'
  );
  const barUi = readFileSync(
    new URL('../src/components/exercise/session-bar.tsx', import.meta.url),
    'utf8'
  );
  const expr = 'Math.max(0, Math.round((restEndsAt - now) / 1000))';
  loggerSource.includes(expr) && barLib.includes(expr)
    ? ok("the bar's rest arithmetic is the logger's, character for character")
    : bad('rest arithmetic drifted');
  ![barLib, barUi].some((src) =>
    /scheduleRestAlert|cancelRestAlert|setRestEndsAt|saveWorkoutDraft\(/.test(src)
  )
    ? ok('the bar arms no alert and writes no draft — it only reads the one rest')
    : bad('bar writes or schedules');

  // --- the layout seams, from source (a server render has no layout) ---------------------
  const screenSource = readFileSync(
    new URL('../src/components/ui/screen.tsx', import.meta.url),
    'utf8'
  );
  /<\/SafeAreaView>\s*\{session \? <LiveSessionBar session=\{session\} inset=\{insets\.bottom\} \/> : null\}/.test(
    screenSource
  ) && screenSource.includes("edges.filter((edge) => edge !== 'bottom')")
    ? ok('Screen puts the bar after its safe-area view and hands it the bottom inset')
    : bad('screen seam');
  const tabsSource = readFileSync(new URL('../app/(tabs)/_layout.tsx', import.meta.url), 'utf8');
  /<TabSessionBar \/>\s*<BottomTabBar \{\.\.\.props\} \/>/.test(tabsSource) &&
  !/position:\s*'absolute'/.test(tabsSource)
    ? ok('the tab bar draws the session bar directly above itself, in the column, not floated')
    : bad('tab seam');

  __setRoute({});
}

console.log('\n38. Item 70 — a finished session’s tick, and its Undo on Home and the Train hub');
{
  const { tickTrainingAfterSave } = await import('../src/lib/exercise/training-tick-offer.ts');
  const today = todayISODate();
  const findEl = (node, match) => {
    if (node === null || node === undefined || typeof node !== 'object') return null;
    if (match(node)) return node;
    for (const child of React.Children.toArray(node.props?.children ?? [])) {
      const hit = findEl(child, match);
      if (hit) return hit;
    }
    return null;
  };
  const rowStatus = () =>
    db.get(
      `SELECT e.status AS status FROM log_entries e JOIN daily_logs d ON d.id = e.daily_log_id
        WHERE d.date = ? AND e.title = 'Sled push'`,
      [today]
    )?.status;
  closeUndo();
  refute('home (no tick)', render('home (no tick)', HomeScreen), ['Ticked Training']);

  createProtocolWithVersion(
    db,
    { name: 'Render block', type: 'training_block' },
    { items: [{ title: 'Sled push', scheduled_time: '00:01', dose: null, notes: null }] }
  );
  // Today is already committed in this database, so the new protocol reaches
  // it the way a protocol save does.
  const { rederiveMissionFromToday } = await import(
    '../src/lib/db/repositories/mission-generate.ts'
  );
  rederiveMissionFromToday(db, today);
  const w = logWorkout(db, { date: today, kind: 'strength' });
  const tick = tickTrainingAfterSave(db, w, () => {});
  tick?.title === 'Sled push' && rowStatus() === 'completed'
    ? ok('the finished session ticked the day’s Training row')
    : bad('render tick', JSON.stringify(tick));

  for (const [name, Screen] of [
    ['home (a session ticked a row)', HomeScreen],
    ['exercise hub (a session ticked a row)', ExerciseScreen],
  ]) {
    expect(name, render(name, Screen), [
      'Ticked Training: Sled push',
      'aria-label="Undo ticking Sled push"',
      '>Undo<',
    ]);
  }

  // The row's own Undo, pressed through its element tree: it unticks exactly
  // that row, and both screens stop drawing it.
  const tree = UndoRow({ offer: currentUndo(), onUndo: runUndo, first: true });
  findEl(tree, (el) => el.props?.accessibilityLabel === 'Undo ticking Sled push')?.props.onPress();
  rowStatus() === 'pending' && currentUndo() === null
    ? ok('Undo puts the row back to open and closes the offer')
    : bad('render undo', rowStatus());
  refute('home (after Undo)', render('home (after Undo)', HomeScreen), ['Ticked Training']);
  refute('exercise hub (after Undo)', render('exercise hub (after Undo)', ExerciseScreen), [
    'Ticked Training',
  ]);

  // Home's handler reloads the mission after the Undo; the hub needs nothing
  // but the store's re-render.
  const homeSource = readFileSync(new URL('../app/(tabs)/index.tsx', import.meta.url), 'utf8');
  homeSource.includes("useUndoOffer('training', todayISODate())") &&
  homeSource.includes('runUndo();\n    reloadMission();')
    ? ok('Home draws the training offer for today and re-reads the mission after its Undo')
    : bad('home wiring');
  readFileSync(new URL('../app/exercise.tsx', import.meta.url), 'utf8').includes(
    "useUndoOffer('training', today)"
  )
    ? ok('the Train hub draws the same offer')
    : bad('hub wiring');

  deleteWorkout(db, w);
}

console.log('\n39. 2026-10-21 — a food joins its meal, saved and past meals in search, usual add-ons, a repeat');
{
  const { joinNearbyMealWithUndo } = await import('../src/lib/nutrition/undo-offers.ts');
  const { MealHitsPlate } = await import('../app/food-search.tsx');
  const { UsualAddOns } = await import('../src/components/nutrition/usual-add-ons.tsx');
  const { RepeatFoodRow } = await import('../src/components/nutrition/repeat-food-offer.tsx');
  const noop = () => {};
  const today = todayISODate();

  // 58 — THE JOIN, SAID. A real join on the suite's database: the receipt is
  // drawn on the Eat tab, under Add food's field and under the scanner's count.
  closeUndo();
  logMealWithItems(db, {
    date: today,
    time: '05:10',
    name: 'Brunch test',
    items: [{ name: 'Sourdough', amount: 80, kcal: 210 }],
  });
  const kombucha = logMealWithItems(db, {
    date: today,
    time: '05:30',
    name: 'Kombucha test',
    items: [{ name: 'Kombucha', amount: 330, unit: 'ml', kcal: 60 }],
  }).mealId;
  const joined = joinNearbyMealWithUndo(db, kombucha);
  joined?.name === 'Brunch test'
    ? ok('the kombucha joined Brunch test, which kept its name')
    : bad('render join', JSON.stringify(joined && joined.name));
  const eat = render('nutrition (a food joined a meal)', NutritionScreen, {}, { asTab: true });
  expect('nutrition (a food joined a meal)', eat, ['Added to Brunch test', '05:10', 'Undo adding Kombucha test to Brunch test']);
  refute('nutrition (a food joined a meal)', eat, ['>Kombucha test<']);
  expect('food-search (a food joined a meal)', render('food-search (a food joined a meal)', FoodSearchScreen), [
    'Added to Brunch test',
  ]);
  expect('barcode-scan (a food joined a meal)', render('barcode-scan (a food joined a meal)', BarcodeScanScreen), [
    'Added to Brunch test',
  ]);
  runUndo();
  refute('nutrition (join undone)', render('nutrition (join undone)', NutritionScreen, {}, { asTab: true }), [
    'Added to Brunch test',
  ]);
  expect('nutrition (join undone)', render('nutrition (join undone) list', NutritionScreen, {}, { asTab: true }), [
    'Kombucha test',
  ]);
  closeUndo();

  // 74 — SAVED AND PAST MEALS IN SEARCH: their own plates, one tap each.
  const hitsHtml = render('food-search meal hits', MealHitsPlate, {}, {
    label: 'Past meals',
    hits: [{ kind: 'meal', id: 'm1', name: 'Pizza night', kcal: 1250, itemCount: 1, date: '2026-10-20' }],
    onAdd: noop,
  });
  expect('food-search meal hits', hitsHtml, ['Past meals', 'Pizza night', '1 item · 2026-10-20', '1,250', 'Add Pizza night']);
  render('food-search meal hits (none)', MealHitsPlate, {}, { label: 'Saved meals', hits: [], onAdd: noop }) === ''
    ? ok('no hits: no plate at all')
    : bad('empty hits plate drew');

  // 64 — USUAL ADD-ONS: chips, the label voice, the 44 pt floor; none cold.
  const addOn = (name, amount) => ({
    key: `name:${name.toLowerCase()}`,
    name,
    times: 3,
    latest: { name, amount, unit: 'ml', created_at: '' },
  });
  const chips = render('usual add-ons', UsualAddOns, {}, {
    drink: 'Flat white',
    addOns: [addOn('Oat milk', 60), addOn('Vanilla syrup', 10)],
    volume: 'ml',
    onAdd: noop,
  });
  expect('usual add-ons', chips, ['Usual', '+ Oat milk', '60 ml', '+ Vanilla syrup', 'Add Oat milk, 60 ml, to this meal with the Flat white']);
  refute('usual add-ons', chips, ['bg-accent', 'text-accent']);
  render('usual add-ons (cold start)', UsualAddOns, {}, { drink: 'Flat white', addOns: [], volume: 'ml', onAdd: noop }) === ''
    ? ok('cold start: nothing is drawn')
    : bad('cold start drew');
  // On the meal screen, from real history: two earlier cortados with milk.
  for (const d of [-3, -2]) {
    logMealWithItems(db, {
      date: shiftISODate(today, d),
      time: '07:00',
      name: 'Cortado run',
      items: [
        { name: 'Cortado test', amount: 120, unit: 'ml', kcal: 60 },
        { name: 'Macadamia milk', amount: 40, unit: 'ml', kcal: 20 },
      ],
    });
  }
  const cortado = logMealWithItems(db, {
    date: today,
    time: '07:00',
    name: 'Cortado run',
    items: [{ name: 'Cortado test', amount: 120, unit: 'ml', kcal: 60 }],
  }).mealId;
  const md = render('meal-detail (usual add-ons)', MealDetailScreen, { id: cortado });
  expect('meal-detail (usual add-ons)', md, ['Usual', '+ Macadamia milk']);

  // 73/74 — THE REPEAT OFFER, both states.
  const repeat = {
    key: 'name:oat latte',
    times: 3,
    latest: { name: 'Oat latte', amount: 350, unit: 'ml' },
  };
  const offerHtml = render('repeat food (offered)', RepeatFoodRow, {}, {
    offer: { repeat, saved: false },
    onSave: noop,
    onDismiss: noop,
  });
  expect('repeat food (offered)', offerHtml, ['Oat latte', 'logged 3×', 'Save as a food', 'Not now']);
  const savedHtml = render('repeat food (saved)', RepeatFoodRow, {}, {
    offer: { repeat, saved: true },
    onSave: noop,
    onDismiss: noop,
  });
  expect('repeat food (saved)', savedHtml, ['Saved Oat latte as a food. Find it in Add food.']);
  refute('repeat food (saved)', savedHtml, ['role="button"']);
  const eatSrc = readFileSync(new URL('../app/nutrition.tsx', import.meta.url), 'utf8');
  eatSrc.includes('const repeat = useRepeatFoodOffer(today);') && eatSrc.includes('<RepeatFoodRow')
    ? ok('the Eat tab takes the offer on focus and draws it at the foot of Eaten today')
    : bad('eat tab wiring');
}

console.log('\n40. Item 86 — was this estimate right? Good / Off, the one question, the correction kept');
{
  const ratings = await import('../src/lib/db/repositories/food-log-ratings.ts');
  const { EstimateRatingLine } = await import('../src/components/nutrition/estimate-rating.tsx');
  const noop = () => {};
  const today = todayISODate();
  const estimatedMeal = (name) =>
    logMealWithItems(db, {
      date: today,
      time: '12:30',
      name,
      source: 'ai_suggested',
      items: [{ name: 'Chicken salad', amount: 350, kcal: 520, protein_g: 40, carbs_g: 10, fat_g: 30, confidence: 'medium' }],
    }).mealId;

  // UNRATED, on an estimated meal: the question, quiet, under the items.
  const fresh = estimatedMeal('Rated lunch test');
  const unrated = render('meal-detail (estimate unrated)', MealDetailScreen, { id: fresh });
  expect('meal-detail (estimate unrated)', unrated, [
    'Was this right?',
    '>Good<',
    '>Off<',
    'This estimate was right',
    'This estimate was off',
  ]);
  unrated !== null &&
  unrated.indexOf('Was this right?') > unrated.indexOf('Add food to this meal') &&
  unrated.indexOf('Was this right?') < unrated.indexOf('Adjust with AI')
    ? ok('one place: between the Items plate and the Actions — never a modal')
    : bad('rating line placement');

  // A meal logged by hand, and one still waiting on its estimate, draw nothing.
  const manual = logMealWithItems(db, {
    date: today,
    time: '13:00',
    name: 'Typed lunch test',
    items: [{ name: 'Rice', amount: 200, kcal: 260 }],
  }).mealId;
  refute('meal-detail (logged by hand)', render('meal-detail (logged by hand)', MealDetailScreen, { id: manual }), [
    'Was this right?',
  ]);
  const { mealId: pendingId } = queueNewMealEstimate(
    db,
    { date: today, time: '13:30', name: placeholderMealName('a bowl of pho') },
    { kind: 'text', description: 'a bowl of pho' }
  );
  refute('meal-detail (estimate pending)', render('meal-detail (estimate pending)', MealDetailScreen, { id: pendingId }), [
    'Was this right?',
  ]);

  // OFF — the one question, three answers.
  ratings.rateMeal(db, fresh, 'bad');
  const asking = render('meal-detail (rated off)', MealDetailScreen, { id: fresh });
  expect('meal-detail (rated off)', asking, [
    'What was off?',
    '>Portion<',
    '>Item<',
    '>Macros<',
    'The portion was off',
    'The item was off',
    'The macros were off',
  ]);
  refute('meal-detail (rated off)', asking, ['Was this right?']);

  // ANSWERED, not yet fixed: what was said, and what to do.
  ratings.setRatingIssue(db, fresh, 'portion');
  const answered = render('meal-detail (off · portion)', MealDetailScreen, { id: fresh });
  expect('meal-detail (off · portion)', answered, [
    'Off · Portion',
    'Set the portion on the item above.',
    'What you change is kept as an example for the next estimate.',
    'Change the rating of this estimate',
  ]);

  // FIXED: the correction is the example.
  const [salad] = listMealItems(db, fresh);
  const { updateMealItemPortion } = await import('../src/lib/db/repositories/nutrition.ts');
  updateMealItemPortion(db, salad.id, { amount: 250, kcal: 371, protein_g: 29, carbs_g: 7, fat_g: 21 });
  ratings.settleMealRating(db, fresh);
  expect('meal-detail (corrected)', render('meal-detail (corrected)', MealDetailScreen, { id: fresh }), [
    'Off · Portion · corrected',
    'Kept as an example for the next estimate.',
  ]);

  // GOOD: one line read back.
  const goodMeal = estimatedMeal('Good lunch test');
  ratings.rateMeal(db, goodMeal, 'good');
  const goodHtml = render('meal-detail (rated good)', MealDetailScreen, { id: goodMeal });
  expect('meal-detail (rated good)', goodHtml, ['>Estimate<', '>Good<', 'Change the rating of this estimate']);
  refute('meal-detail (rated good)', goodHtml, ['Was this right?', 'What was off?', 'kept as an example']);

  // THE LINE ON ITS OWN: Change asks again with a Cancel; Off over an answer
  // asks the question again; never the accent, never a signal colour.
  const line = (view, step) =>
    render(`rating line (${step})`, EstimateRatingLine, {}, {
      view,
      step,
      onRate: noop,
      onIssue: noop,
      onChange: noop,
    });
  const changing = line({ rating: 'good', issue: null, corrected: false }, 'verdict');
  expect('rating line (verdict)', changing, ['Was this right?', '>Cancel<', 'Keep the rating as it was']);
  const reasked = line({ rating: 'bad', issue: 'portion', corrected: true }, 'issue');
  expect('rating line (issue)', reasked, ['What was off?', '>Macros<']);
  refute('rating line (unrated)', line(null, 'idle'), ['Cancel']);
  for (const [name, html] of [
    ['verdict', changing],
    ['issue', reasked],
    ['answered', line({ rating: 'bad', issue: 'item', corrected: false }, 'idle')],
  ]) {
    refute(`rating line (${name})`, html, ['pine', 'signal-', 'accent']);
  }
  expect('rating line (answered, item)', line({ rating: 'bad', issue: 'item', corrected: false }, 'idle'), [
    'Off · Item',
    'Say what it was in Adjust with AI, or change the items above.',
  ]);

  // WIRING, as source: the window writes only while open; Item and Macros go
  // to Adjust with AI with the answer; the revise screen reads it.
  const mdSrc = readFileSync(new URL('../app/meal-detail.tsx', import.meta.url), 'utf8').replace(/\s+/g, ' ');
  const mrSrc = readFileSync(new URL('../app/meal-revise.tsx', import.meta.url), 'utf8');
  mdSrc.includes('if (correcting.current) { try { settleMealRating(getDb(), mealId);') &&
  mdSrc.includes("router.push({ pathname: '/meal-revise', params: { id: mealId, issue } });") &&
  mdSrc.includes("meal.source === 'ai_suggested' && items.length > 0 ?") &&
  mrSrc.includes("issue === 'macros'") &&
  !readFileSync(new URL('../app/meal-estimate.tsx', import.meta.url), 'utf8').includes('EstimateRatingLine')
    ? ok('the correction window settles on re-read; Item / Macros push Adjust with AI with the answer; the review screen draws no rating')
    : bad('rating wiring');
}

console.log('\n41. Experiments end to end — the readout on the experiment screen');
{
  // A metric no earlier section seeds, so the shared database's other
  // fixtures cannot move these numbers.
  const today = todayISODate();
  const seedResp = (from, count, value) => {
    for (let i = 0; i < count; i++) {
      db.run(
        `INSERT INTO wearable_data (id, date, metric_type, value, unit, source_device)
         VALUES (?, ?, 'respiratory_rate', ?, 'brpm', 'apple_watch')`,
        [`resp-${from}-${i}`, shiftISODate(from, i), value + (i % 2 === 0 ? -0.5 : 0.5)]
      );
    }
  };
  const design = (title, start, durationDays) =>
    createExperiment(db, {
      title,
      hypothesis: 'Mouth taping lowers breathing rate',
      intervention: 'Mouth tape at night',
      metrics: ['respiratory_rate', 'mood'],
      startDate: start,
      durationDays,
    });

  // RUNNING: started 5 days ago, 14 planned; baseline 14 days before it.
  const runStart = shiftISODate(today, -5);
  const running = design('Mouth tape (running)', runStart, 14);
  seedResp(shiftISODate(runStart, -14), 14, 16);
  const runHtml = render('experiment-detail (running)', ExperimentDetailScreen, { id: running });
  expect('experiment-detail (running)', runHtml, [
    '>Readout<',
    'so far',
    'Respiratory rate',
    '16 → — brpm',
    'n 14 / 0',
    'Too few readings',
    'Not a series ARC records — read qualitatively.',
    '>Adherence<',
    '>Excluded days<',
    'None — every day in both windows counts.',
    'Before a verdict',
    'The window is open: day 6 of 14',
  ]);
  // No signal colour and no accent on a readout: a gate is a fact about two
  // windows, never a judgment about the body, and the screen stays read-only.
  refute('experiment-detail (running)', runHtml, ['signal-', 'pine', 'Conclude', 'supported']);

  // CONCLUDED through the Coach's own write: the snapshot rides the verdict.
  const doneStart = shiftISODate(today, -40);
  const concluded = design('Mouth tape (concluded)', doneStart, 14);
  seedResp(shiftISODate(doneStart, -14), 14, 16);
  seedResp(doneStart, 14, 14);
  toolByName('edit_record').execute(
    db,
    {
      domain: 'experiments',
      id: concluded,
      fields: {
        status: 'concluded',
        conclusion: 'Breathing rate fell about 2 a minute.',
        outcome_notes: 'Adherence was not tracked on the mission.',
      },
    },
    { now: new Date() }
  );
  const doneHtml = render('experiment-detail (concluded)', ExperimentDetailScreen, { id: concluded });
  expect('experiment-detail (concluded)', doneHtml, [
    'at conclusion',
    '16 → 14 brpm',
    'Δ -2 (-12.5%) · n 14 / 14',
    'Gate met',
    '>Notes<',
    'Adherence was not tracked on the mission.',
    // No mission rows were written for it, so the readout says so in numbers.
    '14 d: 14 not on the day',
    'under the 80% floor',
  ]);
  refute('experiment-detail (concluded)', doneHtml, [
    'signal-',
    'pine',
    '[ARC readout at conclusion]',
    'No numbers were stored',
  ]);

  // A verdict that predates the snapshot says so rather than recomputing one.
  const legacy = design('Mouth tape (legacy)', shiftISODate(today, -80), 7);
  completeExperiment(db, legacy, { conclusion: 'An old verdict.', outcomeNotes: 'Old notes.' });
  const legacyHtml = render('experiment-detail (legacy verdict)', ExperimentDetailScreen, {
    id: legacy,
  });
  expect('experiment-detail (legacy verdict)', legacyHtml, [
    'An old verdict.',
    'Old notes.',
    'No numbers were stored with this verdict.',
  ]);
  refute('experiment-detail (legacy verdict)', legacyHtml, ['>Readout<']);
}

console.log('\n42. Calendar context — the Settings › Coach switch, off until he turns it on');
{
  const { CalendarSetting, calendarAccessNote } = await import(
    '../src/components/coach/calendar-setting.tsx'
  );
  const { setCalendarContextOn } = await import('../src/lib/db/repositories/calendar-setting.ts');
  const noop = () => {};

  const screen = render('settings-coach (calendar)', SettingsCoachScreen);
  expect('settings-coach (calendar)', screen, [
    '>Calendar<',
    'The next 7 days, so the Coach can plan around them · read-only',
    'aria-label="Calendar"',
    'Every calendar on this phone.',
    'never its notes, attendees or links',
    'ARC never writes to your calendar or keeps a copy of it; a Coach reply that mentions an event is saved like any reply.',
  ]);
  // OFF by default: the one switch labelled Calendar is unchecked.
  const calendarSwitch = screen?.match(/<input[^>]*aria-label="Calendar"[^>]*>/)?.[0] ?? '';
  calendarSwitch && !/\schecked(=|\s|>)/.test(calendarSwitch)
    ? ok('settings-coach: the Calendar switch is OFF on a fresh install')
    : bad('settings-coach: Calendar switch not found or on by default', calendarSwitch);
  // With the switch off iOS is never asked (not even a permission check), so no
  // access sentence. The only fact read is whether the build carries the module
  // — and this headless render has none, so it says so at once.
  refute('settings-coach (calendar)', screen, ['iOS has calendar access off']);
  expect('settings-coach (calendar, no module here)', screen, ['This build of ARC can’t read calendars yet.']);

  setCalendarContextOn(db, true);
  const onScreen = render('settings-coach (calendar on)', SettingsCoachScreen);
  const onSwitch = onScreen?.match(/<input[^>]*aria-label="Calendar"[^>]*>/)?.[0] ?? '';
  /\schecked(=|\s|>)/.test(onSwitch)
    ? ok('settings-coach: his stored ON reads back as an ON switch')
    : bad('settings-coach: stored ON did not render on', onSwitch);
  setCalendarContextOn(db, false);

  const revoked = render('calendar-setting (revoked)', CalendarSetting, {}, { on: true, access: 'denied', onChange: noop });
  expect('calendar-setting (revoked)', revoked, [
    'Calendar access is off for ARC in iOS Settings, so the Coach sees no events.',
  ]);
  const refused = render('calendar-setting (refused)', CalendarSetting, {}, { on: false, access: 'denied', onChange: noop });
  expect('calendar-setting (refused)', refused, [
    'iOS has calendar access off for ARC. Allow Full Access in iOS Settings under ARC › Calendars, then turn this on.',
  ]);
  const oldBuild = render('calendar-setting (old build)', CalendarSetting, {}, { on: false, access: 'unavailable', onChange: noop });
  expect('calendar-setting (old build)', oldBuild, ['This build of ARC can’t read calendars yet.']);
  const oldSwitch = oldBuild?.match(/<input[^>]*aria-label="Calendar"[^>]*>/)?.[0] ?? '';
  /\sdisabled(=|\s|>)/.test(oldSwitch)
    ? ok('calendar-setting: the switch is disabled in a build without the module')
    : bad('calendar-setting: switch not disabled when unavailable', oldSwitch);
  calendarAccessNote(true, 'granted') === null &&
  calendarAccessNote(false, 'undetermined') === null &&
  calendarAccessNote(false, null) === null &&
  calendarAccessNote(true, 'undetermined')?.startsWith('iOS hasn’t been asked on this phone yet')
    ? ok('calendar-setting: silent when access matches the switch; a restored ON with no grant says so')
    : bad('calendar-setting: note logic');
  for (const [name, html] of [
    ['revoked', revoked],
    ['refused', refused],
    ['old build', oldBuild],
  ]) {
    refute(`calendar-setting (${name})`, html, ['pine', 'accent']);
  }
}

console.log('\n43. Coach proposals and the model-voiced brief — Home’s Coach card and the thread record');
{
  const { CoachNote } = await import('../src/components/home/coach-note.tsx');
  const { ProposalRecord } = await import('../src/components/coach/proposal-card.tsx');
  const P = await import('../src/lib/ai/proposals.ts');
  const { parsePassLines } = await import('../src/lib/ai/proposal-lines.ts');
  const noop = () => {};
  const now = new Date();

  // Nothing drafted, no brief: no Coach card, and the deterministic brief stands.
  const quiet = render('home (no pass output)', HomeScreen);
  expect('home (no pass output)', quiet, ['Coach Brief']);
  refute('home (no pass output)', quiet, ['For your approval', 'Coach · today']);

  // A pass's output, stored as the pass stores it: a brief and one draft.
  const parsed = parsePassLines(
    'PROPOSE set_reminder {"title":"Lights out","time":"22:15"} Bed has drifted past 23:00 three nights running.'
  );
  const { drafted } = P.draftProposals(db, parsed.proposals, parsed.malformed, now);
  const [kept] = P.recordProposals(db, drafted, [], now);
  // The server render escapes quotes; the card line carries two.
  const shownSummary = kept.summary.replace(/"/g, '&quot;');
  P.saveBrief(db, ['Recovery is the thing today: sleep ran short again.', 'Keep the session easy.'], now);
  const home = render('home (brief + a draft)', HomeScreen);
  expect('home (brief + a draft)', home, [
    'Coach · today',
    'Recovery is the thing today: sleep ran short again.',
    'For your approval',
    shownSummary,
    'Bed has drifted past 23:00 three nights running.',
    `aria-label="Approve: ${shownSummary}"`,
    '>Decline<',
  ]);
  refute('home (brief + a draft)', home, ['Coach Brief', 'PROPOSE', 'BRIEF']);

  // The card on its own: every state a draft can be in, and a removal's cost.
  const base = { ...kept, messageId: null };
  const states = render('coach card (all states)', CoachNote, {}, {
    message: 'Your protein has been under target all week.',
    onDismiss: noop,
    brief: null,
    proposals: [
      { ...base, id: 'a', summary: 'Delete meal "Pasta"', status: 'pending', until: '14:00', snapshot: { ...base.snapshot, kind: 'delete' } },
      { ...base, id: 'b', summary: 'Approved one', status: 'approved', outcome: 'Approved one' },
      { ...base, id: 'c', summary: 'Declined one', status: 'declined' },
      { ...base, id: 'd', summary: 'Expired one', status: 'expired' },
      { ...base, id: 'e', summary: 'Moved one', status: 'refused', outcome: 'the card said x, it now reads y. Nothing written.' },
    ],
    busyId: null,
    onApprove: noop,
    onDecline: noop,
  });
  expect('coach card (all states)', states, [
    'Coach noticed',
    'Dismiss the Coach',
    'Deleted for good on Approve · Open until 14:00',
    'Saved to your record',
    'Declined, not saved',
    'Expired, not saved',
    'Not written: the card said x, it now reads y. Nothing written.',
  ]);
  // Exactly one pending row, so exactly one Approve.
  (states.match(/>Approve</g) ?? []).length === 1
    ? ok('only the pending draft offers Approve')
    : bad('approve count', String((states.match(/>Approve</g) ?? []).length));
  const briefOnly = render('coach card (brief only)', CoachNote, {}, {
    message: null,
    onDismiss: noop,
    brief: ['One line.'],
  });
  expect('coach card (brief only)', briefOnly, ['Coach · today', 'One line.']);
  refute('coach card (brief only)', briefOnly, ['Dismiss the Coach', 'For your approval']);

  // The thread record: a ruled plate, no accent, no signal colour.
  const record = render('thread record', ProposalRecord, {}, {
    proposals: [{ ...base, id: 'r1' }, { ...base, id: 'r2', summary: 'Second', status: 'declined' }],
    busyId: null,
    onApprove: noop,
    onDecline: noop,
  });
  expect('thread record', record, ['Drafted by the Coach', '1 to answer', shownSummary, 'Declined, not saved']);
  refute('thread record', record, ['pine', 'signal-']);
  const busy = render('thread record (a tap in flight)', ProposalRecord, {}, {
    proposals: [{ ...base, id: 'r1' }],
    busyId: 'r1',
    onApprove: noop,
    onDecline: noop,
  });
  expect('thread record (a tap in flight)', busy, ['aria-disabled="true"']);

  // WIRING, as source: the thread draws the record under the row it names,
  // with the record text stripped from the bubble; Home falls back to the
  // deterministic brief only when there is no model brief.
  const coachSrc = readFileSync(new URL('../app/(tabs)/coach.tsx', import.meta.url), 'utf8');
  const homeSrc = readFileSync(new URL('../app/(tabs)/index.tsx', import.meta.url), 'utf8');
  coachSrc.includes('drafts.all.filter((p) => p.messageId === message.id)') &&
  coachSrc.includes('splitProposalRecord(message.content)') &&
  coachSrc.includes('<ProposalRecord') &&
  homeSrc.includes('{coach.brief ? null : (') &&
  homeSrc.includes('const coach = useCoachProposals(mission.reload);')
    ? ok('the thread draws each pass row’s drafts under it; Home hides the deterministic brief only behind a model one')
    : bad('proposal wiring');

  db.run(
    "UPDATE users SET preferences = json_remove(preferences, '$.coachProposals', '$.coachBrief')"
  );
  expect('home (cleared)', render('home (cleared)', HomeScreen), ['Coach Brief']);
}

console.log('\n44. Track 0 (2026-10-21) — Coach usage, the new models, and a parked estimate');
{
  const today = todayISODate();
  // Coach usage, empty: it says it has nothing yet, and that figures are estimates.
  const empty = render('coach usage (empty)', SettingsCoachUsageScreen);
  expect('coach usage (empty)', empty, [
    'Coach usage',
    'Spend',
    'est.',
    'Today',
    'Last 7 days',
    'This month',
    '$0.00',
    'No model calls recorded this month yet.',
    'not your invoice',
    'Recording starts with the next call',
  ]);

  // …and with calls in the ledger: the totals and the by-type plate.
  const now = new Date();
  const u = (inputTokens) => ({ inputTokens, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 });
  spendStore.recordModelCall(db, { callType: 'chat', model: 'claude-sonnet-5', usage: u(1000), usd: 0.42 }, now);
  spendStore.recordModelCall(db, { callType: 'meal_estimate', model: 'claude-sonnet-5', usage: u(500), usd: 0.03 }, now);
  spendStore.recordModelCall(db, { callType: 'chat', model: 'mystery', usage: u(10), usd: null }, now);
  const full = render('coach usage (spent)', SettingsCoachUsageScreen);
  expect('coach usage (spent)', full, [
    '$0.45',
    '3 calls',
    'Coach chat',
    'Meal estimates',
    '$0.42',
    '$0.03',
    'Recorded since',
    'ran on a model with no price in the table',
  ]);
  if (full !== null) {
    full.indexOf('Coach chat') < full.indexOf('Meal estimates')
      ? ok('coach usage: by type, most expensive first')
      : bad('coach usage order');
  }

  // Settings › Coach: the new models in the picker, and the row into Coach usage.
  const coach = render('settings-coach (models + usage row)', SettingsCoachScreen);
  expect('settings-coach (models + usage row)', coach, [
    'Sonnet 5.5',
    'Opus 5.5',
    'Haiku 5.5',
    'no web search',
    'Coach usage',
    'Today $0.45',
    'this month $0.45',
  ]);
  refute('settings-coach (models + usage row)', coach, ['Sonnet is the cheaper of the two']);

  // A PARKED queued estimate: the Eat tab says it is paused, and its meal
  // screen says why, plainly, with the two ways out.
  const { mealId: parkedId } = queueNewMealEstimate(
    db,
    { date: today, time: '22:40', name: placeholderMealName('a late kebab') },
    { kind: 'text', description: 'a late kebab' }
  );
  const parkedRow = pendingEstimateForMeal(db, parkedId);
  markPendingEstimateFailed(
    db,
    parkedRow.id,
    composeLastError('unreadable', 'MealEstimateParseError: not JSON'),
    'park'
  );
  const tab = render('nutrition hub (estimate paused)', NutritionScreen);
  expect('nutrition hub (estimate paused)', tab, [
    'a late kebab',
    'Estimate paused — tap to retry or enter it',
  ]);
  const parked = render('meal-detail (estimate parked)', MealDetailScreen, { id: parkedId });
  expect('meal-detail (estimate parked)', parked, [
    'Queued estimate',
    'its answer could not be read as an estimate',
    'is not sent again by itself',
    'a late kebab',
    'Try again',
    'Enter by hand',
  ]);
  refute('meal-detail (estimate parked)', parked, ['MealEstimateParseError', 'not JSON']);

  // A request still waiting offers Enter by hand only — it will send itself.
  const { mealId: waitingId } = queueNewMealEstimate(
    db,
    { date: today, time: '22:50', name: placeholderMealName('a second kebab') },
    { kind: 'text', description: 'a second kebab' }
  );
  const waiting = render('meal-detail (estimate waiting)', MealDetailScreen, { id: waitingId });
  expect('meal-detail (estimate waiting)', waiting, [
    'Queued estimate',
    'Waiting for a connection.',
    'Enter by hand',
  ]);
  refute('meal-detail (estimate waiting)', waiting, ['Try again']);
}

/**
 * 45. Smart day (0067) — the Coach's plan at the top of Home.
 *
 * Without a plan Home must be EXACTLY what it was: the render with no plan and
 * the render after a plan is cleared are compared as whole strings. With one,
 * the hero is the Coach's first item (marked as the Coach's, uncounted), the
 * checklist carries it as a row with no checkbox, and the tally does not move.
 * A pinned row keeps Done / Snooze / Skip and takes the Coach's reason.
 */
console.log('\n45. Smart day — the Coach’s plan at the top of Home, and its uncounted rows');
{
  const dp = await import('../src/lib/db/repositories/day-plan.ts');
  const { logicalDayUtcRange } = await import('../src/lib/db/date.ts');
  const { listMission } = await import('../src/lib/db/repositories/mission.ts');
  const { CoachItemHero } = await import('../src/components/home/hero-card.tsx');
  const today = todayISODate();
  const until = logicalDayUtcRange(today).endUtc;
  dp.applyDayPlan(db, { decision: 'clear', items: [], refused: [] });

  createProtocolWithVersion(
    db,
    { name: 'Smart day check', type: 'daily_routine', startedOn: today },
    {
      schema: 2,
      phases: [
        {
          id: 'sd',
          title: null,
          duration_days: null,
          items: [
            {
              id: 'sdpin',
              title: 'Smart-day pinned row',
              scheduled_time: '23:58',
              dose: null,
              notes: null,
              cadence: { kind: 'daily' },
            },
          ],
        },
      ],
    }
  );
  rederiveMissionForDay(db, today);
  const pinRow = listMission(db, today).find((row) => row.title === 'Smart-day pinned row');
  const tally = (html) => /Today’s Mission[\s\S]*?(\d+ of \d+)/.exec(html ?? '')?.[1] ?? null;

  const noPlan = render('home (no plan)', HomeScreen);
  refute('home (no plan)', noPlan, ['Coach · Do this next', 'Not counted', 'Coach · not counted', 'The Coach:']);
  const tallyBefore = tally(noPlan);

  dp.applyDayPlan(db, {
    decision: 'replace',
    refused: [],
    items: [
      {
        key: 'do:log_weight',
        rank: 1,
        kind: 'do',
        action: 'log_weight',
        title: 'Weigh in (smart day)',
        reason: 'Nine days since the last weigh-in.',
        until,
        untilGiven: false,
      },
      {
        key: `pin:${pinRow.id}`,
        rank: 2,
        kind: 'pin',
        entryId: pinRow.id,
        title: pinRow.title,
        reason: 'Your evening is short tonight.',
        until,
        untilGiven: false,
      },
    ],
  });
  const withPlan = render('home (a Coach item on top)', HomeScreen);
  expect('home (a Coach item on top)', withPlan, [
    'Coach · Do this next',
    'Weigh in (smart day)',
    'Not counted',
    'The Coach: Nine days since the last weigh-in.',
    '>Log weight<',
    '>Dismiss<',
    'Coach · not counted',
    'aria-label="Weigh in (smart day), Coach item, not counted, Log weight"',
    'Dismiss Weigh in (smart day)',
  ]);
  withPlan !== null && withPlan.indexOf('Coach · Do this next') < withPlan.indexOf('Today’s Mission')
    ? ok('the Coach item is the hero, above the checklist')
    : bad('hero placement');
  tally(withPlan) === tallyBefore
    ? ok(`the tally does not move: "${tallyBefore}" with and without the Coach item`)
    : bad('tally moved', `${tallyBefore} → ${tally(withPlan)}`);
  /role="checkbox"[^>]*aria-label="Weigh in \(smart day\)/.test(withPlan ?? '')
    ? bad('the Coach row is drawn as a checkbox')
    : ok('the Coach row is a door (role button), never a checkbox');

  // Dismissed: the pinned row takes the hero, with Done / Snooze / Skip and the Coach's reason.
  const read = dp.readDayPlan(db, new Date());
  dp.recordPlanEvent(db, read.plan, read.items[0], 'dismissed');
  const pinned = render('home (a pinned row on top)', HomeScreen);
  expect('home (a pinned row on top)', pinned, [
    'Do this next · Coach',
    'The Coach: Your evening is short tonight.',
    'Mark Smart-day pinned row done',
    'Snooze Smart-day pinned row',
    'Skip Smart-day pinned row',
  ]);
  refute('home (a pinned row on top)', pinned, ['Coach · Do this next', 'Not counted', 'Weigh in (smart day)']);

  // Cleared: byte-identical to the render with no plan at all.
  dp.applyDayPlan(db, { decision: 'clear', items: [], refused: [] });
  const cleared = render('home (plan cleared)', HomeScreen);
  cleared !== null && cleared === noPlan
    ? ok('with the plan cleared, Home renders byte-identical to Home with no plan')
    : bad('the cleared render differs from the no-plan render');

  // The hero on its own: the named UNTIL is a measured figure.
  const hero = render('coach item hero (until)', CoachItemHero, {}, {
    item: { key: 'do:log_meal', title: 'Eat lunch', reason: null, action: 'log_meal', button: 'Log a meal', until: '14:00' },
    onOpen: () => {},
    onDismiss: () => {},
  });
  expect('coach item hero (until)', hero, ['until 14:00', '>Log a meal<', 'Eat lunch']);
  refute('coach item hero (no reason)', hero, ['The Coach:']);

  // What only a running app exercises — listeners and timers — pinned in source
  // (the pure halves are db/smart-day.test.mjs §3b).
  const planHook = readFileSync(new URL('../src/hooks/use-day-plan.ts', import.meta.url), 'utf8');
  /subscribeHealthSync\(bump\)/.test(planHook) &&
  /subscribeGarminSync\(bump\)/.test(planHook) &&
  /unsubscribeHealth\(\);/.test(planHook) &&
  /unsubscribeGarmin\(\);/.test(planHook)
    ? ok('useDayPlan re-reads when an Apple Health or Garmin sync lands, and unsubscribes')
    : bad('useDayPlan does not listen to the Health / Garmin syncs');
  /msUntilNextExpiry\(read\.items, new Date\(\)\)/.test(planHook) &&
  /setTimeout\(bump, delay\)/.test(planHook) &&
  /return \(\) => clearTimeout\(timer\)/.test(planHook)
    ? ok('useDayPlan sets one timer to the earliest live UNTIL, cleared on change and unmount')
    : bad('useDayPlan has no UNTIL timer');
  /shownKeys\(read\.items, top,/.test(planHook) && !/onScreen\.add\(topKey\)/.test(planHook)
    ? ok('useDayPlan records shown through shownKeys — live pins whose row is drawn included')
    : bad('useDayPlan still records shown only for Coach rows and the hero');
  /toCoachItemView\(item, read\.liveOpen\)/.test(planHook) &&
  /toCoachItemView\(top\.item, read\.liveOpen\)/.test(planHook)
    ? ok('a Coach item’s button knows whether a live session is open (Start → Resume)')
    : bad('the Coach item views are built without the live session');
  const proposalsHook = readFileSync(
    new URL('../src/hooks/use-coach-proposals.ts', import.meta.url),
    'utf8'
  );
  /AppState\.addEventListener\('change', \(state\) => \{\s*if \(state === 'active'\) setTick\(\(n\) => n \+ 1\);/.test(
    proposalsHook
  ) && /return \(\) => subscription\.remove\(\)/.test(proposalsHook)
    ? ok('useCoachProposals re-reads on return to the foreground — yesterday’s brief does not outlive its day')
    : bad('useCoachProposals does not re-read on foreground');
}

console.log('\n46. Item 87 — Progressing / Holding / Stalled replaces the PR stamp and the hub’s %');
{
  // The zig-zag from docs/spikes/pr-vs-overload.md, in pounds: 135 × 7 · 7 · 6
  // · 7. Romanian Deadlift is used by no other section, so its history is
  // exactly this. The latest session is today, so the hub lists it first.
  clearWorkoutDraft(db, 'live');
  const today = todayISODate();
  const rdl = (reps, lb, rpe) => ({
    exercise: 'Romanian Deadlift',
    exerciseId: 'romanian-deadlift',
    reps,
    weightKg: lbToKg(lb),
    rpe,
  });
  const logged = (back, sets) => {
    const date = shiftISODate(today, -back);
    const id = logWorkout(db, { date, kind: 'strength' }, sets);
    const at = back === 0 ? new Date().toISOString() : `${date}T12:00:00.000Z`;
    db.run('UPDATE workouts SET created_at = ? WHERE id = ?', [at, id]);
    return id;
  };
  const ids = [
    logged(9, [rdl(7, 135, 9), rdl(6, 135, 9)]),
    logged(6, [rdl(7, 135, 9.5)]),
    logged(3, [rdl(6, 135, 9)]),
    logged(0, [rdl(7, 135, 9.5), rdl(6, 135, 9.5)]),
  ];

  // THE HUB ROW: the mark where the % token stood; VoiceOver hears the mark,
  // then the direction it still knows.
  const hub = render('exercise hub (overload mark)', ExerciseScreen);
  expect('exercise hub (overload mark)', hub, [
    'Romanian Deadlift',
    '>Stalled<',
    'Stalled. level with the previous 3 sessions. Open records and history.',
  ]);
  refute('exercise hub (overload mark)', hub, ['>level<']);
  readFileSync(new URL('../app/exercise.tsx', import.meta.url), 'utf8').includes('trendToken')
    ? bad('the hub still draws the % token')
    : ok('the hub no longer draws the % token at all');

  // EXERCISE DETAIL: one line heads the Trend — the mark, why, and the
  // engine's own next step on real plates (135 × 0.9 = 121.5, down to 120).
  const stalled = render('exercise detail (stalled)', ExerciseDetailScreen, {
    id: 'romanian-deadlift',
  });
  expect('exercise detail (stalled)', stalled, [
    'aria-label="Stalled. no new best in 3 sessions · next: 120 lb × 6"',
    '>Stalled<',
    '3 sessions',
    '120 lb × 6',
  ]);
  stalled.indexOf('no new best in') > stalled.indexOf('>Trend<') &&
  stalled.indexOf('no new best in') < stalled.indexOf('>Latest<')
    ? ok('detail: the line heads the Trend, above its figure and chart')
    : bad('detail: line placement');
  refute('exercise detail (stalled)', stalled, ['>Advanced<', '>PR<']);

  // A load jump that holds the range: an advance on each of the three before
  // it, though its e1RM is lower than the best. History marks it ADVANCED.
  ids.push(logged(0, [rdl(6, 140, 8)]));
  db.run('UPDATE workouts SET created_at = ? WHERE id = ?', [
    new Date(Date.now() + 60_000).toISOString(),
    ids[4],
  ]);
  const moving = render('exercise detail (progressing)', ExerciseDetailScreen, {
    id: 'romanian-deadlift',
  });
  expect('exercise detail (progressing)', moving, [
    '>Progressing<',
    'aria-label="Progressing. last session +5 lb for 6 reps · next: 140 lb × 7"',
    '>Advanced<',
  ]);
  (moving.match(/>Advanced</g) ?? []).length === 1
    ? ok('History: the one session that advanced says ADVANCED, and no row says PR')
    : bad('history advanced count', String((moving.match(/>Advanced</g) ?? []).length));
  refute('exercise detail (progressing)', moving, ['>PR<']);
  deleteWorkout(db, ids.pop());

  // THE LIVE LOGGER: today's best set so far would be a new best on each of
  // the last three — one block line, "Advanced · +5 lb for 7 reps".
  const draftWith = (sets, over = {}) =>
    saveWorkoutDraft(db, 'live', {
      version: DRAFT_VERSION,
      startedAt: Date.now() - 20 * 60_000,
      routineId: null,
      ingestId: null,
      restEndsAt: null,
      away: false,
      blocks: [
        {
          key: 1,
          exerciseId: 'romanian-deadlift',
          name: 'Romanian Deadlift',
          loggingType: 'weight_reps',
          measures: 'reps,load',
          mechanic: 'compound',
          restSec: 120,
          prev: [],
          bestE1rm: null,
          linkedToNext: false,
          sets: sets.map(([weight, reps, rpe, done], i) => ({
            key: i + 1,
            weight,
            reps,
            rpe,
            time: '',
            distance: '',
            setType: 'normal',
            done,
          })),
        },
      ],
      ...over,
    });
  draftWith([
    ['135', '7', '9', true],
    ['140', '7', '8', true],
    ['140', '', '', false],
  ]);
  const advanced = render('workout-live (advanced)', WorkoutLiveScreen, { resume: '1' });
  expect('workout-live (advanced)', advanced, [
    '>Advanced<',
    'aria-label="Advanced: +5 lb for 7 reps on last time"',
  ]);
  refute('workout-live (advanced)', advanced, ['>PR<']);

  // Not yet: 135 × 7 again is a rebound, not a new best.
  draftWith([['135', '7', '9.5', true]]);
  refute(
    'workout-live (rebound)',
    render('workout-live (rebound)', WorkoutLiveScreen, { resume: '1' }),
    ['>Advanced<', 'aria-label="Advanced:']
  );
  // Away: the same advancing set, no line (0055).
  draftWith([['140', '7', '8', true]], { away: true });
  refute(
    'workout-live (advanced, away)',
    render('workout-live (advanced, away)', WorkoutLiveScreen, { resume: '1' }),
    ['>Advanced<']
  );
  clearWorkoutDraft(db, 'live');
  // The editor: a stored session draws no line, whatever it holds.
  refute(
    'workout-live (editor, overload)',
    render('workout-live (editor, overload)', WorkoutLiveScreen, { workoutId: ids[3] }),
    ['>Advanced<']
  );

  // Ink only (Conformed Set): neither line uses the accent or a signal colour.
  const liveSrc = readFileSync(new URL('../app/workout-live.tsx', import.meta.url), 'utf8');
  const detailSrc = readFileSync(new URL('../app/exercise-detail.tsx', import.meta.url), 'utf8');
  // The classes of the JSX that draws each: the logger's footer line, the
  // detail's heading line, the hub's mark.
  const hubSrc = readFileSync(new URL('../app/exercise.tsx', import.meta.url), 'utf8');
  const between = (src, from, to) => {
    const a = src.indexOf(from);
    const b = src.indexOf(to, a);
    return a < 0 || b < 0 ? null : src.slice(a, b);
  };
  const drawn = [
    between(liveSrc, '{advance ? (', 'accessibilityLabel={`Add a set to'),
    between(detailSrc, '{overload ? (', ') : null}'),
    between(hubSrc, '{x.overload ? (', ') : null}'),
  ];
  const classes = drawn.flatMap((src) => [...(src ?? '').matchAll(/className="([^"]*)"/g)].map((m) => m[1]));
  drawn.every((src) => src != null) &&
  classes.length >= 4 &&
  classes.every((c) => !/accent|signal|pine|stamp/.test(c)) &&
  classes.some((c) => /text-ink/.test(c))
    ? ok('the mark and the Advanced line are ink: no accent, no signal colour, in all three places')
    : bad('mark colour', JSON.stringify(classes));
  for (const id of ids) deleteWorkout(db, id);
}

// -------------------------------------------------------------------------
console.log('\n47. 2026-10-21 — Settings › Garmin, its row, the HRV cell, the Garmin plate');
{
  // The Garmin Personal API link (docs/wearables-subapp.md §26). The key store
  // is memory-only under node (no expo-secure-store), which the screen says.
  // A made-up test key — never a real credential.
  const TEST_KEY = 'gpk_RENDER_TEST_ONLY_0000';
  garminKeyStore.clearKey();
  deleteSyncStateValue(db, GARMIN_SYNC_KEY);

  const off = render('settings-garmin (no key)', SettingsGarminScreen);
  expect('settings-garmin (no key)', off, [
    'Not connected',
    'Personal API key',
    'Save key',
    'connect.garmin.com',
    'personalApiToken',
    '30, 90 or 180 days, or a year',
    'Garmin shows it once',
    'must not be shared',
    'What syncs',
    'Body Battery',
    'Training Readiness, Training Status or skin temperature',
    'never in ARC&rsquo;s database'.replace('&rsquo;', '’'),
    'personal.connectapi.garmin.com',
  ]);
  refute('settings-garmin (no key)', off, ['Sync now', 'Disconnect', 'Replace key']);

  garminKeyStore.setKey(TEST_KEY);
  const fresh = render('settings-garmin (key, not synced)', SettingsGarminScreen);
  expect('settings-garmin (key, not synced)', fresh, [
    'Connected',
    'Not synced yet',
    'Garmin emails you before the key expires.',
    'Key held for this session only',
    'Sync now',
    'Disconnect',
    'Replace key',
  ]);
  refute('settings-garmin (key, not synced)', fresh, [TEST_KEY]);

  const at = new Date(2026, 9, 21, 7, 12).toISOString();
  setSyncStateValue(db, GARMIN_SYNC_KEY, {
    lastSyncedAt: at,
    lastAttemptAt: at,
    status: 'ok',
    keyExpiresAt: '2027-01-19T12:00:00.000Z',
    backfill: {},
    skipped: [],
  });
  const synced = render('settings-garmin (synced, expiry known)', SettingsGarminScreen);
  expect('settings-garmin (synced, expiry known)', synced, [
    `Last synced Oct 21 · ${clockFromISO(at)}`,
    'Key expires Jan 19, 2027.',
  ]);
  refute('settings-garmin (synced, expiry known)', synced, ['Garmin emails you']);

  setSyncStateValue(db, GARMIN_SYNC_KEY, { status: 'rejected', rejectedAt: at, backfill: {} });
  const refused = render('settings-garmin (key refused)', SettingsGarminScreen);
  expect('settings-garmin (key refused)', refused, [
    'Key refused',
    'Garmin refused the key',
    'Create a new one and paste it below.',
  ]);
  refute('settings-garmin (key refused)', refused, ['Garmin emails you', 'Key expires']);

  // app/settings.tsx is not rendered here (its backup import chain does not
  // resolve under node), so its row is checked as source, as §17b checks the
  // strip's accent.
  const settingsSrc = readFileSync(new URL('../app/settings.tsx', import.meta.url), 'utf8');
  settingsSrc.includes('label="Garmin"') &&
  settingsSrc.includes("router.push('/settings-garmin')") &&
  settingsSrc.includes("'Key expired or revoked'")
    ? ok('Settings has a Garmin row beside Apple Health, and it names a refused key')
    : bad('the Settings › Garmin row');
  const ledgerRefused = render('wearables (Garmin key refused)', WearablesScreen);
  expect('wearables (Garmin key refused)', ledgerRefused, [
    'Garmin key expired or revoked · Settings › Garmin',
    '>Garmin<',
    'Sleep score',
    'Body Battery at wake',
    'Stress (day average)',
    'Lowest blood oxygen',
  ]);

  // The HRV cell, drawn with the facts passed in.
  const facts = (garmin) => ({
    link: 'unsupported',
    available: false,
    running: false,
    lastSyncedAt: null,
    failedAt: null,
    log: null,
    sources: [],
    today: todayISODate(),
    garmin,
  });
  const strip = [
    { id: 'hrv', label: 'HRV', value: '—', detail: 'No data yet', level: 'unknown' },
    { id: 'rhr', label: 'Resting HR', value: '—', detail: 'No data yet', level: 'unknown' },
  ];
  const cellOf = (name, garmin) =>
    render(name, MetricsGrid, {}, {
      metrics: strip,
      context: facts(garmin),
      onSync: () => {},
      onOpenSettings: () => {},
      onSyncGarmin: () => {},
      onOpenGarminSettings: () => {},
    });
  const cellRefused = cellOf('metrics (Garmin key refused)', { link: 'rejected', running: false, lastSyncedAt: null });
  expect('metrics (Garmin key refused)', cellRefused, ['New key', 'Garmin key expired or revoked']);
  refute('metrics (Garmin key refused)', cellRefused, ['Sync Garmin', 'Sync Apple Health']);
  const cellOffer = cellOf('metrics (Garmin connected)', { link: 'connected', running: false, lastSyncedAt: null });
  expect('metrics (Garmin connected)', cellOffer, ['Sync Garmin', 'never synced']);
  const cellBusy = cellOf('metrics (Garmin syncing)', { link: 'connected', running: true, lastSyncedAt: null });
  expect('metrics (Garmin syncing)', cellBusy, ['Syncing', 'reading Garmin', 'aria-disabled="true"']);
  const cellOff = cellOf('metrics (no Garmin link)', { link: 'off', running: false, lastSyncedAt: null });
  refute('metrics (no Garmin link)', cellOff, ['Garmin']);

  // Leave the suite as it found it.
  garminKeyStore.clearKey();
  deleteSyncStateValue(db, GARMIN_SYNC_KEY);
  const ledgerOff = render('wearables (no Garmin link)', WearablesScreen);
  refute('wearables (no Garmin link)', ledgerOff, ['Body Battery at wake', 'Garmin key expired']);
}

console.log('\n48. The weekly review (2026-10-21) — Home’s “Your week”, and the report it filed');
{
  const W = await import('../src/lib/ai/weekly-review.ts');
  const P = await import('../src/lib/ai/proposals.ts');
  const { parsePassLines } = await import('../src/lib/ai/proposal-lines.ts');
  const { CoachNote } = await import('../src/components/home/coach-note.tsx');
  const { COACH_READ_ATTRIBUTION } = await import('../src/lib/reports/coach-read.ts');
  const noop = () => {};
  const now = new Date();
  const today = todayISODate(now);

  // A review as weekly-runner.ts files it: the report with its read, the
  // decisions on the weekly allowance, the week stamped with its filing.
  const period = W.reviewWeekFor(now);
  const data = assembleSelfReview(db, period, { now });
  const readLines = ['Training held all week.', 'Dinners were the gap, not breakfasts.'];
  const reportId = insertReport(db, {
    data,
    read: { text: readLines.join('\n'), attribution: COACH_READ_ATTRIBUTION, model: null },
    fileName: 'arc-report-self-review-weekly.html',
    filePath: 'reports/arc-report-self-review-weekly.html',
  });
  const parsed = parsePassLines(
    'PROPOSE set_reminder {"title":"Plan dinners","time":"17:30"} Dinners went unlogged four nights.'
  );
  const { drafted } = P.draftProposals(db, parsed.proposals, parsed.malformed, now);
  const [decision] = P.recordProposals(db, drafted, [], now, {
    weekly: { week: period.start, through: shiftISODate(today, 1), allowance: W.WEEKLY_DECISIONS },
  });
  W.setWeeklyState(db, {
    lastWeek: period.start,
    latest: { weekStart: period.start, weekEnd: period.end, day: today, reportId, at: now.toISOString() },
  });
  const shownSummary = decision.summary.replace(/"/g, '&quot;');

  const home = render('home (your week)', HomeScreen);
  expect('home (your week)', home, [
    'Coach · your week',
    'Your week',
    period.rangeLabel,
    'Training held all week.',
    'Dinners were the gap, not breakfasts.',
    'Decisions for the week ahead',
    shownSummary,
    'Dinners went unlogged four nights.',
    `aria-label="Approve: ${shownSummary}"`,
    'Open the report',
    `aria-label="Open the weekly review, ${period.rangeLabel}"`,
  ]);
  // The decision is drawn once, under the week — not again as a daily draft.
  refute('home (your week)', home, ['For your approval', 'PROPOSE']);
  (home?.split(`aria-label="Approve: ${shownSummary}"`).length ?? 0) === 2
    ? ok('home (your week): the decision is drawn exactly once')
    : bad('home (your week): decision count');

  // The report it opens, from Home and from Data › Reports.
  const view = render('report-view (weekly review)', ReportViewScreen, { id: reportId });
  expect('report-view (weekly review)', view, [
    'Weekly review',
    period.rangeLabel,
    'Training held all week.',
    'written by the model over the numbers above',
    'Share again',
  ]);
  expect('reports (weekly filed)', render('reports (weekly filed)', ReportsScreen), [
    'Self-review',
    `${period.rangeLabel} · generated`,
  ]);

  // The card with the week alone and no read: says so, keeps the door.
  const bare = render('coach card (week, no read)', CoachNote, {}, {
    message: null,
    onDismiss: noop,
    week: { reportId: 'r', rangeLabel: '12 – 18 Oct 2026', read: null, drafts: [] },
    onApprove: noop,
    onDecline: noop,
  });
  expect('coach card (week, no read)', bare, [
    'Coach · your week',
    '12 – 18 Oct 2026',
    'The Coach read the week and had nothing to add to the numbers.',
    'Open the report',
  ]);
  refute('coach card (week, no read)', bare, ['Decisions for the week ahead', 'Dismiss the Coach', 'pine-on']);

  // The day after next: gone.
  const later = new Date(now.getTime() + 2 * 86_400_000);
  W.weeklyCardFor(db, P.listProposals(db, later), later) === null
    ? ok('your week: gone two days after it landed')
    : bad('your week lingered');

  db.run("UPDATE users SET preferences = json_remove(preferences, '$.coachProposals', '$.coachWeekly')");
  db.run('DELETE FROM reports WHERE id = ?', [reportId]);
  refute('home (week cleared)', render('home (week cleared)', HomeScreen), ['Your week']);
}

console.log('\n49. Simple logs save at once (owner, 2026-10-21) — the receipt with Undo, and its switch');
{
  const { SavedAtOnceLine } = await import('../src/components/coach/saved-at-once-line.tsx');
  const { setSaveLogsAtOnce } = await import(
    '../src/lib/db/repositories/coach-autosave-setting.ts'
  );
  const line = 'Log supplement: Creatine · 5 g';
  const undos = [];
  const onUndo = (key) => undos.push(key);

  // OPEN: the receipt line in mono ink, and an Undo button that names it.
  const open = render('saved-at-once (open)', SavedAtOnceLine, {}, {
    line,
    saved: { key: 'captures abc', state: 'open' },
    onUndo,
  });
  expect('saved-at-once (open)', open, [line, '>Undo<', `aria-label="Undo: ${line}"`]);
  refute('saved-at-once (open)', open, ['Undone', 'Not undone', 'pine', 'accent', 'signal-']);

  // UNDONE: struck through, said in words, no button left to press.
  const undone = render('saved-at-once (undone)', SavedAtOnceLine, {}, {
    line,
    saved: { key: 'captures abc', state: 'undone' },
    onUndo,
  });
  expect('saved-at-once (undone)', undone, [line, 'Undone', 'line-through']);
  refute('saved-at-once (undone)', undone, ['>Undo<']);

  // REFUSED: the line stays, and why it was not removed.
  const refused = render('saved-at-once (refused)', SavedAtOnceLine, {}, {
    line,
    saved: {
      key: 'captures abc',
      state: 'refused',
      note: 'It changed after it was saved, so it was not removed. Change or remove it on its own screen.',
    },
    onUndo,
  });
  expect('saved-at-once (refused)', refused, [
    line,
    'Not undone. It changed after it was saved, so it was not removed.',
  ]);
  refute('saved-at-once (refused)', refused, ['>Undo<']);

  // CLOSED: a session since; the receipt alone.
  const closed = render('saved-at-once (closed)', SavedAtOnceLine, {}, {
    line,
    saved: { key: null, state: 'closed' },
    onUndo,
  });
  expect('saved-at-once (closed)', closed, [line]);
  refute('saved-at-once (closed)', closed, ['>Undo<', 'Undone', 'Not undone']);
  undos.length === 0 ? ok('rendering never presses Undo') : bad('undo fired on render');

  // WIRING, as source (MessageBubble imports the chat hook, whose model client
  // a server render cannot load): the bubble draws this line beside each
  // receipt that saved at once, and the thread hands it the hook's undo.
  const bubbleSrc = readFileSync(
    new URL('../src/components/coach/message-bubble.tsx', import.meta.url),
    'utf8'
  );
  const coachTabSrc = readFileSync(new URL('../app/(tabs)/coach.tsx', import.meta.url), 'utf8');
  bubbleSrc.includes('const saved = undos[index] ?? null;') &&
  bubbleSrc.includes('<SavedAtOnceLine') &&
  coachTabSrc.includes('onUndo={chat.undo}')
    ? ok('the receipt under the bubble carries the Undo, wired to the chat hook')
    : bad('saved-at-once wiring');

  // The switch in Settings › Coach: ON on a fresh install, OFF when stored off.
  const settings = render('settings-coach (save at once)', SettingsCoachScreen);
  expect('settings-coach (save at once)', settings, [
    'Save simple logs at once',
    'A weight, a supplement, a note you tell the Coach · Undo under the reply',
    'aria-label="Save simple logs at once"',
    'always waits',
  ]);
  const onSwitch =
    settings?.match(/<input[^>]*aria-label="Save simple logs at once"[^>]*>/)?.[0] ?? '';
  /\schecked(=|\s|>)/.test(onSwitch)
    ? ok('settings-coach: Save simple logs at once is ON by default (the owner’s answer)')
    : bad('settings-coach: save-at-once switch not on by default', onSwitch);
  setSaveLogsAtOnce(db, false);
  const offSettings = render('settings-coach (save at once off)', SettingsCoachScreen);
  const offSwitch =
    offSettings?.match(/<input[^>]*aria-label="Save simple logs at once"[^>]*>/)?.[0] ?? '';
  offSwitch && !/\schecked(=|\s|>)/.test(offSwitch)
    ? ok('settings-coach: a stored OFF reads back as an OFF switch')
    : bad('settings-coach: stored OFF did not render off', offSwitch);
  setSaveLogsAtOnce(db, true);
}

console.log('\n50. The usage level (2026-10-21) — Lean / Standard / Generous above the spend, two model pickers');
{
  // No source installed (every section above ran this way): the screen says
  // the setting could not be read and that the Coach is on Lean — the floor.
  const unread = render('coach usage (no source)', SettingsCoachUsageScreen);
  expect('coach usage (no source)', unread, [
    'Usage level',
    'Lean',
    'Standard',
    'Generous',
    'could not be read, so the Coach is running Lean',
    'Spend',
  ]);
  if (unread !== null) {
    unread.indexOf('Usage level') < unread.indexOf('Spend')
      ? ok('coach usage: the level sits above the spend figures')
      : bad('usage level below the spend');
  }

  // The app's source, on this database: nothing stored → Generous, the default,
  // with today's $0.45 (section 44) against the $5 soft budget.
  const uninstall = usageStore.installUsagePolicy(getDb);
  await apiKeyStore.setModel(null);
  await apiKeyStore.setUtilityModel(null);
  const generous = render('coach usage (generous default)', SettingsCoachUsageScreen);
  expect('coach usage (generous default)', generous, [
    'Running Generous, the default.',
    'Today $0.45 of a $5.00 soft budget.',
    'Soft daily budget',
    'Past it, the rest of the day runs Lean',
    'Off',
    '$1.00',
    '$2.50',
    '$10.00',
    'Chat Opus 5.5, one-shot calls Sonnet 5.5, the daily pass Opus 5.5.',
    'always wins over the level',
  ]);

  // A budget below today's spend: the rest of the day runs Lean, and it says so.
  usageStore.saveDailyBudget(db, 'generous', 0.25);
  const tripped = render('coach usage (budget reached)', SettingsCoachUsageScreen);
  expect('coach usage (budget reached)', tripped, [
    'has reached the $0.25 soft budget, so the rest of today runs Lean. Generous again tomorrow.',
    'Chat Sonnet 5, one-shot calls Sonnet 5, the daily pass Haiku 4.5.',
  ]);

  // Lean, chosen: no budget row (Lean is the floor), today's models.
  usageStore.saveUsageLevel(db, 'lean');
  const lean = render('coach usage (lean)', SettingsCoachUsageScreen);
  expect('coach usage (lean)', lean, ['Running Lean, until you switch it.']);
  refute('coach usage (lean)', lean, ['Soft daily budget']);

  // Settings › Coach: two pickers, each opening on the level's default.
  usageStore.saveUsageLevel(db, 'generous');
  usageStore.saveDailyBudget(db, 'generous', null);
  const coach = render('settings-coach (two pickers)', SettingsCoachScreen);
  expect('settings-coach (two pickers)', coach, [
    'Chat model',
    'One-shot calls model',
    'Level default',
    'Opus 5.5 · Generous',
    'Sonnet 5.5 · Generous',
    'A pick here always wins over the usage level',
  ]);
  // An explicit pick names itself on the usage screen.
  await apiKeyStore.setModel('claude-sonnet-5-5');
  const picked = render('coach usage (a chat pick)', SettingsCoachUsageScreen);
  expect('coach usage (a chat pick)', picked, ['Chat Sonnet 5.5 (your pick)']);
  await apiKeyStore.setModel(null);

  uninstall();
  db.run("UPDATE users SET preferences = json_remove(preferences, '$.usagePolicy')");
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
