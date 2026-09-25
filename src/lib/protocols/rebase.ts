/**
 * Putting one form's changes onto a protocol that may have moved while the form
 * was open — the save rule of the one protocol editor (app/protocol-edit.tsx,
 * docs/spikes/protocol-menus-compact.md option A, the owner's choice of
 * 2026-09-25).
 *
 * ## The problem
 *
 * The editor is a whole-document form: it seeds once from the live version and
 * the protocol row, and Save writes a document. Between opening and saving, a
 * Coach `update_protocol` or `edit_record` can be approved on the Coach tab. A
 * save built from the opening-time document would silently put back everything
 * the Coach changed — the model's edit reverted by a dose tweak, with nothing on
 * either screen saying so. The per-item editor this form replaced avoided that
 * by re-reading the live version at save and writing its ONE item into it; a
 * whole-document form has no single item to write.
 *
 * ## The rule: a three-way merge that refuses a real conflict
 *
 * Three documents are in hand at save: **base** (what the form opened on),
 * **mine** (what the form now holds) and **live** (what is current). The form's
 * changes are `base → mine`; the other writer's are `base → live`. Each fact is
 * merged on its own, the way a version-control merge treats lines:
 *
 *   - a fact only one side changed takes that side's value;
 *   - a fact both sides changed to the SAME value takes it;
 *   - a fact both sides changed to DIFFERENT values is a conflict, and the whole
 *     save is refused with one sentence naming it. Nothing is written.
 *
 * The facts are the phase frame (each phase's id, name and length, in order),
 * each item's fields, each item's phase, and the order of the items inside each
 * phase. Items are matched by `id`, which is stable across versions: the Coach's
 * `update_protocol` inherits item ids by title and phase ids by position
 * (src/lib/ai/tools/write-tools.ts `parseProtocolContentInput`), and this form
 * keeps an item's id when it moves between phases.
 *
 * So the everyday case — a dose changed here while the Coach added an item
 * there, or reworded the same item's why-line — saves both, and nothing is
 * reverted. The cases that refuse are the ones where a guess would be needed:
 * both sides changed the same field of the same item differently, one removed
 * what the other edited, or both re-shaped or re-ordered the phases
 * differently. A refusal costs a redo on a fresh form; a guess would cost a
 * silent revert.
 *
 * ## Why not "refuse whenever the live version moved"
 *
 * That is exact too, and simpler. It was the plan's first answer, and the plan
 * named its price: this form is now where every dose change happens, so a Coach
 * edit approved in another tab would cost a refusal on the most frequent edit
 * in the app, where the per-item editor used to merge. The merge keeps that
 * behaviour for every change that does not touch the same fact twice.
 *
 * Pure, and pinned by db/protocols.test.mjs §12c.
 */
import type { CheckoffMode, ProtocolType } from '@/lib/db/types';

import { normalizeContent, validateContent } from './content';
import type { ProtocolContent, ProtocolItem, ProtocolPhase } from './types';

export type Rebased = { ok: true; content: ProtocolContent } | { ok: false; refusal: string };

/** Both sides went through `normalizeContent`, so a string compare is equality. */
function same(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

type Merge<T> = { ok: true; value: T } | { ok: false };

/** One fact, three ways: only-one-side-changed wins, agreement wins, else conflict. */
function merge3<T>(base: T, mine: T, live: T): Merge<T> {
  if (same(mine, base)) return { ok: true, value: live };
  if (same(live, base) || same(mine, live)) return { ok: true, value: mine };
  return { ok: false };
}

/**
 * One item, field by field: a dose changed here and a why-line reworded there
 * are two facts and both land. Null when one FIELD was changed differently on
 * the two sides. The result is re-normalised with the document, so a merge
 * that leaves a reminder on an item whose time was cleared elsewhere cannot
 * store it (`normalizeItem` forces it off).
 */
function mergeItem(
  base: ProtocolItem,
  mine: ProtocolItem,
  live: ProtocolItem
): ProtocolItem | null {
  const out = { ...base } as Record<string, unknown>;
  for (const key of Object.keys(base) as (keyof ProtocolItem)[]) {
    const field = merge3(base[key], mine[key], live[key]);
    if (!field.ok) return null;
    out[key] = field.value;
  }
  return out as ProtocolItem;
}

type Frame = Omit<ProtocolPhase, 'items'>;

function frameOf(content: ProtocolContent): Frame[] {
  return content.phases.map((phase) => ({
    id: phase.id,
    title: phase.title,
    duration_days: phase.duration_days,
  }));
}

type Placed = { item: ProtocolItem; phase: string };

function placements(content: ProtocolContent): Map<string, Placed> {
  const out = new Map<string, Placed>();
  for (const phase of content.phases) {
    for (const item of phase.items) out.set(item.id, { item, phase: phase.id });
  }
  return out;
}

function orderIn(content: ProtocolContent, phaseId: string): string[] {
  return content.phases.find((phase) => phase.id === phaseId)?.items.map((item) => item.id) ?? [];
}

/** `list` narrowed to the ids in `keep`, order preserved. */
function narrowed(list: string[], keep: Set<string>): string[] {
  return list.filter((id) => keep.has(id));
}

/** Did `next` change the relative order of the ids it shares with `base`? */
function reordered(base: string[], next: string[]): boolean {
  const shared = new Set(base.filter((id) => next.includes(id)));
  return !same(narrowed(base, shared), narrowed(next, shared));
}

const refuse = (refusal: string): Rebased => ({ ok: false, refusal });

/**
 * The live document with this form's changes applied — or the one sentence
 * that says why that cannot be done without a guess.
 *
 * Every input must already be canonical (`normalizeContent` /
 * `parseProtocolContent`); the output is canonical and has passed
 * `validateContent`.
 */
export function rebaseContent(
  base: ProtocolContent,
  mine: ProtocolContent,
  live: ProtocolContent
): Rebased {
  // The three cases that need no merge at all. The form left the document
  // alone (a settings-only save): the live one stands, unchecked, because this
  // save writes none of it. Nothing moved while the form was open — the
  // ordinary case — or both sides agree: the form's document is the answer.
  if (same(mine, base)) return { ok: true, content: live };
  if (same(live, base) || same(mine, live)) return settle(mine);

  // 1. The phase frame — ids, names and lengths, in order — is one fact. Two
  //    different re-shapings cannot be merged without deciding which phase is
  //    which.
  const frame = merge3(frameOf(base), frameOf(mine), frameOf(live));
  if (!frame.ok) return refuse('The phases were changed elsewhere while this form was open.');
  const phaseIds = new Set(frame.value.map((phase) => phase.id));

  // 2. Every item, on its own: its fields and its phase are separate facts, so
  //    a dose changed here and a phase move made there both land.
  const b = placements(base);
  const m = placements(mine);
  const l = placements(live);
  const ids = [...new Set([...l.keys(), ...m.keys(), ...b.keys()])];
  const merged = new Map<string, Placed>();
  for (const id of ids) {
    const was = b.get(id);
    const here = m.get(id);
    const there = l.get(id);
    const title = (here ?? there ?? was)!.item.title;

    if (was && here && there) {
      const item = mergeItem(was.item, here.item, there.item);
      const phase = merge3(was.phase, here.phase, there.phase);
      if (!item || !phase.ok) {
        return refuse(`"${title}" was changed elsewhere while this form was open.`);
      }
      merged.set(id, { item, phase: phase.value });
    } else if (was && !here && there) {
      // Removed here. Removing what someone else has just changed would throw
      // their change away unseen, so it has to be looked at again.
      if (!same(there, was)) {
        return refuse(`"${title}" was changed elsewhere while this form removed it.`);
      }
    } else if (was && here && !there) {
      // Removed elsewhere. Saving an edit to it would bring it back — the
      // per-item editor's own refusal, kept.
      if (!same(here, was)) return refuse(`"${title}" is not in the live version any more.`);
    } else if (!was && here && there) {
      if (!same(here, there)) {
        return refuse(`"${title}" was changed elsewhere while this form was open.`);
      }
      merged.set(id, here);
    } else if (!was && (here || there)) {
      merged.set(id, (here ?? there)!);
    }
    // was && !here && !there: removed on both sides.
  }

  for (const placed of merged.values()) {
    if (!phaseIds.has(placed.phase)) {
      return refuse(`"${placed.item.title}" belongs to a phase that is no longer there.`);
    }
  }

  // 3. The order inside each phase. Whichever side re-ordered the items both
  //    documents already had gives the primary order; the other side's
  //    newcomers go after the item that preceded them on their own side, which
  //    is where that side put them. Two different re-orderings conflict.
  const phases: ProtocolPhase[] = [];
  for (const phase of frame.value) {
    const members = new Set(
      [...merged].filter(([, placed]) => placed.phase === phase.id).map(([id]) => id)
    );
    const ob = orderIn(base, phase.id);
    const om = orderIn(mine, phase.id);
    const ol = orderIn(live, phase.id);
    const mineMoved = reordered(ob, om);
    const liveMoved = reordered(ob, ol);
    if (mineMoved && liveMoved) {
      const shared = new Set(om.filter((id) => ol.includes(id)));
      if (!same(narrowed(om, shared), narrowed(ol, shared))) {
        return refuse('The order of the items was changed elsewhere while this form was open.');
      }
    }
    const primary = mineMoved ? om : ol;
    const secondary = mineMoved ? ol : om;
    const order = narrowed(primary, members);
    for (let i = 0; i < secondary.length; i++) {
      const id = secondary[i]!;
      if (!members.has(id) || order.includes(id)) continue;
      let at = 0;
      for (let j = i - 1; j >= 0; j--) {
        const before = order.indexOf(secondary[j]!);
        if (before >= 0) {
          at = before + 1;
          break;
        }
      }
      order.splice(at, 0, id);
    }
    // A merged item's phase is always one side's phase, so it is always in one
    // of the two orders above; this only keeps that true by construction.
    for (const id of members) if (!order.includes(id)) order.push(id);
    phases.push({ ...phase, items: order.map((id) => merged.get(id)!.item) });
  }

  return settle(normalizeContent({ phases }));
}

/** The one gate every result passes, the same one the Coach's tool passes. */
function settle(content: ProtocolContent): Rebased {
  const invalid = validateContent(content);
  return invalid ? refuse(invalid) : { ok: true, content };
}

/**
 * The protocol row's facts that this form edits. **`is_active` is not one of
 * them**: pausing is a row on the protocol page (the owner's 2026-09-25 answer),
 * so a save can never flip it — including back from a pause made on the Coach
 * tab while the form was open.
 */
export type ProtocolFields = {
  name: string;
  description: string | null;
  type: ProtocolType;
  /** The phase clock's anchor. The form passes the opened value unless it was edited. */
  startedOn: string | null;
  carryOver: boolean;
  checkoffMode: CheckoffMode;
};

/** How each field is named in a refusal, in the order they are checked. */
const FIELD_NAMES: Record<keyof ProtocolFields, string> = {
  name: 'The name',
  description: 'The description',
  type: 'The type',
  startedOn: 'The start date',
  carryOver: '"If you miss it"',
  checkoffMode: '"When you check it off"',
};

export type FieldPatch =
  { ok: true; patch: Partial<ProtocolFields> } | { ok: false; refusal: string };

/**
 * The row fields this save writes: exactly the ones the form changed, onto the
 * row as it is now. A field the form did not touch is never written, so a
 * rename made on the Coach tab while the form was open survives a save that
 * only changed a dose. Same conflict rule as {@link rebaseContent}.
 */
export function fieldPatch(
  opened: ProtocolFields,
  mine: ProtocolFields,
  live: ProtocolFields
): FieldPatch {
  const patch: Partial<ProtocolFields> = {};
  for (const key of Object.keys(FIELD_NAMES) as (keyof ProtocolFields)[]) {
    if (same(mine[key], opened[key]) || same(mine[key], live[key])) continue;
    if (!same(live[key], opened[key])) {
      return {
        ok: false,
        refusal: `${FIELD_NAMES[key]} was changed elsewhere while this form was open.`,
      };
    }
    (patch as Record<string, unknown>)[key] = mine[key];
  }
  return { ok: true, patch };
}
