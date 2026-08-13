# Knowledge base — browse, author, import, and the Coach's write path into the reference

**Status: BUILT — 2026-08-12, migration `0035_knowledge_entries.sql`.** All three slices shipped in one change: the entry table + repository + four screens + the `searchUserHistory` extension; the import ladder (paste **and** URL — the §7 ADR was signed off, see §11); and the `save_knowledge_entry` registry batch (42 → 43). The Data tab's "Knowledge base" row is live and its "Later" chip has retired.
**Gate:** `db:test` **2,424 assertions / 48 suites, 0 failed** (new suites: `db/knowledge.test.mjs` **63**, `db/knowledge-import.test.mjs` **52**; `coach-tools` 212 → 232, `screens-render` 119 → 151) · `db:validate` 20/20 · `tsc` 0 · `eslint` 0 errors · iOS bundle exports. A pre-merge adversarial pass found **three real defects**, all fixed — §11b.
⚠️ **Headless only — none of this has been seen on a device.** The device checklist is §12.
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

> ✅ **Shipped as `0035_knowledge_entries.sql`.** Head at branch time was `0034` (recipe photo autoresolve), so this took the next free number; `npm run db:bundle` was re-run and `migrations.generated.ts` committed with it. The spec drafted this as "0033+ — re-measure at branch time", and main had moved two migrations in the interval, which is exactly why that instruction was written: the runner silently skips any number at or below a device's `user_version` (the 0030/0031 collision lesson).

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

> ✅ **Built as `src/lib/knowledge/import.ts` + `src/lib/knowledge/extract.ts`.** The readable-text half was **generalized rather than forked**, as this spec required, but one level further out than it proposed: `decodeHtmlEntities` / `metaContent` / `stripTags` / `pageTextForModel` moved from `src/lib/recipes/extract.ts` into a new **`src/lib/html/readable.ts`**, and `recipes/extract.ts` re-exports them so every existing call site and the recipe fixtures are untouched (56/56 still green). Nothing in there was ever recipe-specific, and importing a *recipes* module from a *knowledge* module to avoid a copy would have traded duplication for a worse dependency.
>
> One defect fell out of the move and is worth recording, because it was invisible to the recipe ladder: the shared entity table decoded `&frac34;` and not `&mdash;`. Publishers set prose through a typographer, so `&mdash;`, `&rsquo;` and the smart quotes are the commonest entities on a real article page by a wide margin — and left undecoded they do not merely look wrong, they are **stored** wrong, into the knowledge base and into whatever the Coach later cites from it. The typographic block was added and is pinned by a real-page fixture.

| # | Rung | Mechanism | Gate |
| --- | --- | --- | --- |
| 1 | URL | fetch HTML (10 s abort, size-capped, untrusted-input discipline) → deterministic extraction: readable text + Article/NewsArticle JSON-LD & og-meta for provenance prefill (`headline`, `author`, `og:site_name`). Metadata only — no deterministic article→entry rung exists, so the model turn always follows. | network + the §7 ADR + key |
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

✅ **Signed off 2026-08-12 and recorded in `docs/decisions.md` before the fetch rung shipped.** The ADR as written there also carries the accounting this spec's proposed text did not: the mechanism is byte-for-byte the sanctioned one, only the set of qualifying URLs widened; there is no second request (no redirect-chasing, no oEmbed variant, no embed fallback — articles need none); and the anti-fabrication rule bites *harder* here than for recipes, because a fabricated recipe is discovered the first time it is cooked while a fabricated doctrine entry outranks ARC's own reference in the Coach's search.

The original proposal, for the record:

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

> ✅ **All three shipped, 61 + 47 new assertions plus 20 in `coach-tools` and 32 in `screens-render`.** Two things the plan above did not anticipate, both recorded because they cost real time:
>
> - **The prompt-token ceilings were already full.** `db/coach-eval.test.mjs` §6 held the registry at 8,973/9,000 and the system prompt at 3,499/3,500 — 27 and 1 token of headroom — with a standing instruction that the next addition *trims duplication rather than raising*. It was followed: the new tool's description was cut 143 → 66 tok (its first draft restated three rails its prompt bullet already carried), `search_history`'s description was corrected and trimmed, the knowledge doctrine was **merged into the Memory bullet** instead of added beside it, and two pre-existing prompt duplications were folded. That recovered ~132 tok of schema and ~167 of prompt — about half the feature — after which both ceilings were raised with the full accounting written into that file, including where the *next* trim is (the four schema-heavy tools, ~1,000 tok, never swept).
> - **A flaky assertion, caught by running the suite eight times rather than once.** The listing test created two entries, edited the first, and demanded it be at the head — which passed four runs in five. `updated_at` is millisecond-precision, so all three writes land in one millisecond often enough to tie. The *rule* is now asserted (the list is sorted) plus a deterministic `ORDER BY` fixture built from raw INSERTs with explicit timestamps (an UPDATE cannot backdate a row here — the AFTER UPDATE trigger re-stamps it, by design). The tie-break also gained `created_at` as its second key, so a genuine same-millisecond tie falls back to creation order rather than to a random UUID.

**Integrator merge points:** `app/_layout.tsx` (four routes) · `app/(tabs)/data.tsx` (`knowledge` row) · migration + `npm run db:bundle` + `src/lib/db/types.ts` · `history-search.ts` · the registry + `docs/ai-coach.md` tool counts + the sync trio · `docs/decisions.md` (the ADR) · `docs/project-status.md` inventory re-measured in the same change.

---

## 11. Decided — 2026-08-12 (owner, at session start; all five as recommended)

1. **The network ADR (§7) — APPROVED.** Article-URL fetches join the recipe-import exception. The ADR is in `docs/decisions.md` dated 2026-08-12, written before the fetch rung shipped. Import therefore ships with **both** rungs, URL and paste.
2. **`save_knowledge_entry` — IN v1, card-gated.** Registry 42 → 43 in one batched change. `source='coach'`, and the doctrine requires the model to present the drafted body verbatim before calling.
3. **Hub accent — Import an article takes the stamp**; "Write" rides beside it as a ghost action inside the same stamp.
4. **Conflict hierarchy — APPROVED.** Cite both, name the difference, follow the user's committed stance for personal coaching. Lives in the sync trio and is pinned by `db/coach-tools.test.mjs` §34.
5. **Screenshot rung — DEFERRED.** Revisit once the recipes vision rung is device-proven.

### Deferred / deliberately out, with their revisit triggers

- **`get_knowledge_entry`** (full-entry read) — out. `search_history` returns knowledge excerpts with citations at ~500 chars. **Revisit if** real transcripts show truncated-doctrine answers, and add it *batched* with the next registry change — plausibly the `search_knowledge` registration itself.
- **Coach edit/archive of entries** — out. Editing is the user's act in the UI; the coverage manifest's "editing or deleting anything already logged, incl. your own writes and knowledge entries (Data, Knowledge base)" says so to the model.
- **Screenshot/vision import rung** — deferred per #5.
- **Semantic search / `search_knowledge` registration / the embedder** — untouched by this round, by decree. Entry chunks land in the same table the backfill will sweep, so they are covered the day it ships with no knowledge-specific work (§8).
- **Pack annotation in place** — never. §3 argues why; "write your own entry on this topic" is the shipped answer.

---

## 11b. Adversarial review before merge — three defects found and fixed

All three were in code that passed its own tests. Recorded because each is a *class* of mistake this codebase can make again.

1. **A prolific writer would have silently crowded the ARC reference out of the Coach's recall.** `searchUserHistory`'s knowledge block ran ONE query over `knowledge_chunks` with a shared `LIMIT`, then deduped per entry **in JS** — i.e. after SQL had already chosen the window. The dedupe protects the hit *budget*; it does nothing for the *window*. With enough multi-passage user entries the window filled with the user's own chunks and the pack contributed nothing at all — no error, no empty result, just a reference that quietly stopped being cited, and worse the more the owner wrote. Fixed by giving each owner its own query and its own window (pack 20, entries 60 → deduped), which makes the split structural. **The test was verified to have teeth** by reverting the query shape: it reports `pack=1` under the old design and `pack=4` under the fix. The general lesson: *a limit applied before a de-duplication is not the same limit.*
2. **The manual floor passed a whole pasted article through a route param.** Expo Router params are search params — they round-trip through URL encoding, and a pasted article routinely contains `%` ("50% of patients", a `%20` inside a quoted link). That is a `URIError` or a mangled paragraph on the exact path a user reaches only *after* import has already failed them once. Replaced with a one-shot in-memory handoff (`src/lib/knowledge/draft-handoff.ts`), the shape `consumeIncomingShare` already establishes — replay window included, because React runs a state initializer more than once per mount. **Content goes through memory; identifiers go through params.** `id` and `topic` are still params, correctly.
3. **`Linking.openURL` on a stored string with no scheme guard.** Everything that writes `source_url` today goes through `normalizeArticleUrl`, which forces http/https — so this was safe *by consequence of every writer having been careful*, which is not the same as safe. The allow-list now sits at the point where a stored string becomes an action the OS takes; a non-http row renders as plain text.

A fourth was caught by the suite rather than by review, and is worth the same note: **a flaky ordering assertion**, found by running the suite eight times instead of once. See §10.

---

## 12. Device checklist (nothing below has been run on hardware)

1. Data → Knowledge base opens; the pack reads as eight topic plates, and "Your entries" shows the authored empty.
2. The stamp's hatched cap draws correctly, and the ghost "Write" button beside the pine action does not read as disabled.
3. Write an entry with two paragraphs; reopen it — **the blank line must survive** (this is the whole reason entries are stored whole rather than as chunks).
4. Edit it, then search the Coach for a phrase only in the NEW text: the old passage must not come back.
5. Archive it, ask the Coach the same question: it must not be cited. Restore, ask again: it must be.
6. Import an article by URL (needs the key + network). Confirm the review screen is editable and that nothing saved until Save was tapped.
7. Import a paywalled article by URL: expect the honest "no readable article text" and the paste affordance, **not** a fabricated entry.
8. Ask the Coach to save something to the knowledge base: confirm it prints the entry in the message *before* the card appears.
9. Open a pack entry: confirm there is no Edit, and that "Write your own entry on this topic" prefills the topic.

---

## Related documents

- `docs/rag-embeddings.md` — the embedder plan this spec deliberately does not depend on
- `docs/recipes-grocery.md` — the import ladder, anti-fabrication doctrine, and network-ADR precedent
- `docs/ai-coach.md` — the tool registry, coverage manifest, and doctrine sync trio
- `docs/coach-intelligence-review.md` — where the corpus and the "honest recall now" path came from
- `db/migrations/0025_rag_chunks.sql` · `src/lib/rag/corpus.ts` · `src/lib/ai/history-search.ts` — the shipped substrate
