-- ============================================================================
-- ARC 0025 — RAG chunk stores (curated knowledge + on-device memory)
--
-- The text + metadata half of the Coach's retrieval layer (docs/rag-embeddings.md).
-- The VECTOR half — the `sqlite-vec` `vec0` virtual table `vec_chunks` — is NOT
-- created here: `vec0` is a runtime extension that only exists inside op-sqlite
-- on device (sqliteVec:true), and `node:sqlite` (which runs db:validate / every
-- headless suite) has no such module — a `CREATE VIRTUAL TABLE ... USING vec0`
-- here would throw "no such module: vec0" and break the whole test runner. So the
-- vector table is created lazily on-device by the RAG layer
-- (`ensureVectorTable`, `CREATE VIRTUAL TABLE IF NOT EXISTS`), guarded so it
-- no-ops where vec0 is absent. These two regular tables hold the chunk text and
-- rich metadata (FK-free provenance), joined back from a KNN hit by `id`.
--
-- Numbered 0025: the next free number ABOVE the current max (0024 labs). The
-- runner applies only `version > user_version` and SILENTLY skips a lower
-- number, so 0019 (the old RAG reservation) is dead — see CLAUDE.md / the
-- migration-numbering caveat. Conventions per CLAUDE.md §9 / 0001_init.sql:
-- app-generated v4 UUID text ids (PRIMARY KEY NOT NULL, no default), ISO-8601
-- UTC created_at/updated_at with an AFTER UPDATE trigger (recursive_triggers
-- stays OFF), enum vocabulary as text + CHECK, dates as YYYY-MM-DD text.
-- ============================================================================

-- Curated longevity knowledge (biomarker explainers, protocol rationale,
-- mechanisms). NON-personal — precomputed offline with the locked embedder and
-- shipped/downloaded as chunk text + vectors (the vectors land in vec_chunks on
-- device). One row per passage (see src/lib/rag/chunk.ts).
CREATE TABLE knowledge_chunks (
  id text PRIMARY KEY NOT NULL,
  -- Which knowledge pack / document this passage came from (also the vec0
  -- `source` filter value), and its versionable pack id for growth over time.
  source text NOT NULL,
  pack_version text,
  -- Human-facing provenance shown in a citation.
  title text,
  -- Coarse category for optional filtering ("cardiovascular", "sleep", …).
  topic text,
  -- The passage text, exactly as embedded (before the document prompt prefix,
  -- which is applied at embed time, not stored).
  body text NOT NULL,
  -- 0-based position of this passage within its source document.
  chunk_index integer NOT NULL DEFAULT 0,
  token_estimate integer,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX knowledge_chunks_source_idx ON knowledge_chunks (source);
CREATE INDEX knowledge_chunks_topic_idx ON knowledge_chunks (topic);

CREATE TRIGGER knowledge_chunks_set_updated_at AFTER UPDATE ON knowledge_chunks FOR EACH ROW BEGIN
  UPDATE knowledge_chunks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- The user's own history as Coach long-term memory (day summaries, notes, past
-- insights, protocol-version change notes, conversation turns). PERSONAL —
-- embedded on-device only, never leaves the phone.
--
-- Provenance (`origin_table` / `origin_id`) is deliberately FK-FREE: a memory
-- chunk can derive from any of several tables (daily_logs, symptoms,
-- protocol_versions, ai_messages…), which a single SQL FK can't express. A
-- memory chunk is a derived SNAPSHOT, so it intentionally SURVIVES deletion of
-- its source (history persists) — matching the plan's "history survives
-- re-chunking". Re-ingestion replaces a source's chunks by (origin_table,
-- origin_id) rather than relying on cascade.
CREATE TABLE memory_chunks (
  id text PRIMARY KEY NOT NULL,
  kind text NOT NULL CHECK (
    kind IN ('day', 'note', 'insight', 'protocol_version', 'conversation', 'symptom', 'other')
  ),
  origin_table text,
  origin_id text,
  -- The local calendar day this memory pertains to, for recency weighting /
  -- range filters. Nullable (some memories aren't date-anchored).
  ref_date text CHECK (ref_date IS NULL OR ref_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  body text NOT NULL,
  token_estimate integer,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX memory_chunks_kind_idx ON memory_chunks (kind);
CREATE INDEX memory_chunks_ref_date_idx ON memory_chunks (ref_date DESC);
CREATE INDEX memory_chunks_origin_idx ON memory_chunks (origin_table, origin_id);

CREATE TRIGGER memory_chunks_set_updated_at AFTER UPDATE ON memory_chunks FOR EACH ROW BEGIN
  UPDATE memory_chunks SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
