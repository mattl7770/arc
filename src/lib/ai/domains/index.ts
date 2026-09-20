/**
 * The domain registry, assembled — the single list `query_records`,
 * `edit_record` and `delete_record` are built over (docs/coach-domains.md).
 *
 * Three ENUMS fall out of it, and each is deliberately a DIFFERENT subset:
 *
 *   · {@link QUERY_DOMAIN_KEYS} — domains with no bespoke read. A domain a
 *     registered tool already reads is absent, so the schema itself sends the
 *     model to `get_protocols` instead of leaving two paths to one answer and a
 *     rule in the prompt about which to prefer.
 *   · {@link EDIT_DOMAIN_KEYS} — domains that can be patched or created.
 *   · {@link REMOVABLE_DOMAIN_KEYS} — the smaller set a row may be removed
 *     from, so `delete_record`'s schema refuses the rest at zero round trips.
 *     Deletion must never be a VALUE the model can set in passing.
 */
import { READ_DOMAINS } from './read-domains';
import { STATUS_DOMAINS } from './status-domains';
import { WRITE_DOMAINS } from './write-domains';
import type { CoachDomainEntry } from './types';

export * from './types';
export { EXPERIMENT_ABANDON_NOTE, RECURRING_REMINDER_NOTE } from './status-domains';
export { idsWrittenInConversation } from './own-writes';

/** Every domain, in the order the enums print. */
export const COACH_DOMAIN_REGISTRY: CoachDomainEntry[] = [
  ...STATUS_DOMAINS,
  ...READ_DOMAINS,
  ...WRITE_DOMAINS,
];

const BY_KEY = new Map(COACH_DOMAIN_REGISTRY.map((entry) => [entry.key, entry]));

export function domainByKey(key: string): CoachDomainEntry | undefined {
  return BY_KEY.get(key);
}

/** Domains `query_records` will list — those with no bespoke read tool. */
export const QUERY_DOMAIN_KEYS: string[] = COACH_DOMAIN_REGISTRY.filter(
  (entry) => entry.read.kind !== 'bespoke'
).map((entry) => entry.key);

/** Domains `edit_record` will patch or create. */
export const EDIT_DOMAIN_KEYS: string[] = COACH_DOMAIN_REGISTRY.filter(
  (entry) => entry.edit !== undefined || entry.create !== undefined
).map((entry) => entry.key);

/** Domains `delete_record` will remove a row from. `refuse` is not removable. */
export const REMOVABLE_DOMAIN_KEYS: string[] = COACH_DOMAIN_REGISTRY.filter(
  (entry) => entry.remove !== undefined && entry.remove.mode !== 'refuse'
).map((entry) => entry.key);

/**
 * Every `UNCOVERED_DOMAINS` line the registry makes FALSE.
 *
 * A coverage line that has become false is the worst thing that list can hold
 * (src/lib/ai/tools/index.ts), and the registry is exactly the thing that keeps
 * making them false. db/coach-domains.test.mjs asserts every string here is
 * absent from `UNCOVERED_DOMAINS`, so the two cannot drift.
 */
export function retiredCoverageLines(): string[] {
  return COACH_DOMAIN_REGISTRY.flatMap((entry) => entry.retires ?? []);
}
