-- ============================================================================
-- ARC 0035 — knowledge entries: the authoring unit above the retrieval unit
--
-- docs/knowledge-subapp.md §2. `knowledge_chunks` (0025) already held the
-- curated pack and was already searchable by keyword, but there was no way for
-- the user to ADD to the reference the Coach cites — no browse UI, no editor,
-- no non-corpus write path. This is the entry-level table that makes the
-- knowledge base a place you can write to, with the chunk table left exactly as
-- it was: still the retrieval unit, now fed from two owners instead of one.
--
-- ## Why an entry table and not new `source` values in knowledge_chunks
--
-- Four reasons, each individually sufficient:
--
--   1. ROUND-TRIPPING FAILS. `chunkText` (src/lib/rag/chunk.ts) whitespace-
--      normalizes and splits on sentence boundaries, so a long entry becomes N
--      rows with its paragraph structure destroyed. Browse and edit need the
--      authored document back VERBATIM; chunks-as-authoring-unit is lossy by
--      construction, and the loss is silent.
--   2. PROVENANCE IS PER-ENTRY. source_url, author, imported-at, archived-at
--      describe one document once — smearing them across every chunk row of
--      that document is duplication that can drift.
--   3. THE PACK CONTRACT STAYS CLEAN. `ingestCorpus`'s
--      `DELETE ... WHERE source = ?` is safe today only because exactly one
--      source exists. Separate ownership makes "a pack version bump can never
--      eat the user's own writing" STRUCTURAL rather than conventional.
--   4. THE PRECEDENT EXISTS. memory_chunks is already chunks-derived-from-an-
--      origin, replaced by origin on re-ingest. Entries mirror it exactly —
--      with one deliberate inversion, below.
--
-- Numbered 0035: the next free number above 0034 (recipe photo autoresolve).
-- NEVER renumber below a shipped version — the runner filters
-- `version > user_version` and would skip it SILENTLY (docs/project-status.md
-- "Known caveats"; 0005/0006/0010/0019/0022/0023 are permanently dead gaps).
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql: text PK NOT NULL holding an
-- app-generated id (src/lib/db/id.ts), enum vocabulary as text + CHECK, free
-- vocabulary as bare text, ISO-8601 UTC created_at/updated_at with an AFTER
-- UPDATE trigger (recursive_triggers stays OFF), no user_id (single user, one
-- device).
-- ============================================================================

CREATE TABLE knowledge_entries (
  id text PRIMARY KEY NOT NULL,
  -- What the entry is called. The reader sets this in serif — it is the one
  -- line that has to say what the doctrine is about.
  title text NOT NULL CHECK (length(trim(title)) > 0),
  -- Coarse category, matching knowledge_chunks.topic so the hub can group the
  -- user's entries and the pack's under the same headings.
  --
  -- FREE TEXT, vocabulary owned by data rather than by a CHECK — the
  -- wearable_data.metric_type / grocery-category precedent. The pack ships
  -- eight topics (cardiovascular, recovery, training, sleep, metabolic, method,
  -- supplements, lifestyle) and the editor offers those as chips, but a user
  -- who wants "dental" or "vision" must not need a migration to have one.
  topic text NOT NULL DEFAULT 'other',
  -- The document itself, as authored. Paragraph structure preserved — this is
  -- what the reader renders and what the editor loads back.
  body text NOT NULL CHECK (length(trim(body)) > 0),
  -- How it got here:
  --   user   — written in the editor (app/knowledge-entry-edit.tsx)
  --   import — extracted from an article/pasted text (src/lib/knowledge/import.ts)
  --   coach  — saved through the confirmation-gated `save_knowledge_entry` tool
  source text NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'import', 'coach')),
  -- Provenance, per document. All NULL for a hand-written entry.
  source_url text,        -- the article URL, shown as text and opened via Linking
  source_author text,     -- site name / byline
  source_note text,       -- model caveats, or "pasted text" provenance
  -- Soft delete (the coach_memories pattern): NULL = active. Archiving deletes
  -- the entry's CHUNKS but keeps this row, so retracted doctrine stops being
  -- retrievable while staying restorable. See the repository.
  archived_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The hub's read path is "active entries, most recently updated first", so
-- index exactly that. Partial on archived_at IS NULL, like coach_memories.
CREATE INDEX knowledge_entries_active_idx
  ON knowledge_entries (updated_at DESC) WHERE archived_at IS NULL;
CREATE INDEX knowledge_entries_topic_idx ON knowledge_entries (topic);

CREATE TRIGGER knowledge_entries_set_updated_at AFTER UPDATE ON knowledge_entries FOR EACH ROW BEGIN
  UPDATE knowledge_entries SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- knowledge_chunks.entry_id — which entry a derived chunk belongs to.
--
-- Forward-only ALTER (the 0013 precedent). SQLite's rules are satisfied: a
-- REFERENCES column added by ALTER must default to NULL, and it does — which is
-- also correct data, because every existing row is a PACK row and pack rows
-- carry no entry.
--
-- ON DELETE CASCADE is DELIBERATE and is the OPPOSITE of memory_chunks' FK-free
-- survival. A memory chunk is a snapshot of something that happened and
-- outlives its source row, because history persists. A knowledge chunk is a
-- fragment of a claim the user currently stands behind; when the entry is
-- deleted the claim is RETRACTED, and retracted doctrine must stop being
-- retrievable — by the Coach, by search, by anything. Cascade is what makes
-- that true even if a caller forgets to clean up.
--
-- (Vectors are not FK-reachable — vec_chunks is a vec0 virtual table that only
-- exists on device — so the repository deletes them by id BEFORE the cascade
-- fires. See deleteEntry in src/lib/db/repositories/knowledge.ts.)
--
-- ## The ownership invariant, which no CHECK can express here
--
-- SQLite's ALTER TABLE cannot add a CHECK constraint, so the two-owner split is
-- documented here and PINNED IN db/knowledge.test.mjs instead:
--
--   pack chunks   source = 'arc-longevity-v1'  entry_id IS NULL      pack_version NOT NULL
--   entry chunks  source = 'user-knowledge'    entry_id IS NOT NULL  pack_version IS NULL
--
-- That split is what makes `ingestCorpus`'s DELETE-by-source structurally
-- unable to touch user content: it deletes WHERE source = 'arc-longevity-v1',
-- and no entry chunk ever carries that source. The test proves it by bumping
-- the pack version, re-ingesting, and asserting the entry chunks come back
-- byte-identical.
--
-- `chunk_index` wrinkle, named so nobody "fixes" it: pack rows use it as
-- entry-position-within-the-pack (corpus.ts numbers the ten entries 0..9);
-- entry rows use it as passage-position-within-the-entry. Both satisfy 0025's
-- stated meaning, "0-based position of this passage within its source
-- document" — the pack and an entry are simply different documents.
-- ----------------------------------------------------------------------------
ALTER TABLE knowledge_chunks ADD COLUMN entry_id text
  REFERENCES knowledge_entries (id) ON DELETE CASCADE;

-- Replace-by-entry (edit, archive, delete) always selects by entry_id, and the
-- hub's provenance labelling joins on it. Index it.
CREATE INDEX knowledge_chunks_entry_idx ON knowledge_chunks (entry_id);
