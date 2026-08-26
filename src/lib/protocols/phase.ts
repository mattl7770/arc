/**
 * Which phase of a protocol is live on a given day.
 *
 * The clock starts at `protocols.started_on` (migration 0043) and runs forward
 * in whole calendar days. Phase 1 owns days 0 … d₁−1, phase 2 owns the next d₂,
 * and so on; an open-ended last phase runs forever. Once the last BOUNDED phase
 * runs out the protocol has **ended** — it generates nothing, and the hub says
 * so rather than leaving it listed as active and silently inert.
 *
 * Pure, and pure calendar arithmetic — no instants, no `Intl`, nothing that
 * could read a different clock than the caller (see src/lib/protocols/cadence.ts
 * for why that matters here).
 */
import { addDays, daysBetween } from './cadence';
import type { ProtocolContent, ProtocolPhase } from './types';

export type PhaseWindow = {
  /** 0-based position in `content.phases`. */
  index: number;
  phase: ProtocolPhase;
  /** 0 on the phase's first day. What `every_n_days` counts from. */
  dayInPhase: number;
  /** Days in this phase, or null when it is open-ended. */
  length: number | null;
  /** The phase's own first day, as `YYYY-MM-DD`. */
  startsOn: string;
};

export type PhaseState =
  | { kind: 'running'; window: PhaseWindow; phaseCount: number }
  /** The clock is anchored in the future — nothing runs yet. */
  | { kind: 'not_started'; startsOn: string; phaseCount: number }
  /** Every bounded phase has run out. `endedOn` is the last day it applied. */
  | { kind: 'ended'; endedOn: string; phaseCount: number };

/**
 * The phase state of `content` on `date`, for a protocol anchored at
 * `startedOn`.
 *
 * A phase with a null duration is treated as TERMINAL even when phases follow
 * it. `validateContent` refuses to author that document, but a hand-edited
 * export or an older Coach write could hold one, and running forever is the
 * predictable reading — the alternative is silently skipping to a phase the
 * user was never told about.
 */
export function phaseOn(
  content: ProtocolContent,
  startedOn: string,
  date: string
): PhaseState {
  const phaseCount = content.phases.length;
  const elapsed = daysBetween(startedOn, date);
  if (Number.isNaN(elapsed)) return { kind: 'ended', endedOn: startedOn, phaseCount };
  if (elapsed < 0) return { kind: 'not_started', startsOn: startedOn, phaseCount };

  let offset = 0;
  for (let index = 0; index < content.phases.length; index++) {
    const phase = content.phases[index]!;
    if (phase.duration_days === null) {
      return {
        kind: 'running',
        phaseCount,
        window: {
          index,
          phase,
          dayInPhase: elapsed - offset,
          length: null,
          startsOn: addDays(startedOn, offset),
        },
      };
    }
    if (elapsed < offset + phase.duration_days) {
      return {
        kind: 'running',
        phaseCount,
        window: {
          index,
          phase,
          dayInPhase: elapsed - offset,
          length: phase.duration_days,
          startsOn: addDays(startedOn, offset),
        },
      };
    }
    offset += phase.duration_days;
  }
  // Past the last bounded phase: `offset` is now the protocol's whole length,
  // so its last active day was the one before.
  return { kind: 'ended', endedOn: addDays(startedOn, offset - 1), phaseCount };
}

/** Total days a protocol runs, or null when its last phase is open-ended. */
export function totalDays(content: ProtocolContent): number | null {
  let total = 0;
  for (const phase of content.phases) {
    if (phase.duration_days === null) return null;
    total += phase.duration_days;
  }
  return total;
}
