# Architecture Migration — Cloud shell → Local-first, no-server

**Status:** Planned (not started) · **Decided:** 2026-07-24 · **ADR:** `docs/decisions.md` → "Local-first, single-user, no-server architecture"

This is the ordered plan to take ARC from its current cloud-Supabase shell to the local-first, server-less architecture the owner chose. Read the ADR first for the *why*; this doc is the *how*.

## The target, in one paragraph

Everything runs on the phone. Personal data lives in **on-device SQLite**; the Coach retrieves context with **`sqlite-vec`**; the model is called **directly from the app** with a user-supplied key in the **iOS Keychain**, swappable in Settings. The **knowledge base is on-device** and writable. Photos are **referenced from iOS Photos** or stored compressed. Backup is an **encrypted snapshot to iCloud**. No backend, no auth, no cloud personal data. Only recurring cost is model tokens (+ the $99/yr Apple membership any iOS app needs).

## The invariant

**The app builds and runs at the end of every phase.** No phase leaves `main` broken. Each phase is independently commit-able and reviewable on device.

## What survives untouched

The entire UI, the design system (Porcelain Ledger), the view-model types in `src/types/home.ts`, the Coach chat UX, and — crucially — **the schema itself**. We are porting the schema's *dialect*, not redesigning it. Table and column names stay identical, so screens and hooks barely move.

---

## Phase 0 — Foundations & schema port ✅ DONE (2026-07-24)

- [x] **Engine chosen and installed: `op-sqlite`** (`@op-engineering/op-sqlite` 17.1.2) — battle-tested native SQLite, first-class `sqlite-vec` support. Chosen over `expo-sqlite` for exactly that.
- [x] **`sqlite-vec` enabled** via `"op-sqlite": { "sqliteVec": true }` in package.json (flag confirmed against the podspec). Gives on-device vector search for the Coach's RAG; not exercised until Phase 3.
- [x] **Schema ported** → `db/migrations/0001_init.sql`, preserving every table/column name:
  - `enum` → `text` + `CHECK (col IN (...))`
  - `uuid` → `text`, **app-generated v4 UUIDs** from SQLite `randomblob` (`src/lib/db/id.ts` — Hermes has no `crypto` global, so not `crypto.randomUUID()`), no DB default, declared `PRIMARY KEY NOT NULL` so a missing id fails loud (SQLite's `PRIMARY KEY` alone permits NULLs on a text key — the `NOT NULL` is load-bearing)
  - `timestamptz` → ISO-8601 `text` · `date` → `text` `YYYY-MM-DD` · `time` → `text` `HH:MM` (GLOB `[0-9]`-checked; note GLOB `_` is literal, unlike LIKE)
  - `jsonb` → `text` guarded by `json_valid()`
  - Dropped RLS, `auth.*`, grants, `handle_new_user`, **and `user_id` entirely** — single user, so the composite `(id, user_id)` FKs collapse to simple ones and the `(user_id, x)` uniques/indexes lose the prefix. `updated_at` triggers kept (rewritten as per-table `AFTER UPDATE`).
  - Dropped the `~` regex CHECKs (slug, metric_type) — no portable regex in SQLite DDL; the repository layer owns that validation.
- [x] **Validated against real SQLite** (`npm run db:validate`, `node:sqlite`, **20 assertions**): schema executes, inserts across all 10 tables incl. the forward FK (`protocols.current_version_id`), `updated_at` triggers fire without recursion, enum/JSON/GLOB/range CHECKs reject bad data, ON DELETE SET NULL keeps log history / CASCADE drops parsed results, idempotency unique holds, NULL ids rejected, body-metric bounds hold. *(Two bugs caught & fixed in the process: (1) GLOB `_` is literal, not a wildcard — switched date/time checks to `[0-9]` classes; (2) a pre-Phase-1 audit found `id text PRIMARY KEY` silently permits NULL/multiple-NULL ids in SQLite — added `NOT NULL` to every id. Also restored the `numeric`-domain upper bounds on `body_metrics` that `numeric→real` had dropped.)*
- **Deferred to keep each dev rebuild meaningful** (all native modules): `expo-secure-store` (Phase 3), `expo-local-authentication` (Phase 2), photo libs (Phase 4). Batch them with the phase that first uses them.
- ⚠️ **`op-sqlite` is native** → a fresh `eas build` is required before Phase 1's data layer runs on device. The current dev client is unaffected (nothing imports op-sqlite yet).

## Phase 1 — Local data layer

- [ ] **Migration runner:** apply versioned SQL on app boot, tracked by SQLite's `PRAGMA user_version`. Idempotent, forward-only.
  - **Safety net (audit finding):** forward-only migrations have no rollback, and this is irreplaceable health data. Before applying any pending migration, **copy the DB file to a timestamped pre-migration backup** and restore it if the migration throws (wrap the batch in a transaction; keep the file copy as belt-and-braces since some DDL self-commits). Keep the last N pre-migration copies.
  - The runner **must not enable `recursive_triggers`** — the `updated_at` triggers rely on the default OFF (see the trigger note in `0001_init.sql`). Set `PRAGMA foreign_keys = ON` on every connection.
- [ ] **Data-access layer** (`src/lib/db/…`): typed repository functions (read/write per domain) replacing Supabase queries. Hand-authored TS types from the SQLite schema replace the generated `database.ts` (the old generator retires).
- [ ] Wire **Home** and **Coach** to read/write the local DB instead of mock data (`mock-day.ts` becomes a one-time seed, or a dev-only fallback).
- [ ] Seed the biomarker reference catalogue locally.

## Phase 2 — Remove the cloud

- [ ] Delete the Supabase client, `useSession`-as-gate, RLS assumptions, and `EXPO_PUBLIC_SUPABASE_*` env wiring.
- [ ] App opens directly to Home — optionally behind a **Face ID** unlock (`expo-local-authentication`). That biometric gate *is* the auth model now.
- [ ] Remove `@supabase/*` deps; prune `.env.example`.
- [ ] The live Supabase project is now unused (free tier) — owner may delete it whenever; nothing in the app depends on it.

## Phase 3 — The Coach goes real, on-device

- [ ] **Settings screen:** provider + model picker + API-key field. Key stored via `expo-secure-store` (Keychain), **never** in plain storage or `.env`.
- [ ] Rewrite `coach-service.ts`: swap the mock for a **direct streaming call** to the chosen provider with the stored key. Rename `isCoachBackendLive` → something like `isCoachKeyConfigured` (the gate is "has the user pasted a key", not "is a server up").
- [ ] **On-device RAG** with `sqlite-vec`: vector tables for (a) personal history and (b) the knowledge base. At query time the app retrieves relevant slices locally and assembles the prompt client-side.
  - **Sub-decision — embeddings source:** simplest is to embed via the provider's embedding endpoint at write time (cheap, needs network), store the vector locally. A fully-offline on-device embedding model is a later nicety, not a blocker.
  - **Embedding-space stability (audit finding):** vectors from different embedding models are incompatible (different dimensions and semantics), so *swapping the embedding model silently invalidates every stored vector*. Two consequences: (1) **store the embedding-model identity alongside each vector**, and on a change either block the swap or re-embed the whole (small, single-user) corpus and mark the index stale until done; (2) the **embedding provider is separate from the chat provider** — the chat model the user picks may have no embeddings endpoint at all (e.g. Anthropic), so Settings needs a distinct embedding provider/model/key, not one combined provider row. RAG quality depends on embedding-space stability, not just chat-model choice.
- [ ] Persist conversations to the local `ai_conversations` / `ai_messages` tables (their migration lands here, in SQLite).

## Phase 4 — Media & backup

- [ ] **Photos — split by keepsake vs. log data** (owner call, 2026-07-24):
  - **Progress pics → PhotoKit reference + thumbnail.** They belong in the camera roll at quality; iCloud Photos owns the original and backs it up, ARC stores only a reference. Keeps ARC's own footprint (and backup) tiny.
  - **Food photos → compressed in-app copy** (~1024px, HEIC, ~200 KB), *not* the camera roll (4/day would flood it). Just log data; can age out.
  - **Dangling-reference guard:** always keep a thumbnail as a degraded fallback if a referenced photo is deleted from Photos; let the user flag a pic "important" to force a full in-app copy.
  - **Restore reality (audit finding):** PhotoKit `localIdentifier`s are device-local and **do not survive restore-to-a-new-phone** — the exact scenario backup exists for. On a fresh install every reference dangles at once, degrading the *entire* progress-photo history to thumbnails. So store the stable **`PHCloudIdentifier`** (iCloud asset id) and re-link on restore, or keep full in-app copies for anything flagged important. Referencing is a footprint optimization that trades away full-fidelity restore for progress pics unless this is handled.
  - Storage consequence: in-app food copies ride inside ARC's encrypted backup (~3 GB/decade); referenced progress pics don't (already in iCloud Photos). This split is *why* the app's backup blob stays small.
- [ ] **Encrypted iCloud backup:** snapshot the SQLite file, encrypt it, write to the app's iCloud container. **Restore** flow on fresh install. The existing "data export" backlog item is the manual sibling of this.
  - **Backup-key custody — DECIDED 2026-07-25: user-recorded recovery phrase, envelope-encrypted** (ADR in `docs/decisions.md`). A stable random data key (DEK) encrypts the backup; the DEK is stored wrapped by a key derived from a one-time **recovery phrase** the user records at setup, and the wrapped DEK travels with the backup. Day-to-day the DEK sits in the Face-ID Keychain (no re-entry); the phrase is needed only at setup and at **restore on a new phone** (which therefore includes a phrase-entry / re-derive step). iCloud-Keychain sync is a deferred, optional convenience that envelope encryption makes additive later. The DEK never rotates (old backups stay decryptable) and is kept strictly separate from the model API key. Accepted risk: lose phone + phrase = unrecoverable (mitigated by the manual data export as a second escape hatch). Impl notes: KDF Argon2id (PBKDF2 fallback), AES-256-GCM; evaluate SQLCipher (op-sqlite supports it) to cover at-rest + backup with one scheme.
- [ ] Retention: keep hot recent data at full fidelity; downsample old high-res wearable samples so the DB stays lean.

## Phase 5 — Later (tracked, not now)

- [ ] **Writable knowledge base:** the user adds/edits entries, and the Coach does its own research to expand the corpus (see `project-status.md` §1).
- [ ] Predictive alerts · n-of-1 experiments · voice logging · vision analysis of food photos.

---

## Cross-cutting cleanup (do as touched, not in a big-bang)

- [x] **CLAUDE.md §2 / §3 / §8 / §9 / §10 / §11** updated (2026-07-24): principles gain local-first/offline; stack states on-device SQLite; wearables drop Terra for Apple Health; the DB conventions replace all the RLS/`auth.uid()`/`user_id` Postgres lore with SQLite ones; §11 points at `db/migrations/0001_init.sql` and this plan.
- [x] **`docs/project-status.md`** updated: migration-phase tracker, offline principle, status board reframed (Local DB / App lock / iCloud backup), Supabase marked vestigial.
- [x] **`docs/data-model.md`:** Implementation Status rewritten for the pivot (SQLite is the schema of record, hand-authored types, no `auth.users`/`user_id`/RLS); dialect mapping noted (2026-07-24 audit pass).
- [x] **`docs/folder-structure.md`:** relaid out for local-first — `db/` + `src/lib/db/`, `supabase/` marked origin/history, `login.tsx` gone, type-generation rule swapped (was missed by the original checklist; caught by the 2026-07-24 audit).
- [ ] Retire `scripts/gen-types.mjs` and `db:types` / `db:push` (Phase 2, with the Supabase removal).
- [ ] **`app.json` export-compliance flag (audit finding, low):** `ITSAppUsesNonExemptEncryption: false` is correct today, but the Phase 4 backup adds app-level encryption. Standard AES under a Keychain key usually stays exempt (Category 5 Part 2), but re-examine and document the classification at that submission rather than leaving the flag unexamined.

## Open sub-decisions

Decided:
- ✅ **DB engine:** `op-sqlite` + SQLite (the one irreversible choice — made & installed).
- ✅ **Photo storage:** the keepsake-vs-log split above (reference progress pics, compress food logs).

Still open (small, reversible, made at their phase):
- **Embedding source** (Phase 3): provider API at write-time vs an on-device model. *Lean: provider API to start* — new data still saves offline; only its RAG index waits for connectivity, and you can't query the Coach offline anyway.

Decided by the owner:
- ✅ **Backup-key custody** (2026-07-25): user-recorded **recovery phrase**, envelope-encrypted; iCloud-Keychain sync deferred as an optional add-on. See the ADR and the Phase 4 note above.

To verify early (the one irreversible bet):
- ⚠️ **`op-sqlite` + `sqlite-vec` have only been validated against `node:sqlite`, never compiled/run natively.** Confirm the native module builds and opens a DB in the first Phase-1 dev build, before much is built on it.
