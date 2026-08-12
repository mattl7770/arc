/**
 * The Coach tool registry — the single list of what the model can do in the
 * app today, plus the mapping to the wire format. docs/ai-coach.md is the
 * spec; this is the implementation. The tools still awaiting their feature
 * (mission write access, Coach navigation) live in ./stubs and are deliberately
 * NOT registered — everything else, Protocols/Modes/experiments/knowledge
 * search included, ships here as a real tool.
 *
 * It is also where the registry declares what it does NOT cover — see the
 * coverage manifest at the foot of this file, and the report that forced it.
 */
import type { WireTool } from '../model-client';
import { READ_TOOLS } from './read-tools';
import { WRITE_TOOLS } from './write-tools';
import type { CoachTool } from './types';

export type { CoachTool, CoachToolContext } from './types';
export { READ_TOOLS, UNREGISTERED_READ_TOOLS } from './read-tools';
export { WRITE_TOOLS } from './write-tools';
export { STUB_TOOLS } from './stubs';

/** Every tool the model is given, reads first (the order it should reach). */
export const COACH_TOOLS: CoachTool[] = [...READ_TOOLS, ...WRITE_TOOLS];

const BY_NAME = new Map(COACH_TOOLS.map((tool) => [tool.name, tool]));

export function toolByName(name: string): CoachTool | undefined {
  return BY_NAME.get(name);
}

/** The registry in Messages API `tools` shape. */
export function toWireTools(tools: CoachTool[] = COACH_TOOLS): WireTool[] {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.inputSchema,
  }));
}

// === The coverage manifest ===================================================
//
// WHY THIS EXISTS. On 2026-08-11 the owner asked the Coach what it thought of
// their nutrition goals and was told: *"I don't actually have a 'nutrition
// goals' setting to check against — nothing in your profile or protocols
// defines a kcal/protein/carb target. So there's nothing yet to judge today
// against."* Nutrition targets had shipped six migrations earlier, with an
// editor screen the owner uses. The tool gap is fixed now; the FAILURE MODE is
// not, and it was never specific to nutrition.
//
// The model could see 39 tool schemas and nothing else. From inside that view,
// "no tool reads X" and "ARC has no X" are indistinguishable — there is no
// observation that separates them — so the confident answer and the correct one
// look identical from where it stands. No amount of "be careful" fixes an
// epistemic hole: you cannot instruct a model to notice the absence of evidence
// it has no way to observe. The fix has to hand it the missing observation.
//
// So the registry publishes what it does NOT cover, alongside what it does, and
// the system prompt carries it (src/lib/ai/system-prompt.ts). Derived from this
// file rather than written in the prompt, for one reason: a hand-maintained list
// rots the first time someone adds a tool, and a rotted coverage claim is worse
// than none. `assertCoverageComplete` (exercised by db/coach-tools.test.mjs)
// fails the suite the moment a registered tool is not classified here, so the
// manifest cannot silently fall behind the registry it describes.
//
// It sits in the CACHED system block, so it is byte-identical every turn and
// bills at ~0.1x after the first request of the hour. That is the whole budget
// argument for putting it there rather than in a tool the model has to think to
// call — a coverage tool only gets called by a model that already suspects it is
// blind, which is precisely the state this failure begins from.

/** One domain of the app, and the registered tools that reach it. */
export type CoachDomain = {
  /** What the user would call it. This is the text the model reads. */
  label: string;
  /**
   * Tool names covering it. A tool may serve two domains (get_metric_series
   * reads body metrics AND wearables) — the manifest is a classification, not
   * a partition. Membership is what {@link assertCoverageComplete} checks.
   */
  tools: string[];
};

/** Everything a tool can reach. Writable domains are the ones with a write tool
 *  in them, derived below — never labelled by hand. */
// Labels are deliberately TERSE. They are prompt text billed on every request,
// and the model needs the domain vocabulary, not a definition of each domain —
// it is holding the schemas that define them.
export const COACH_DOMAINS: CoachDomain[] = [
  { label: "today's mission", tools: ['get_today_snapshot', 'adjust_today'] },
  {
    label: 'meals and nutrition targets',
    tools: ['get_nutrition_summary', 'log_meal', 'set_nutrition_targets'],
  },
  { label: 'body metrics and vitals', tools: ['get_metric_series', 'log_metric'] },
  { label: 'workouts', tools: ['get_training_summary', 'log_workout'] },
  { label: 'symptoms', tools: ['get_symptom_history', 'log_symptom'] },
  { label: 'supplements, medications, therapies', tools: ['log_capture'] },
  { label: 'day notes', tools: ['log_note'] },
  { label: 'protocols', tools: ['get_protocols', 'update_protocol'] },
  { label: 'day modes', tools: ['set_mode'] },
  {
    label: 'experiments',
    tools: ['get_experiments', 'create_experiment', 'complete_experiment', 'abandon_experiment'],
  },
  {
    label: 'reminders',
    tools: ['list_reminders', 'set_reminder', 'complete_reminder', 'dismiss_reminder'],
  },
  { label: 'the recipe book', tools: ['get_recipes', 'get_recipe', 'save_recipe', 'log_recipe'] },
  {
    label: 'the grocery list',
    tools: [
      'get_grocery_list',
      'add_grocery_items',
      'complete_grocery_items',
      'add_recipe_to_grocery_list',
    ],
  },
  { label: 'screenings', tools: ['get_screenings', 'log_screening_done'] },
  { label: 'durable memories', tools: ['get_memories', 'remember', 'forget'] },
  { label: 'labs and biomarkers', tools: ['get_biomarkers', 'get_biomarker_history'] },
  {
    label: 'Apple Health and readiness',
    tools: ['get_today_snapshot', 'get_metric_series'],
  },
  { label: 'the training engine', tools: ['get_training_recommendation'] },
  { label: 'insights and trends', tools: ['get_insights'] },
  { label: 'past conversations and the ARC reference', tools: ['search_history'] },
  { label: 'appointments', tools: ['get_screenings'] },
];

/**
 * Domains ARC ships that NO tool reaches, and where the user works with them.
 *
 * This is the half that cannot be derived, and the half that matters: it is the
 * list the model needs in order to say "I can't see that" instead of "you don't
 * have that". Each entry names the screen, so the answer is useful rather than
 * merely honest. Keep it to real, user-facing features — not internals.
 */
export const UNCOVERED_DOMAINS: string[] = [
  'the food catalog and per-item micronutrients (Eat)',
  'saved meal templates (Eat)',
  'saved workouts, routines and programs (Train)',
  'lab report files and the PDF import (Data, Labs)',
  'booking, moving or cancelling an appointment (Data, Screenings)',
  'creating a protocol or a screening from scratch',
  'editing or deleting anything already logged, including your own writes',
  'Settings: profile, units, Health sync, app lock, API key',
];

const WRITE_NAMES = new Set(WRITE_TOOLS.map((tool) => tool.name));

/**
 * The manifest as the model reads it. Byte-identical on every turn (the inputs
 * are module constants), so it stays inside the cached system prefix.
 *
 * Tool NAMES are deliberately not printed: the schemas are already on the wire,
 * and repeating 42 of them here would pay twice for the same information. The
 * model needs the domain vocabulary, not a second copy of its own toolbox.
 */
export function buildCoverageManifest(): string {
  const writable: string[] = [];
  const readOnly: string[] = [];
  for (const domain of COACH_DOMAINS) {
    (domain.tools.some((name) => WRITE_NAMES.has(name)) ? writable : readOnly).push(domain.label);
  }
  return (
    `What you can see, and what you cannot.\n` +
    `ARC holds more than your tools reach. A domain missing from your tools is one you are ` +
    `BLIND to, never proof the user lacks the feature. So never report a setting, a screen or ` +
    `a feature as absent because you have no tool for it. Say you cannot see it, name where ` +
    `it lives, and ask the user for the number.\n` +
    `Read and write: ${writable.join('; ')}.\n` +
    `Read only: ${readOnly.join('; ')}.\n` +
    `CANNOT see: ${UNCOVERED_DOMAINS.join('; ')}.`
  );
}

/**
 * Registry ↔ manifest agreement, as a list of human-readable problems (empty
 * when they agree). Called by db/coach-tools.test.mjs so that adding a tool
 * without classifying it — or classifying one that was never registered —
 * fails the suite rather than quietly producing a coverage claim that lies.
 */
export function coverageProblems(): string[] {
  const problems: string[] = [];
  const classified = new Set(COACH_DOMAINS.flatMap((d) => d.tools));
  for (const name of classified) {
    if (!BY_NAME.has(name)) problems.push(`COACH_DOMAINS names "${name}", which is not registered`);
  }
  for (const tool of COACH_TOOLS) {
    if (!classified.has(tool.name)) {
      problems.push(`"${tool.name}" is registered but belongs to no domain in COACH_DOMAINS`);
    }
  }
  return problems;
}
