/**
 * The Coach tool registry — the single list of what the model can do in the
 * app today, plus the mapping to the wire format. docs/ai-coach.md is the
 * spec; this is the implementation. The tools still awaiting their feature
 * (mission write access, Coach navigation) live in ./stubs and are deliberately
 * NOT registered — everything else, Protocols/Modes/experiments/knowledge
 * search included, ships here as a real tool.
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
