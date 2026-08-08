/**
 * Tool interfaces the Coach will need for features that DON'T EXIST YET.
 *
 * These define the contract now (name, schema, semantics — reviewed as part of
 * the capability spec in docs/ai-coach.md) but are NOT registered with the
 * model: a tool that always fails teaches the model not to call it, so the
 * honest move is to withhold them until their feature lands. Each execute
 * throws with the dependency named, and each entry in docs/ai-coach.md flags
 * what has to ship first — now down to two: Coach-visible mission item ids, and
 * an Expo Router navigation seam. (The Protocols editor, Modes, experiments and
 * expo-notifications dependencies have all landed; those tools are registered.)
 *
 * When a dependency lands: implement execute, move the tool into COACH_TOOLS
 * (src/lib/ai/tools/index.ts), and strike the flag from the spec.
 */
import type { CoachTool } from './types';

const unavailable = (feature: string): never => {
  throw new Error(`${feature} has not shipped yet — this tool is not available.`);
};

// update_protocol has shipped — it is a real write tool now (write-tools.ts),
// backed by the Protocols repository's versioning. It lived here as a stub
// until the Protocols feature landed.

// create_experiment / complete_experiment have shipped — real write tools now
// (write-tools.ts), backed by the experiments repository (0027). They lived here
// as a stub until the experiments table landed.

// set_mode has shipped — it is a real write tool now (write-tools.ts), backed
// by the day_modes repository (0026) and the mode registry. It lived here as a
// stub until Modes landed.

/** Complete a mission item by id. Needs: Home integration decision (item ids
 * must be surfaced to the Coach; today the mission is integrator-owned). */
export const completeMissionItemStub: CoachTool = {
  name: 'complete_mission_item',
  description: "Mark one of today's mission items completed or skipped on the user's behalf.",
  inputSchema: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      status: { type: 'string', enum: ['completed', 'skipped'] },
    },
    required: ['id', 'status'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: () => 'Update mission item',
  execute: () => unavailable('Mission write access'),
};

/** Navigate the user to a screen. Needs: a navigation seam (the tool executor
 * runs headless; navigation is a UI side effect the service must broker). */
export const navigateToStub: CoachTool = {
  name: 'navigate_to',
  description:
    'Open an app screen for the user (nutrition, exercise, labs, protocols, log) — ' +
    '"pull up my labs" ends here instead of in prose.',
  inputSchema: {
    type: 'object',
    properties: {
      screen: {
        type: 'string',
        enum: ['nutrition', 'exercise', 'labs', 'protocols', 'log', 'data'],
      },
    },
    required: ['screen'],
    additionalProperties: false,
  },
  readOnly: true,
  execute: () => unavailable('Coach navigation'),
};

/** Everything above, for the spec and future wiring — never sent to the model. */
export const STUB_TOOLS: CoachTool[] = [completeMissionItemStub, navigateToStub];
