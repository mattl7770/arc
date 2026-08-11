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

function excerpt(text: string, terms: string[]): string {
  const flat = text.replace(/\s+/g, ' ').trim();
  if (flat.length <= EXCERPT_CHARS) return flat;
  // Window the excerpt around the first matching term so the hit is visible,
  // not truncated away.
  const lower = flat.toLowerCase();
  const at =
    terms
      .map((t) => lower.indexOf(t))
      .filter((i) => i >= 0)
      .sort((a, b) => a - b)[0] ?? 0;
  const start = Math.max(0, at - 80);
  return `${start > 0 ? '…' : ''}${flat.slice(start, start + EXCERPT_CHARS)}…`;
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

  const rows: HistoryHit[] = [];

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

  // 5) The curated longevity corpus (src/lib/rag/corpus.ts) — ARC's own
  // doctrine, so an explanation can be grounded in what ARC actually commits
  // to rather than the model's general recall. Searchable by keyword now;
  // the same rows gain vectors when the embedder ships.
  for (const row of db.all<{ title: string | null; topic: string | null; body: string }>(
    `SELECT title, topic, body FROM knowledge_chunks
     WHERE (${clause('body')}) OR (${clause('title')})
     ORDER BY chunk_index LIMIT 20`,
    [...params, ...params]
  )) {
    rows.push({
      source: `ARC reference${row.topic ? ` · ${row.topic}` : ''}`,
      // Reference material is not dated like a log entry; it is current doctrine.
      date: 'reference',
      text: row.title ? `${row.title} — ${row.body}` : row.body,
    });
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
      return a.date < b.date ? 1 : a.date > b.date ? -1 : 0;
    })
    .slice(0, limit)
    .map((hit) => ({ ...hit, text: excerpt(hit.text, terms) }));
}
