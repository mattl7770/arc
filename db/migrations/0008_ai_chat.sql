-- ============================================================================
-- ARC 0008 — ai chat: ai_conversations + ai_messages
--
-- The Coach's conversation store (docs/ai-coach.md). A conversation is a
-- thread; a message is one turn in it. Messages are APPEND-ONLY — like
-- protocol_versions they are an immutable record (a chat turn is never edited,
-- only added), so they carry created_at but no updated_at and no trigger.
-- The conversation row is mutable (title, and its updated_at doubles as
-- "last activity" for picking the thread to resume).
--
-- tool_calls captures the agentic record of a turn: which tools the model
-- called, with what input, and what came back — json, because the shape is the
-- wire format's and evolves with the tool set, not a schema concern. NULL for
-- plain turns.
--
-- Numbered 0008 (renumbered from 0005 at integration to sit above Screenings 0007;
-- 0007+). Conventions per CLAUDE.md §9 / 0001_init.sql: app-generated v4 UUID
-- text ids (PRIMARY KEY NOT NULL, no default — src/lib/db/id.ts), ISO-8601 UTC
-- timestamps, enum vocabulary as text + CHECK, json as text + json_valid, FKs
-- rely on PRAGMA foreign_keys = ON (set per-connection by the client).
-- ============================================================================
CREATE TABLE ai_conversations (
  id text PRIMARY KEY NOT NULL,
  -- Nullable: a thread has no title until something worth titling happens
  -- (first user message, or a Coach-written summary later).
  title text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- "Most recently active thread" is the resume query.
CREATE INDEX ai_conversations_updated_idx ON ai_conversations (updated_at DESC);

CREATE TABLE ai_messages (
  id text PRIMARY KEY NOT NULL,
  -- Deleting a conversation deletes its turns — a message has no meaning
  -- outside its thread (same rationale as workout_sets).
  conversation_id text NOT NULL REFERENCES ai_conversations (id) ON DELETE CASCADE,
  -- The full wire vocabulary, wider than the two roles the UI renders today:
  -- 'system' and 'tool' exist so future transcript shapes aren't a migration.
  role text NOT NULL CHECK (role IN ('user', 'assistant', 'system', 'tool')),
  -- May be '' for a turn that was only tool activity; never NULL so ordering
  -- and rendering code doesn't juggle two empty shapes.
  content text NOT NULL,
  -- The turn's tool-call record (array of {id, name, input, result, isError}).
  -- NULL when the turn used no tools.
  tool_calls text CHECK (tool_calls IS NULL OR json_valid(tool_calls)),
  -- Append-only: created_at only, no updated_at, no trigger — the immutability
  -- IS the design, like protocol_versions.
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- The thread read: all messages of a conversation in insertion order.
CREATE INDEX ai_messages_conversation_idx ON ai_messages (conversation_id, created_at);

CREATE TRIGGER ai_conversations_set_updated_at
AFTER UPDATE ON ai_conversations FOR EACH ROW BEGIN
  UPDATE ai_conversations
  SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  WHERE id = NEW.id;
END;
