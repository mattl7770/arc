-- ============================================================================
-- ARC 0028 — coach memory: durable facts + a thread summary
--
-- The Coach's "deeply familiar with the user" pillar (CLAUDE.md §6) had no
-- storage: everything it learned lived in the last 30 messages of one thread
-- and then vanished. "Magnesium wrecks my gut", "trains fasted", "hates
-- burpees" were guaranteed forgotten. This is the fix docs/ai-coach.md §4.1
-- planned and the 2026-08-08 hostile review found missing
-- (docs/coach-intelligence-review.md §4 Phase 3).
--
-- Two things land here:
--
--   coach_memories — small, curated, USER-INSPECTABLE durable facts, injected
--   into every turn's context block. Deliberately not a vector store and not a
--   transcript: a short list a person can read in Settings and delete. The
--   RAG chunk tables (0025) remain the place for bulk semantic recall; this is
--   the handful of facts that must survive with no embedder involved.
--
--   ai_conversations.summary — a rolling précis of the turns that have aged out
--   of the model's context window, so a long thread degrades into a summary
--   instead of silently losing its early half.
--
-- Numbered 0028: next free above 0027. NEVER renumber below a shipped version —
-- the runner filters `version > user_version` and would skip it SILENTLY
-- (docs/project-status.md "Known caveats"; 0005/0006/0010/0019/0022/0023 are
-- permanently dead gaps).
--
-- Conventions per CLAUDE.md §9 / 0001_init.sql: text PK NOT NULL holding an
-- app-generated id (src/lib/db/id.ts), enum as text + CHECK, ISO-8601 UTC
-- created_at/updated_at with an AFTER UPDATE trigger (recursive_triggers stays
-- OFF), no user_id (single user, one device).
-- ============================================================================

CREATE TABLE coach_memories (
  id text PRIMARY KEY NOT NULL,
  -- The fact itself, in the Coach's own words, one sentence:
  -- "Trains fasted before 10:00 and prefers it that way."
  content text NOT NULL,
  -- What kind of durable fact this is — drives ordering and lets the user
  -- scan the list. Deliberately few and concrete:
  --   preference — how the user likes to operate ("trains fasted")
  --   constraint — a hard limit or adverse reaction ("magnesium citrate → GI")
  --   context    — stable life circumstance ("travels ~1 week/month")
  --   goal       — what they are working toward ("ApoB under 60 by spring")
  category text NOT NULL DEFAULT 'context' CHECK (
    category IN ('preference', 'constraint', 'context', 'goal')
  ),
  -- Where it came from, for the user's trust: 'coach' (proposed in a turn and
  -- approved at the confirmation gate) or 'user' (typed in Settings).
  source text NOT NULL DEFAULT 'coach' CHECK (source IN ('coach', 'user')),
  -- Soft delete: forgetting is auditable and reversible, and a "forget" the
  -- user approves should not silently vanish from history. NULL = active.
  -- Only active rows are injected into the prompt.
  archived_at text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  -- A memory with no content is a bug, not an empty note.
  CHECK (length(trim(content)) > 0)
);

-- The read path is always "active memories, newest first" (prompt injection +
-- the Settings list), so index exactly that.
CREATE INDEX coach_memories_active_idx
  ON coach_memories (created_at DESC) WHERE archived_at IS NULL;
CREATE INDEX coach_memories_category_idx ON coach_memories (category);

CREATE TRIGGER coach_memories_set_updated_at AFTER UPDATE ON coach_memories FOR EACH ROW BEGIN
  UPDATE coach_memories SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;

-- ----------------------------------------------------------------------------
-- ai_conversations.summary — what the model would otherwise forget.
--
-- The turn window is the last N messages; everything older is dropped. This
-- column carries a deterministic précis of the dropped turns (facts the user
-- stated, actions taken), prepended to the replayed history so a months-long
-- thread keeps its spine. NULL until a thread outgrows the window.
-- ----------------------------------------------------------------------------
ALTER TABLE ai_conversations ADD COLUMN summary text;
