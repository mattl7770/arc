# Knowledge base — browse, author, import, and the Coach's write path into the reference

**Status:** Spec — designed 2026-08-12 in a docs-only round. **Nothing here is built**; no migration has shipped, and the Data tab's "Knowledge base" row (`app/(tabs)/data.tsx`, the `knowledge` entry) stays a disabled "Later" chip until v1 lands.
**Owner decisions already taken (2026-08-12):** v1 includes **all four capabilities** — (1) browse + keyword search, (2) user-authored entries, (3) AI import from URL/paste, (4) a confirmation-gated Coach write tool. **Semantic search stays gated on the embedder** (its own EAS build; `docs/rag-embeddings.md`) regardless of anything in this spec.
**Read first:** `src/lib/rag/corpus.ts` (the pack and its editorial doctrine — the load-bearing header) · `db/migrations/0025_rag_chunks.sql` · `src/lib/ai/history-search.ts` (keyword recall as shipped) · `docs/recipes-grocery.md` (the import-ladder precedent) · `src/lib/ai/tools/index.ts` (the coverage manifest a new tool must join).

---

## 0. The shape, in ten lines

1. A new entry-level table **`knowledge_entries`** is the authoring unit; **`knowledge_chunks`** (0025) stays the retrieval unit. Entries are documents you browse and edit; chunks are derived per entry and replaced on edit (the `ingestMemory` mirror).
2. **The curated pack stays exactly where it is** — chunk rows under `source='arc-longevity-v1'`, replaced wholesale on a pack-version bump, untouched by this feature. Pack chunks: `entry_id NULL + pack_version NOT NULL`; entry chunks: the reverse. The pack's DELETE-by-source **structurally cannot** eat user content, and a test pins it.
3. **Pack entries are read-only.** Wholesale replacement makes in-place edits structurally doomed; the honest alternative — *"Write your own entry on this topic"* — is offered right on the pack reader. Your entry outranks the pack in search; conflicts are named by the Coach, never silently resolved.
4. **Browse is a Data-pushed hub** (`/knowledge`, the `labs.tsx` model): keyword search, "Your entries" first, "ARC reference" grouped by topic beneath; a serif-prose reader with a provenance footer; soft archive with restore (the `coach-memory.tsx` pattern).
5. **Import is the recipes ladder cut down for articles**: URL fetch → deterministic readable-text + metadata extraction → **one no-tools model turn** → **editable review, never auto-commit** → one-transaction save. Paste-text is first-class; manual authoring is the floor forever.
6. **The model produces doctrine, not a book report**: the source's committed claims compressed into ARC's editorial voice, the source's own hedging attributed — and `found: false` when the text isn't substantive. Never an entry synthesized from a title (the Flavorish rule, third application after recipes and labs).
7. **One new Coach tool: `save_knowledge_entry`** (confirmation-gated write). No new read tool — `search_history` already covers keyword recall, and the tool catalog is ~66–72% of the cached prefix. The registry goes **42 → 43 in one batched change** — one prompt-cache invalidation, not several.
8. **Memory vs knowledge, the sharp line:** `coach_memories` (0030) = one-sentence durable facts *about you*, injected every turn; `knowledge_entries` = doctrine *about how things work*, retrieved on demand and cited. Litmus: "true about the user" vs "true about the world / the approach."
9. **RAG rides along for free:** entry chunks land in the same table the embedder backfill will sweep, so semantic search covers user entries automatically the day the embedder ships. Nothing in this spec waits for it; `search_knowledge` stays unregistered until then, by decree (`read-tools.ts` — "Re-register this the day the embedder ships").
10. **One network ADR extension** (§7): user-initiated single-shot article-URL fetches at import time. Without sign-off, import ships **paste-only** — still fully functional with a key.

---

## 1. What exists today (verified 2026-08-12)

- **`knowledge_chunks` + `memory_chunks`** (0025): regular tables; the `vec0` virtual table is created lazily on device only (`src/lib/db/repositories/rag.ts`) so the headless suites never see it.
- **The pack:** `src/lib/rag/corpus.ts` — 10 entries, pack `arc-longevity-v1` v1, ingested idempotently at boot (`src/lib/db/seed.ts`); a version bump DELETEs the source's rows and re-inserts. Its editorial doctrine is the contract every new writer inherits: *"That is what belongs in a corpus the Coach cites: house doctrine, not a textbook."* The model knows the literature; the corpus records what **ARC commits to** — which marker is primary, what "optimal" means here, where ARC refuses to be certain.
- **Keyword recall ships:** `searchUserHistory` (`src/lib/ai/history-search.ts`) — deliberately LIKE-based (FTS5 rejected as unprobed on device, documented as a drop-in behind the same function), six sources including `knowledge_chunks` (cited "ARC reference · <topic>"), reference material deliberately ranked below the user's own history at equal relevance. Exposed as the Coach's `search_history` tool.
- **`search_knowledge`** (semantic) is fully written and deliberately **unregistered**; `ingestMemory` (`src/lib/rag/memory.ts`) stores content vector-less and replaces by origin — the exact pattern entry chunking reuses.
- **The Coach registry:** 42 tools (18 read + 24 write); every tool must be classified in `COACH_DOMAINS` or `coverageProblems()` fails the suite. The knowledge domain exists (`index.ts` — 'past conversations and the ARC reference', tools: `['search_history']`).
- **No browse UI, no editor, no non-corpus write path.** `app/coach-memory.tsx` is the closest list surface; `app/labs.tsx` the model Data-pushed hub.
- Anthropic has **no embeddings API** — the model client may *structure* knowledge content but can never embed it (`docs/rag-embeddings.md`).

---

## 2. Data model

> ⚠️ **Migration number assigned at build time.** Head measured 2026-08-12 is `0032`, so this lands at **0033+ — re-measure against `main` at branch time**; the runner silently skips numbers at or below a device's `user_version` (the 0030/0031 collision lesson). Run `npm run db:bundle` after adding the file.

**Decision: an entry-level table, not new `source` values in `knowledge_chunks`.** Four reasons, each individually sufficient:

1. **Round-tripping fails.** `chunkText` whitespace-normalizes and splits; a long entry becomes N rows with paragraph structure destroyed. Browse/edit needs the authored document back verbatim — chunks-as-authoring-unit is lossy by construction.
2. **Provenance is per-entry.** `source_url`, author, imported-at, archived-at belong once per document, not smeared across chunk rows.
3. **The pack contract stays clean.** `ingestCorpus`'s `DELETE … WHERE source = ?` is safe today only because one source exists. Separate ownership makes "pack replacement can't eat user content" structural rather than conventional.
4. **The precedent exists.** `memory_chunks` is chunks-derived-from-origin, replaced by origin on re-ingest. Entries mirror it — with one deliberate inversion: memory chunks *survive* origin deletion (history persists); knowledge chunks **die with their entry** (retracted doctrine must stop being retrievable). Hence a real FK with CASCADE where memory is FK-free.

```sql
CREATE TABLE knowledge_entries (
  id text PRIMARY KEY NOT NULL,
  title text NOT NULL CHECK (length(trim(title)) > 0),
  -- Free text, vocabulary owned by data not CHECK — the metric_type /
  -- grocery-category precedent. The editor offers the existing topics as chips.
  topic text NOT NULL DEFAULT 'other',
  body text NOT NULL CHECK (length(trim(body)) > 0),
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'import', 'coach')),
  source_url text,        -- when imported from a URL
  source_author text,     -- site / author attribution
  source_note text,       -- model caveats, or "pasted text" provenance
  archived_at text,       -- soft delete; NULL = active (coach_memories pattern)
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);
CREATE INDEX knowledge_entries_active_idx
  ON knowledge_entries (updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX knowledge_entries_topic_idx ON knowledge_entries (topic);
-- + the standard updated_at AFTER UPDATE trigger.

-- Derived-chunk provenance. Forward-only ALTER (the 0013 precedent). CASCADE is
-- deliberate and OPPOSITE to memory_chunks' FK-free survival: a deleted entry's
-- doctrine must stop being retrievable.
ALTER TABLE knowledge_chunks ADD COLUMN entry_id text
  REFERENCES knowledge_entries (id) ON DELETE CASCADE;
CREATE INDEX knowledge_chunks_entry_idx ON knowledge_chunks (entry_id);
```

**Invariants — documented here and pinned in `db/knowledge.test.mjs`, since an ALTER cannot add a CHECK:**

- Entry chunks: `source = 'user-knowledge'` (a reserved constant), `entry_id NOT NULL`, `pack_version NULL`, `chunk_index` = passage position within the entry.
- Pack chunks: `entry_id NULL`, `pack_version NOT NULL`.
- **The pack-protection test:** re-running `ingestCorpus` with a version bump leaves entry chunks byte-identical.
- **Archive semantics:** archiving deletes the entry's chunks (vectors first, by chunk id) but keeps the entry row; restore re-chunks. Chunks are cheap derived data, and this keeps *every* downstream reader — `searchUserHistory` today, `search_knowledge` later — automatically blind to archived doctrine with zero query changes. Hard delete = arm/confirm; `deleteVectors` by id, then delete the entry (CASCADE takes the chunks).
- `chunk_index` wrinkle, named: pack rows use it as entry-position-in-pack (`corpus.ts`); entry rows use passage-position-in-entry. Both satisfy 0025's "position within its source document."

**`searchUserHistory` extension** (source 5 of its 6): the knowledge query adds `entry_id` to its SELECT and labels by provenance — pack rows keep **"ARC reference · <topic>"**, entry rows become **"your knowledge · <topic>"**. Both keep the `date: 'reference'` sentinel: a user's *entry* is still reference-shaped doctrine, not an event, so the own-history-outranks-reference tie-break is untouched. Among references, **your entries sort before pack entries** (your committed stance outranks the shipped one). Multi-chunk entries dedupe to the best-scoring chunk per `entry_id` so one long entry can't monopolize the hit budget; knowledge excerpts may run to ~500 chars (vs 300) — a doctrine gist truncates worse than a chat line.

---

## 3. Screens

Flat kebab-case routes + `Stack.Screen` entries in `app/_layout.tsx`; the Data-tab `knowledge` row gains `onPress` (tally self-updates) and its chip retires.

| Route | Screen |
| --- | --- |
| `app/knowledge.tsx` | The hub (`StackHeader` back to Data). A keyword **search field** filtering both stores in place — `queryTerms` + OR-of-LIKEs over title/topic/body, ranked by distinct-term count; deliberately *not* `searchUserHistory`, which is the Coach's cross-source tool. **Your entries** first (active, newest-updated; row = serif title · topic eyebrow · muted source line — "written by you" / "imported · outlive.com" / "saved from a Coach conversation"), then **ARC reference** grouped by topic (ruled plates per topic, the labs category-plate model). One stamped plate spends the accent: **Import an article** → `/knowledge-import`; **Write an entry** rides beside it as a ghost action (⚑ MATT #3 to flip). Collapsed **Archived** section at the foot (restore / delete — `coach-memory.tsx` verbatim). |
| `app/knowledge-entry.tsx` | The reader — the one screen in this family that is *for reading*: topic eyebrow (label voice), serif title, body as serif prose with generous line-height. Provenance footer in mono: `ARC reference · pack arc-longevity-v1` / `Written by you · since 2026-08-12` / `Imported · outlive.com · Peter Attia · 2026-08-12` (URL shown as text, opened via `Linking` — never fetched) / `Saved from a Coach conversation · 2026-08-12`. User entries: **Edit · Archive**. Pack entries: no edit; the footer states *"Part of ARC's shipped reference — replaced when the pack updates, so it can't be edited in place"*, with one action: **Write your own entry on this topic** (editor, topic prefilled). |
| `app/knowledge-entry-edit.tsx` | Add/edit (§4). |
| `app/knowledge-import.tsx` | The import ladder (§5). |

**Empty state** ("Your entries", zero rows) — authored, and honest about the mechanism: *"Nothing of your own yet. Below is ARC's shipped reference. Anything you add — written, imported, or saved from a Coach chat — lands here, and the Coach cites it like the rest."* The pack ships, so the screen is never globally empty: the first-run state is a reading, not a void.

**Pack annotatability: read-only, decisively.** Your-own-entry-on-this-topic gives everything margin notes would (your stance, findable, cited, ranked above the pack) without inventing a second content type or an edit path the pack-version bump would eat.

---

## 4. Authoring

`knowledge-entry-edit.tsx`: **title** (required) · **topic** — chips of the existing vocabulary (the pack's eight topics — cardiovascular, recovery, training, sleep, metabolic, method, supplements, lifestyle — plus any user topics already in use) with free-text entry for a new one · **body** — the large multiline field. Soft guidance, not enforcement: an entry is a page, not a paper (the chunker handles anything; doctrine reads best under ~1,000 words).

- **Save** = one transaction: the entry row + `chunkText(body)` → `knowledge_chunks` rows (`source='user-knowledge'`, `entry_id`, passage-ordered `chunk_index`, `estimateTokens`). Vector writes are the guarded no-op they are everywhere (`upsertVector` returns false off-embedder).
- **Edit** = update entry + **replace-by-entry**: collect prior chunk ids → `deleteVectors` → delete chunks → re-insert. `ingestMemory`'s exact shape with `entry_id` as the origin key.

**Coach doctrine for conflicts** (lands in the sync trio — `system-prompt.ts` TOOL_DOCTRINE + `docs/ai-coach.md` + the test sections — with ⚑ MATT #4 on the hierarchy): *when the user's own knowledge entry and the ARC reference disagree, cite both and name the difference; follow the user's committed stance for personal coaching; never silently drop either.*

---

## 5. AI import — the ladder, cut to what articles need

Three live rungs plus the floor. Every rung degrades to the next; the four-beat contract governs throughout (pick/paste → one no-tools model turn → **editable review, never auto-commit** → one-transaction save).

| # | Rung | Mechanism | Gate |
| --- | --- | --- | --- |
| 1 | URL | fetch HTML (device UA, 10 s abort, size-capped, untrusted-input discipline) → deterministic extraction: readable text (**generalize `src/lib/recipes/extract.ts`** rather than fork it) + Article/NewsArticle JSON-LD & og-meta for provenance prefill (`headline`, `author`, `og:site_name`). Metadata only — no deterministic article→entry rung exists, so the model turn always follows. | network + the §7 ADR + key |
| 2 | Any text (fetched or pasted) | **one no-tools model turn** through `runCoachTurn` (the `estimate.ts` / recipes twin): JSON-only contract, defensive parse. | key |
| 3 | Paste text | the same turn over pasted article text — first-class UI with its own affordance, not an error state. | key |
| — | Manual floor | the §4 editor, prefilled with whatever survived (pasted text into body, URL into provenance). | none |

**Deliberately cut:** the platform caption rungs (Instagram/TikTok/YouTube are not article sources — a social URL falls to rung 1's generic fetch and degrades honestly to paste), and the **screenshot/vision rung** — deferred, not forgotten (⚑ MATT #5): articles are text-shaped, paste covers the gap, and the vision path is still device-unverified on the recipes side. Revisit once recipes' vision rung is device-proven.

**The extraction contract** — what the model is told to produce, given "house doctrine, not a textbook":

```
{ found: boolean, title, topic, body, source_title, source_author, caveats }
```

- **Body = what this source commits to** — specific claims, mechanisms, numbers, stated so a coach could cite them. Contested or authorial positions are attributed ("the author argues…"); the source's own hedging is carried; the throat-clearing is dropped. Neither a neutral summary nor raw quotes: a doctrine-shaped compression.
- **Nothing not in the source.** No padding from general knowledge, no invented numbers, no "as is well known." If the source doesn't contain it, it isn't in the entry.
- **`found: false`** when the text has no substantive content — paywall stub, cookie interstitial, headline + teaser, link farm. Never synthesize an entry from a title. The UI then surfaces paste: *"open the article, copy its text, paste it here."*
- `topic` from the existing vocabulary (listed in the prompt), or a new lowercase word when none fits. `caveats` → shown in review, stored to `source_note` ("the article's dosage table was an image and is not captured").

**Review** (beat three): editable title/topic/body + provenance shown; Save writes `source='import'` + `source_url`/`source_author`/`source_note` + chunks in one transaction. Without a key: `KnowledgeImportUnavailableError` exactly like `estimateMeal`/`importRecipe`, and the screen still offers paste-into-manual-editor.

---

## 6. The Coach write tool — `save_knowledge_entry`

One new tool. **Registry 42 → 43 (18 read + 25 write), shipped as one batched registry change** — one prompt-cache invalidation.

- **Input:** `{ title, topic, body }`, `additionalProperties: false`. Topic guidance in the description (existing vocabulary; new lowercase word allowed).
- **Card:** `Save knowledge entry "<title>" · <topic> · <N> words`. The card is compact, so the doctrine makes approval informed: **the model must present the drafted entry verbatim in its message before calling the tool** — the body the user approves is on screen directly above the card; the card names what and how much, per the `confirmSummary` contract.
- **Execute:** `saveKnowledgeEntry(db, { …, source: 'coach' })` — the same repository path the editor uses, chunking included. Returns `{ saved: true, id }`.
- **Doctrine** (sync trio): reach for this **only on the user's request or clear invitation** ("save that to my knowledge base", "keep that explanation"); never proactively archive your own outputs. And the memory/knowledge line, verbatim: *`remember` stores one-sentence facts about the user; `save_knowledge_entry` stores reference — how something works, or a stance the user commits to. "Magnesium citrate upsets his stomach" is a memory; "magnesium forms differ in absorption; glycinate is better tolerated" is knowledge.*
- **`COACH_DOMAINS`:** the knowledge domain becomes `{ label: 'the knowledge base and past conversations', tools: ['search_history', 'save_knowledge_entry'] }` — it acquires a write tool, so the coverage manifest moves it to the read-and-write list automatically and `coverageProblems()` stays green.

**No `get_knowledge_entry` in v1, decisively.** `search_history` already returns knowledge excerpts with citations; full-entry reads don't clear the tool-catalog token bar. Recorded as deliberately-out with a revisit trigger: if real transcripts show truncated-doctrine answers, add it **batched with the next registry change** — plausibly the `search_knowledge` registration itself, which is already written and waiting on the embedder. **No Coach edit/archive of entries** — editing is the user's act in the UI, consistent with "editing or deleting anything already logged" living in `UNCOVERED_DOMAINS`.

---

## 7. Network posture — the ADR this spec requires

Rung 1's fetch is a **new network surface** and must be recorded as an extension of the existing exception before it ships (⚑ MATT #1). Proposed ADR text for `docs/decisions.md`:

> *Knowledge import extends the 2026-08-08 user-initiated import-fetch exception from recipe sources to article URLs: single-shot, at import time only, the URL the user explicitly pasted or shared, HTML text only, never media, never background. Failure degrades to paste-the-text, which stays first-class UI.*

Without sign-off, import ships **paste-only** — genuinely useful, zero new network surface (the recipes precedent for shipping under a pending decision).

---

## 8. RAG integration & the embedder path

- Save/edit/restore → `chunkText` → replace-by-entry. Content always; vectors are guarded no-ops until the embedder exists.
- Archive → delete chunks + vectors, keep the entry. Delete → vectors by id, then CASCADE.
- **When the embedder ships:** the backfill pass sweeps `knowledge_chunks` rows lacking a vector — pack and entry chunks ride the *same table*, so **one backfill covers both with no knowledge-specific work** (path confirmed: `upsertVector` takes `corpus:'knowledge'` + the chunk's `source`; `knnSearch` partitions by corpus; retrieval joins content back by id). The only follow-ups at that point — `retrieve.ts`'s citation label learning `entry_id`, and re-registering `search_knowledge` — are explicitly out of this spec's scope.

---

## 9. Degradation ledger

| Capability | No key, no network | Key, no ADR sign-off | Embedder absent |
| --- | --- | --- | --- |
| Browse / read / hub search | full | full | full |
| Author add/edit/archive/restore (+ chunking) | full | full | full — vector-less chunks, backfilled later |
| `search_history` incl. knowledge (screen + Coach tool) | full (the Coach itself needs a key to have a turn at all; the hub's search is keyless) | full | full — keyword is the shipping search |
| Import — paste → model turn | needs key | **full** | full |
| Import — URL fetch rung | needs key + network | **paste-only until the ADR lands** | full |
| Import — manual floor | full | full | full |
| `save_knowledge_entry` | needs key | full | full |
| Semantic search (`search_knowledge`) | — | — | **stays unregistered until the embedder's own EAS build, by decree** |

---

## 10. Tests & build slices

**`db/knowledge.test.mjs`:** migration applies over head; CHECKs (blank title/body, bad source) reject; **the pack-protection invariant** (version-bump re-ingest leaves entry chunks byte-identical); replace-by-entry on edit (old chunks gone, new present, other entries untouched); archive deletes chunks and keeps the entry, restore re-chunks; CASCADE on hard delete; `searchUserHistory` labels ("your knowledge" vs "ARC reference"), entry-over-pack ordering among references, per-entry dedupe.
**`db/knowledge-import.test.mjs`:** readable-text + JSON-LD/og-meta extraction fixtures (real-page shapes); prompt contract (vocabulary listed, nothing-not-in-source present); parse (well-formed, `found:false`, malformed JSON, missing fields).
**`db/coach-tools.test.mjs`** extensions: `save_knowledge_entry` registered + classified (`coverageProblems` green at 43), card wording, execute writes `source='coach'` through the shared repository path.

**Build slices** (each independently shippable): **1** — migration + repository + hub/reader/editor + the `searchUserHistory` extension (offline, keyless); **2** — import (paste-first; the URL rung when the ADR lands); **3** — the one-tool registry batch. Each slice carries its headless gate; the screens join `db/screens-render.test.mjs`.

**Integrator merge points:** `app/_layout.tsx` (four routes) · `app/(tabs)/data.tsx` (`knowledge` row) · migration + `npm run db:bundle` + `src/lib/db/types.ts` · `history-search.ts` · the registry + `docs/ai-coach.md` tool counts + the sync trio · `docs/decisions.md` (the ADR) · `docs/project-status.md` inventory re-measured in the same change.

---

## 11. ⚑ MATT — owner calls this spec carries

1. **The network ADR (§7)** — sign off on article-URL fetches joining the recipe-import exception? Without it, import ships paste-only.
2. **`save_knowledge_entry`** — comfortable with the Coach authoring doctrine into the KB (always card-gated, `source='coach'`), or hold it back initially?
3. **The hub's accent** — recommended: **Import an article** takes the stamp, "Write an entry" rides as a ghost. Flip if you expect to write more than you save.
4. **Conflict doctrine** — your entry vs the ARC reference: cite both, name the difference, follow *your* stance for personal coaching. Approve that hierarchy?
5. **Screenshot-import rung deferred** until recipes' vision rung is device-proven. Approve the deferral?

---

## Related documents

- `docs/rag-embeddings.md` — the embedder plan this spec deliberately does not depend on
- `docs/recipes-grocery.md` — the import ladder, anti-fabrication doctrine, and network-ADR precedent
- `docs/ai-coach.md` — the tool registry, coverage manifest, and doctrine sync trio
- `docs/coach-intelligence-review.md` — where the corpus and the "honest recall now" path came from
- `db/migrations/0025_rag_chunks.sql` · `src/lib/rag/corpus.ts` · `src/lib/ai/history-search.ts` — the shipped substrate
