# RAG & Embeddings Plan — on-device retrieval for the Coach

**Status:** PLAN (not built) — 2026-07-27
**Owner decision points flagged `⚑ MATT`.**

The Coach spec (`docs/ai-coach.md` §6, §2d) calls for RAG over two things: the user's own history (long-term memory — "deeply familiar with the user") and a curated longevity knowledge corpus (the `search_knowledge` tool). `op-sqlite` already ships with `sqlite-vec` compiled in (`package.json` → `"op-sqlite": { "sqliteVec": true }`), so the vector **index** is solved. What is not solved — and is a genuine architecture decision, not a coding task — is **where the embedding vectors come from.**

---

## 1. The problem in one sentence

**Anthropic has no embeddings API**, and ARC is local-first (nothing personal at rest in any cloud — the 2026-07-24 ADR), so the thing that turns text into vectors has to be chosen deliberately: it can't be "call the model provider," and for personal data it can't be "call a cloud embedder."

This is the same shape as the API-key and notifications work: the *logic* (chunk → embed → `sqlite-vec` ANN search → feed top-k to the Coach) is straightforward; the *dependency* (an embedding model that runs on the phone) is the real call.

---

## 2. The one constraint that dictates everything

**Queries and documents must be embedded by the SAME model.** Cosine similarity is only meaningful inside a single model's vector space — a query embedded by model A cannot search a corpus embedded by model B. Two consequences fall straight out of this:

1. **The query is always embedded on-device.** A user asks the Coach something; that question has to become a vector locally to search anything. So an on-device embedder is required no matter what — there is no design where embedding lives only in the cloud.
2. **Therefore the corpus must use the same on-device model.** Even though the curated corpus isn't personal and *could* be embedded anywhere, its vectors have to live in the same space as the on-device query vectors. So we pick **one** embedding model and use it for both — precomputing the corpus offline with that exact model, and running it live for queries + personal memory.

Everything below follows from "pick one on-device embedding model."

---

## 3. Choosing the embedding model — the real decision `⚑ MATT`

Three families, with the tradeoffs that matter for a decades-long, local-first, iOS-only app:

| Option | What it is | Bundle / runtime cost | Quality | Local-first fit |
|---|---|---|---|---|
| **A. Small transformer embedder, on-device** (recommended) | A compact sentence-embedding model (e.g. `bge-small-en-v1.5` ~33M/384-dim, `gte-small`, `snowflake-arctic-embed-s`, or Google's `EmbeddingGemma` ~300M, purpose-built for on-device) run via **ONNX Runtime** (`onnxruntime-react-native`) or a Core ML export | Ship a ~30–130 MB model asset; single-query embedding is fast (tens of ms), corpus embedding is batched at build time | Good→strong; modern small models are close to large ones on retrieval | ✅ Fully offline, nothing leaves the device |
| **B. Apple `NLEmbedding` (NaturalLanguage framework)** | iOS-native sentence embeddings, zero model to ship | No bundle weight, native only | Weaker than a dedicated transformer embedder; sentence-level support is limited/English-leaning | ✅ Offline, but a quality ceiling — good for a v0, not the decades answer |
| **C. Third-party embeddings API** (Voyage AI — Anthropic's recommended partner — or OpenAI `text-embedding-3-small`) | Cloud embedding call | No bundle weight; a network round-trip per embed | Best quality | ❌ **Sending user-history text to a cloud embedder breaks local-first.** Tolerable *only* for the non-personal corpus at build time — never for personal data or (health-revealing) queries |

**Recommendation: Option A — one small transformer embedder, on-device, via ONNX Runtime.** It's the only choice that satisfies local-first for *personal* data and gives durable quality. Concretely:

- **Model pick is a benchmark, not a guess `⚑ MATT`:** choose among the small-transformer candidates by measuring retrieval quality on a handful of *real ARC* queries against a draft corpus, weighed against bundle size and on-device latency. Bias toward the smallest model that clears a quality bar — a 384-dim `bge-small`/`gte-small` is the likely sweet spot; `EmbeddingGemma` if the quality gap justifies the size. Lock the model **and its dimension** before building the corpus (changing it later means re-embedding everything).
- **Stopgap worth considering:** Apple `NLEmbedding` (Option B) as a zero-asset v0 to prove the end-to-end pipeline (chunk → embed → search → cite) before committing bundle weight to Option A. Only if its quality is acceptable on real queries; otherwise skip straight to A.

---

## 4. Two corpora, one vector space

| Corpus | Personal? | Where embedded | Notes |
|---|---|---|---|
| **Curated longevity knowledge** (biomarker explainers, protocol rationale, mechanisms) | No | **Precomputed offline** with the chosen model (a build script running the same weights in Node/Python), shipped as vectors | Not personal → embedding it isn't a privacy event. Bundle the vectors, or ship a downloadable "knowledge pack" the app fetches once. Versioned so it can grow (`docs/ai-coach.md` "writable knowledge base"). |
| **User history / Coach memory** (day summaries, notes, past insights, protocol-version change notes, conversation turns) | **Yes** | **On-device**, as data is written or in a background pass | Never leaves the device. This is the "familiar with the user" half. |

Both are stored in `sqlite-vec` in the **same dimension**, so a single ANN query searches across knowledge + memory at once and the Coach can blend "what the evidence says" with "what's true for you."

---

## 5. Storage & schema (sqlite-vec)

- **Migration:** one new migration adds a `vec0` virtual table for the vectors plus a companion `knowledge_chunks` / `memory_chunks` table holding the chunk text + metadata (source, topic, date, origin row). **Reserve the next free migration number at build time — and it MUST be above the current max, never a lower gap.** The runner applies only migrations with `version > user_version` and skips lower numbers **silently** (no error, just missing tables at first use). As of 2026-07-29 main is at **0024** (wearables shipped 0021, labs shipped 0024, both past the once-reserved 0019 slot), so the RAG migration lands at **0025+**. The gaps 0005, 0006, 0010, 0019, 0022, 0023 are permanently dead — unfillable on any device that has already reached 0024. Confirm the max on `main` at integration and take the next number above it.
- **Dimension is fixed by the model pick** — the `vec0` table declares it (e.g. `embedding float[384]`), so §3's decision must precede this migration.
- Follows the repo DB conventions (text PKs via `newId`, `PRAGMA foreign_keys = ON`, ISO timestamps, `ON DELETE SET NULL` from a chunk back to its source log so history survives re-chunking). Validate headlessly — `node:sqlite` won't have the `vec0` extension, so the vector table's tests run on-device (like the `op-sqlite` `wrap()` adapter), while chunking/metadata logic stays headless-testable.

---

## 6. The Coach seam

`search_knowledge` (already named as a planned tool in `docs/ai-coach.md` §2d) becomes real and read-only:

1. Embed the query on-device (the chosen model).
2. ANN search `sqlite-vec` over knowledge + memory, top-k with a similarity floor.
3. Return the passages with citations (source + date) as the tool result.
4. The Coach cites them in-voice — same "ground every claim in a tool read, never fabricate" doctrine already enforced in `system-prompt.ts`.

Coach **long-term memory** is the same mechanism pointed at the user's own history: past insights and conversation turns get embedded so a later session can retrieve "we tried magnesium at 400 mg in March and your sleep score didn't move" without the user re-explaining. This is the `docs/ai-coach.md` "Vector DB for Coach long-term memory" item.

Chunking: ~200–400-token passages with metadata; user-history chunked by natural unit (a day, a note, a protocol version, a Coach insight), embedded on write or in a lightweight background pass so the write path stays fast.

---

## 7. Native dependency & the rebuild

`onnxruntime-react-native` (or an `executorch`/Core ML path) is a **native module → EAS rebuild**. **Batch it with the already-pending native deps** — `expo-secure-store` (Coach key), `expo-notifications` (reminder nudges), and `expo-local-authentication` (app lock) — into one dev build rather than spending a rebuild per feature. Until it ships, the RAG layer degrades exactly like the others: the `search_knowledge` tool reports "knowledge base not available yet" (an honest tool result the model can relay), never a crash.

---

## 8. Phasing

- **Phase A — pick the model `⚑ MATT`.** Draft ~30 real ARC queries + a small draft corpus; benchmark 2–3 candidate small embedders (plus `NLEmbedding` as the zero-asset baseline) on retrieval quality, size, and on-device latency. Lock model + dimension.
- **Phase B — build the corpus.** Curate the longevity knowledge, chunk it, precompute vectors offline with the locked model, version it, decide bundle-vs-download `⚑ MATT`.
- **Phase C — wire retrieval.** The migration + `sqlite-vec` tables, on-device query embedding, ANN search, and the real `search_knowledge` tool (behind the graceful "not available" fallback until the rebuild).
- **Phase D — Coach memory.** Embed user history/insights/conversations on-device; retrieve for cross-session continuity.

---

## 9. Decisions for Matt `⚑`

1. **Embedding model** — which small on-device embedder (size vs quality vs latency), decided by benchmark on real queries. Bias to the smallest that clears the bar. **This blocks everything else** (fixes the vector dimension).
2. **`NLEmbedding` v0?** — prove the pipeline with zero bundle weight first, or go straight to the ONNX model.
3. **Corpus delivery** — bundle the knowledge vectors in the app, or fetch a versioned pack on first run (keeps the binary smaller, lets the corpus grow without an app update).
4. **What counts as "memory"** — which user artifacts get embedded (all conversation turns? only insights + notes + protocol changes?). Affects index size and the "how much does the Coach remember" feel.

---

**Bottom line:** the blocker isn't `sqlite-vec` (done) or the retrieval code (straightforward) — it's committing to **one small on-device embedding model**, because that single choice fixes the vector space for both the curated corpus and the user's private memory. Pick it by benchmark, precompute the non-personal corpus offline with it, embed everything personal on-device, and the `search_knowledge` + Coach-memory features fall out. It's a native dep, so it rides the same EAS rebuild as the Keychain, notifications, and app-lock.
