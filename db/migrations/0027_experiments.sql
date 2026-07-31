-- ============================================================================
-- ARC 0027 — n-of-1 experiments: the self-experimentation loop
--
-- The Coach designs a personal experiment (change one thing, watch specific
-- metrics for N days, decide if the hypothesis held) and reports the readout
-- (docs/ai-coach.md §6, data-model.md §experiments). This closes ARC's core
-- loop: "continuously improve protocols via n-of-1 experimentation".
--
-- Fields reconcile data-model.md's spec (title/hypothesis/dates/status/
-- protocol_changes/conclusion) with the create_experiment tool's contract
-- (intervention, metrics to watch, success criteria, duration). No `user_id`
-- (single-user, local-first — CLAUDE.md §9).
--
-- Numbered 0027: next free above the current max (0026 modes). Conventions per
-- CLAUDE.md §9 / 0001_init.sql: text PK NOT NULL app-generated id, YYYY-MM-DD
-- date text (GLOB-checked), enum as text + CHECK, JSON as text + json_valid
-- CHECK, ISO-8601 created_at/updated_at with an AFTER UPDATE trigger.
-- ============================================================================
CREATE TABLE experiments (
  id text PRIMARY KEY NOT NULL,
  title text NOT NULL,
  hypothesis text NOT NULL,
  -- The one thing being changed ("magnesium glycinate 400 mg at night").
  intervention text NOT NULL,
  -- JSON array of the metrics to watch ("HRV", "sleep score", "RHR"), free text
  -- so it isn't tied to the metric registry — the Coach reads the matching
  -- series (get_metric_series) when it writes the readout.
  metrics text NOT NULL CHECK (json_valid(metrics)),
  start_date text NOT NULL CHECK (start_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]'),
  -- Inclusive end (computed from start + duration at creation); never before start.
  end_date text NOT NULL CHECK (
    end_date GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND start_date <= end_date
  ),
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'completed', 'abandoned')),
  success_criteria text,
  -- Optional structured protocol edit the experiment applies, for later recall.
  protocol_changes text CHECK (protocol_changes IS NULL OR json_valid(protocol_changes)),
  -- The readout, written when it concludes: how the watched metrics moved.
  outcome_notes text,
  -- Did the hypothesis hold? (the one-line verdict)
  conclusion text,
  created_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  updated_at text NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

CREATE INDEX experiments_status_idx ON experiments (status);
CREATE INDEX experiments_end_idx ON experiments (end_date);

CREATE TRIGGER experiments_set_updated_at AFTER UPDATE ON experiments FOR EACH ROW BEGIN
  UPDATE experiments SET updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE id = NEW.id;
END;
