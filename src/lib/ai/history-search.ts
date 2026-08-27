/**
 * Keyword recall over the user's own written history — the recall that works
 * TODAY, with no embedder, no native module, and no network.
 *
 * The RAG stack (0025) is the eventual home of semantic recall, but its
 * embedder is a hardcoded null pending an ONNX runtime and its own EAS build,
 * so `search_knowledge` could never return a passage. Rather than ship a tool
 * that always fails (the codebase's own stub doctrine: "a tool that always
 * fails teaches the model not to call it"), this gives the Coach real recall
 * over the text the user has actually written, using nothing but SQL.
 *
 * Deliberately LIKE-based rather than FTS5: op-sqlite's FTS5 availability is
 * unprobed on device, and an index would have to be kept in sync with five
 * tables. At single-user scale (thousands of rows, not millions) a scan is
 * imperceptible, and the semantics are obvious. If it ever gets slow, FTS5 is
 * a drop-in behind this same function.
 *
 * Pure over the {@link Database} interface — headless-tested in
 * db/coach-memory.test.mjs.
 */
import type { Database } from '@/lib/db/database';

export type HistoryHit = {
  /** Where it came from, for the citation: "your note", "our conversation"… */
  source: string;
  /** YYYY-MM-DD. */
  date: string;
  /** The matching text, truncated. */
  text: string;
};

/** Cap on one returned excerpt — the model needs the gist, not the essay. */
const EXCERPT_CHARS = 300;

/**
 * Knowledge passages get a longer window (0038). A chat line truncated at 300
 * characters loses a sentence; a doctrine gist truncated at 300 loses the
 * qualification that made it doctrine rather than a slogan — and the Coach is
 * expected to CITE these, so a half-carried caveat is the failure mode that
 * matters. Both stores are still capped; only the cap differs.
 */
const KNOWLEDGE_EXCERPT_CHARS = 500;

function excerpt(text: string, terms: string[], cap: number = EXCERPT_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= cap) return flat;
  // Window the excerpt around the first matching term so the hit is visible,
  // not truncated away.
  const lower = flat.toLowerCase();
  const at =
    terms
      .map((t) => lower.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 80);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + cap)}…`;
}

/** Split a query into meaningful lowercase terms (drops 1-char noise). */
export function queryTerms(query: string): string[] {
  return [
    ...new Set(
      query
        .toLowerCase()
        .split(/[^a-z0-9']+/)
        .filter((t) => t.length > 1)
    ),
  ];
}

/**
 * Search the user's written history. A row matches when it contains ANY term;
 * results are ranked by how many DISTINCT terms they contain (so a row hitting
 * "magnesium" and "sleep" outranks one hitting only "sleep"), then by recency.
 */
export function searchUserHistory(db: Database, query: string, limit = 15): HistoryHit[] {
  const terms = queryTerms(query);
  if (terms.length === 0) return [];

  // One OR-of-LIKEs per source table. Parameterised — never interpolated.
  const where = terms.map(() => 'lower(%COL%) LIKE ?').join(' OR ');
  const params = terms.map((t) => `%${t}%`);
  const clause = (column: string) => where.split('%COL%').join(column);

  /**
   * A hit plus two things the ranker needs and the caller must never see: how
   * long its excerpt may run, and WHOSE reference it is. `refRank` orders the
   * three owners of the knowledge base against each other at equal relevance
   * (0044): the user's own record of himself, then his own doctrine, then ARC's
   * shipped pack. Both optional so the five sources that want the defaults push
   * a plain {@link HistoryHit}.
   */
  type RankedHit = HistoryHit & { cap?: number; refRank?: number };
  const rows: RankedHit[] = [];

  // 1) Conversation turns — what was actually said, both sides.
  for (const row of db.all<{ role: string; content: string; created_at: string }>(
    `SELECT role, content, created_at FROM ai_messages
     WHERE (${clause('content')}) AND content <> ''
     ORDER BY created_at DESC LIMIT 200`,
    params
  )) {
    rows.push({
      source: row.role === 'user' ? 'you said' : 'you and I discussed',
      date: row.created_at.slice(0, 10),
      text: row.content,
    });
  }

  // 2) Day-log notes and captures — the user's own shorthand.
  for (const row of db.all<{ title: string; date: string }>(
    `SELECT le.title AS title, dl.date AS date FROM log_entries le
     JOIN daily_logs dl ON dl.id = le.daily_log_id
     WHERE ${clause('le.title')}
     ORDER BY dl.date DESC LIMIT 200`,
    params
  )) {
    rows.push({ source: 'your log', date: row.date, text: row.title });
  }

  // 3) Protocol change notes — why a stack changed, in the words used then.
  for (const row of db.all<{ change_notes: string; created_at: string; name: string }>(
    `SELECT pv.change_notes AS change_notes, pv.created_at AS created_at, p.name AS name
     FROM protocol_versions pv JOIN protocols p ON p.id = pv.protocol_id
     WHERE pv.change_notes IS NOT NULL AND (${clause('pv.change_notes')})
     ORDER BY pv.created_at DESC LIMIT 100`,
    params
  )) {
    rows.push({
      source: `protocol change (${row.name})`,
      date: row.created_at.slice(0, 10),
      text: row.change_notes,
    });
  }

  // 4) Experiments — hypotheses tried and verdicts reached.
  for (const row of db.all<{
    title: string;
    hypothesis: string;
    conclusion: string | null;
    start_date: string;
  }>(
    `SELECT title, hypothesis, conclusion, start_date FROM experiments
     WHERE (${clause('title')}) OR (${clause('hypothesis')})
        OR (conclusion IS NOT NULL AND (${clause('conclusion')}))
     ORDER BY start_date DESC LIMIT 50`,
    [...params, ...params, ...params]
  )) {
    rows.push({
      source: 'experiment',
      date: row.start_date,
      text: row.conclusion
        ? `"${row.title}" — ${row.hypothesis} → ${row.conclusion}`
        : `"${row.title}" — ${row.hypothesis} (no verdict yet)`,
    });
  }

  // 5) The knowledge base — BOTH owners of `knowledge_chunks` (0038):
  //
  //    · the curated longevity pack (src/lib/rag/corpus.ts), so an explanation
  //      is grounded in what ARC actually commits to rather than the model's
  //      general recall — cited "ARC reference · <topic>";
  //    · the user's OWN entries, written, imported or saved from a Coach turn —
  //      cited "your knowledge · <topic>", or "your record · <topic>" when the
  //      entry sits in the PERSONAL section (0044).
  //
  // The pack/entry split is derived from `entry_id`, which is the column that
  // owns it (pack rows are null there by construction). The section is a
  // property of the ENTRY, not of the chunk, so the entry query JOINs back for
  // it rather than duplicating it onto every chunk row — which also means
  // re-filing an entry between sections needs no re-chunk and can never leave a
  // stale label behind. (A chunk-table column would have been the alternative;
  // it would be a second migration to store data that is one join away.)
  //
  // The label matters to the model, not just to the citation: "your record"
  // says this passage is the user's own account of HIMSELF, which is the
  // strongest thing the Coach can be holding mid-conversation, and it must not
  // be weighed the same as an article somebody else wrote.
  //
  // Archived entries have no chunks at all, so retracted doctrine is unreachable
  // from here with no `archived_at` join to remember — see the repository's
  // archive semantics.
  //
  // Both keep the `date: 'reference'` sentinel. A user's ENTRY is still
  // reference-shaped doctrine — a claim about how something works — not an event
  // that happened on a day, so the own-history-outranks-reference tie-break
  // below stays exactly as it was. What separates the two is the second-order
  // tie-break: among references, the user's committed stance outranks the
  // shipped one.
  //
  // ONE QUERY PER OWNER, each with its own window — NOT one query over the
  // table. This is the whole subtlety of the block and it is easy to get wrong:
  // the per-entry dedupe below runs in JS, i.e. AFTER SQL has already applied
  // its LIMIT, so a single shared window does not protect the pack at all. With
  // one `LIMIT 40` over both owners, a user with a dozen multi-passage entries
  // fills the window with their own chunks, the dedupe collapses them to a
  // dozen hits, and the ARC reference contributes NOTHING — silently, and worse
  // the more the user writes. Separate windows make the split structural: the
  // pack's 20 rows are the 20 it always had, and no amount of user content can
  // reach them.
  {
    type ChunkHit = {
      entry_id: string | null;
      section?: string | null;
      title: string | null;
      topic: string | null;
      body: string;
    };
    /** 0 = the user's own record of himself, 1 = his doctrine, 2 = the pack. */
    const rankOf = (row: ChunkHit): number =>
      row.entry_id === null ? 2 : row.section === 'personal' ? 0 : 1;
    const OWNER = ['your record', 'your knowledge', 'ARC reference'];
    const asHit = (row: ChunkHit): RankedHit => ({
      source: `${OWNER[rankOf(row)]}${row.topic ? ` · ${row.topic}` : ''}`,
      // Reference material is not dated like a log entry; it is current doctrine.
      date: 'reference',
      text: row.title ? `${row.title} — ${row.body}` : row.body,
      cap: KNOWLEDGE_EXCERPT_CHARS,
      refRank: rankOf(row),
    });

    // The pack: one row per entry by construction (corpus.ts does not chunk),
    // so there is nothing to dedupe and the window is unchanged from before.
    for (const row of db.all<ChunkHit>(
      `SELECT entry_id, title, topic, body FROM knowledge_chunks
       WHERE entry_id IS NULL AND ((${clause('body')}) OR (${clause('title')}))
       ORDER BY chunk_index LIMIT 20`,
      [...params, ...params]
    )) {
      rows.push(asHit(row));
    }

    // The user's entries: a wider window because one entry is several passages,
    // then deduped to the best-scoring passage per entry so one long document
    // cannot spend the hit budget saying the same thing five ways.
    const bestByEntry = new Map<string, { score: number; hit: ChunkHit }>();
    for (const row of db.all<ChunkHit>(
      `SELECT kc.entry_id AS entry_id, ke.section AS section, kc.title AS title,
              kc.topic AS topic, kc.body AS body
       FROM knowledge_chunks kc JOIN knowledge_entries ke ON ke.id = kc.entry_id
       WHERE kc.entry_id IS NOT NULL
         AND ((${clause('kc.body')}) OR (${clause('kc.title')}))
       ORDER BY kc.chunk_index LIMIT 60`,
      [...params, ...params]
    )) {
      const haystack = `${row.title ?? ''} ${row.body}`.toLowerCase();
      const score = terms.filter((t) => haystack.includes(t)).length;
      const prior = bestByEntry.get(row.entry_id!);
      if (!prior || score > prior.score) bestByEntry.set(row.entry_id!, { score, hit: row });
    }
    for (const { hit } of bestByEntry.values()) rows.push(asHit(hit));
  }

  // 6) Durable memories — things explicitly remembered about the user.
  for (const row of db.all<{ content: string; created_at: string; category: string }>(
    `SELECT content, created_at, category FROM coach_memories
     WHERE archived_at IS NULL AND (${clause('content')})
     ORDER BY created_at DESC LIMIT 50`,
    params
  )) {
    rows.push({
      source: `remembered (${row.category})`,
      date: row.created_at.slice(0, 10),
      text: row.content,
    });
  }

  const score = (hit: HistoryHit) => {
    const lower = hit.text.toLowerCase();
    return terms.filter((t) => lower.includes(t)).length;
  };
  return rows
    .sort((a, b) => {
      const byScore = score(b) - score(a);
      if (byScore !== 0) return byScore;
      // The user's own history outranks reference material at equal relevance:
      // "have we tried magnesium?" is a question about them, not about ApoB.
      const aRef = a.date === 'reference';
      const bRef = b.date === 'reference';
      if (aRef !== bRef) return aRef ? 1 : -1;
      // Among references, the three owners rank: the user's own record of
      // HIMSELF, then his own doctrine, then ARC's shipped pack (0038, widened
      // by 0044). Where both have something to say on a topic, what the user has
      // committed to is the more binding — and what is true OF him outranks what
      // he believes about the world, because a personal constraint changes the
      // answer while a stance only colours it. They are never silently merged:
      // all are returned, labelled by provenance, and the Coach's doctrine is to
      // cite both and name the difference rather than resolve it.
      if (aRef && bRef && a.refRank !== b.refRank) {
        return (a.refRank ?? 2) - (b.refRank ?? 2);
      }
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    })
    .slice(0, limit)
    // `cap`/`refRank` are ranking inputs, not part of the contract — the
    // returned object is a plain HistoryHit.
    .map(({ cap, refRank: _refRank, ...hit }) => ({
      ...hit,
      text: excerpt(hit.text, terms, cap),
    }));
}
