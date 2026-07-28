/**
 * Tool interfaces the Coach will need for features that DON'T EXIST YET.
 *
 * These define the contract now (name, schema, semantics — reviewed as part of
 * the capability spec in docs/ai-coach.md) but are NOT registered with the
 * model: a tool that always fails teaches the model not to call it, so the
 * honest move is to withhold them until their feature lands. Each execute
 * throws with the dependency named, and each entry in docs/ai-coach.md flags
 * what has to ship first (Protocols editor, Modes, expo-notifications, Expo
 * Router navigation seam).
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

/** Design an n-of-1 experiment. Needs: experiments table (Coach Phase 2). */
export const createExperimentStub: CoachTool = {
  name: 'create_experiment',
  description:
    'Create an n-of-1 experiment: hypothesis, intervention, metrics to watch, duration, ' +
    'and success criteria. The Coach tracks it and reports the readout.',
  inputSchema: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      hypothesis: { type: 'string' },
      intervention: { type: 'string' },
      metrics: { type: 'array', items: { type: 'string' } },
      duration_days: { type: 'integer', minimum: 3 },
    },
    required: ['name', 'hypothesis', 'intervention', 'metrics', 'duration_days'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: () => 'Create experiment',
  execute: () => unavailable('Experiments'),
};

/** Set today's Mode. Needs: Modes (docs/information-architecture.md). */
export const setModeStub: CoachTool = {
  name: 'set_mode',
  description:
    "Set the day's mode (normal, travel, sick, deload, social, custom) so the plan, " +
    'priorities, tone, and adherence accounting adapt.',
  inputSchema: {
    type: 'object',
    properties: {
      mode: { type: 'string', enum: ['normal', 'travel', 'sick', 'deload', 'social', 'custom'] },
      until: { type: 'string', description: '"YYYY-MM-DD" end date; omit for just today.' },
    },
    required: ['mode'],
    additionalProperties: false,
  },
  readOnly: false,
  confirmSummary: () => 'Set mode',
  execute: () => unavailable('Modes'),
};

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
export const STUB_TOOLS: CoachTool[] = [
  createExperimentStub,
  setModeStub,
  completeMissionItemStub,
  navigateToStub,
];
