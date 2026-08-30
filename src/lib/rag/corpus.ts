/**
 * The curated longevity knowledge pack — ARC's own reference corpus.
 *
 * CLAUDE.md §6 requires the Coach to be grounded in "curated longevity
 * knowledge", and until now that corpus had exactly zero entries: the RAG
 * tables existed, the retrieval path existed, and there was nothing in them to
 * retrieve. This is the content.
 *
 * It is deliberately SMALL and mechanism-focused. The model already knows the
 * literature far better than a few hundred lines could teach it; what it
 * cannot know is the interpretation ARC commits to — which marker ARC treats
 * as primary, what "optimal" means here versus a lab's reference range, and
 * where ARC deliberately refuses to be certain. That is what belongs in a
 * corpus the Coach cites: house doctrine, not a textbook.
 *
 * Every entry carries its own hedging. Nothing here states a target as a fact
 * about the user, and anything clinical says so.
 *
 * Ingestion is idempotent by content: re-running with an unchanged pack is a
 * no-op, and any edit (version, entry or body) replaces the pack rather than
 * duplicating it or keeping stale rows. Searchable by keyword TODAY via
 * search_history's sibling path; embeddable later without changing the content
 * (docs/rag-embeddings.md).
 */
import type { Database } from '@/lib/db/database';
import { deleteVectors, insertKnowledgeChunk } from '@/lib/db/repositories/rag';

/** Bump when the entries change — ingestion replaces a pack by version. */
export const CORPUS_VERSION = '1';
export const CORPUS_SOURCE = 'arc-longevity-v1';

export type CorpusEntry = { title: string; topic: string; body: string };

export const CORPUS: CorpusEntry[] = [
  {
    title: 'ApoB is ARC’s primary lipid marker',
    topic: 'cardiovascular',
    body: `ARC treats ApoB, not LDL-C, as the primary atherogenic marker. ApoB counts the number of atherogenic particles directly (one ApoB per LDL, IDL, VLDL and Lp(a) particle), while LDL-C measures the cholesterol carried inside them. The two disagree most in exactly the people who most need to know — insulin-resistant and hypertriglyceridaemic patients often carry many small, cholesterol-poor particles, so their LDL-C reads reassuring while particle count is high. When ARC has both, it leads with ApoB and mentions LDL-C only as context. Lp(a) is measured once in a lifetime unless something changes: it is ~90% genetically determined and is not modified by diet or exercise. Targets are a clinical decision that depends on overall risk — ARC surfaces where a value sits relative to longevity-oriented ranges, and defers the target itself to the user's physician.`,
  },
  {
    title: 'Reading HRV without over-reading it',
    topic: 'recovery',
    body: `Heart-rate variability is a noisy signal with a large between-person range, so only within-person comparisons mean anything: an absolute HRV of 40 ms is unremarkable for one person and alarming for another. Day-to-day coefficient of variation is commonly 5–15%, which is why ARC compares a multi-day average to a personal baseline rather than reacting to a single morning. HRV falls with acute training load, poor sleep, alcohol, illness, and psychological stress — the signal says "something taxed you", never which thing. Measurement conditions dominate: readings must be taken the same way each day (on waking, same posture, same device) or the noise swamps the signal. A single low morning is information, not an instruction; what it should change depends on why it happened.`,
  },
  {
    title: 'Zone 2 and VO₂max serve different purposes',
    topic: 'training',
    body: `VO₂max is among the strongest predictors of all-cause mortality in observational data, with the largest absolute gains found moving from the least-fit quartile to merely below-average. Zone 2 — conversational intensity, roughly the highest steady output before blood lactate begins to climb — builds mitochondrial density and fat oxidation, and is the base most protocols accumulate 150–180+ minutes a week of. It does not by itself maximally raise VO₂max; that responds to high-intensity work (classically 4×4 minute intervals near maximal aerobic output). The two are complements, not alternatives: Zone 2 builds the engine's capacity to sustain, intervals raise its ceiling. Volume of either is only useful if it is recoverable.`,
  },
  {
    title: 'Strength and muscle mass as a longevity intervention',
    topic: 'training',
    body: `Muscle mass, strength, and their proxies (grip strength, gait speed, sit-to-stand) track healthspan and predict mortality and fall risk in older adults. Sarcopenia begins decades before it becomes visible, so resistance training is a decades-long practice rather than a late intervention. Mechanical tension close to failure drives hypertrophy; total weekly hard sets per muscle group is the primary volume variable, with roughly 10–20 sets a week a common effective range (individual, and higher is not automatically better). Progressive overload requires the load or the reps to increase over time. Protein intake supports the adaptation — commonly 1.6–2.2 g/kg/day in the resistance-training literature, with older adults at the higher end because of anabolic resistance.`,
  },
  {
    title: 'Sleep is the highest-leverage recovery variable',
    topic: 'sleep',
    body: `Sleep duration below roughly 7 hours is associated with impaired glucose tolerance, higher blood pressure, lower testosterone, worse mood regulation, and reduced training adaptation; short sleep also degrades next-day HRV and raises resting heart rate. Timing regularity matters alongside duration — a consistent wake time anchors circadian rhythm more strongly than a consistent bedtime. The best-evidenced levers are morning daylight exposure, avoiding alcohol near bed (it fragments the second half of the night and reliably suppresses HRV), a cool dark room, and finishing caffeine early — caffeine's half-life of roughly 5–6 hours means an afternoon coffee is still substantially present at bedtime. Sleep-stage numbers from consumer wearables are far less reliable than total duration and timing; treat stage breakdowns as directional at best.`,
  },
  {
    title: 'Why ARC watches fasting insulin and triglyceride:HDL',
    topic: 'metabolic',
    body: `Fasting glucose and HbA1c move late: compensatory hyperinsulinaemia can hold glucose in the normal range for years while insulin resistance develops. Fasting insulin, HOMA-IR, and the triglyceride-to-HDL ratio are earlier signals, which is why ARC surfaces them rather than treating a normal glucose as reassurance. HbA1c is also distorted by anything that changes red-cell lifespan (anaemia, haemoglobin variants, recent blood loss), so it should not be read in isolation. Continuous glucose data is a behaviour-change tool more than a diagnostic one for a non-diabetic; a post-meal excursion is normal physiology, and its magnitude and duration matter more than any single peak. Interpretation of these markers is a clinical matter — ARC surfaces the pattern and defers diagnosis.`,
  },
  {
    title: 'What an n-of-1 experiment can and cannot tell you',
    topic: 'method',
    body: `A single-subject experiment can detect an effect that is large relative to your own day-to-day noise, and nothing smaller. If a metric varies 10% day to day, a 3% intervention effect is undetectable without far more data than a two-week trial provides. Change ONE thing at a time — two simultaneous changes produce an uninterpretable result. Run long enough to cover normal variation (typically 2–4 weeks per arm for daily metrics), and prefer a metric that is measured the same way every day. Regression to the mean is the most common false positive: people start interventions when they feel worst, so improvement is expected even from nothing. Adherence must be tracked, or "it did not work" cannot be distinguished from "it was not done". A null result is a real result and worth recording.`,
  },
  {
    title: 'Supplements: the small evidenced set, and the caveats',
    topic: 'supplements',
    body: `Most supplements have weak evidence for healthspan in already-replete people; the strongest cases are correction of a measured deficiency. Creatine monohydrate (~3–5 g/day) is among the best-evidenced for strength and lean mass, with growing cognitive interest. Vitamin D correction matters when a measured level is low; supplementing an already-sufficient level has not shown the benefits observational data suggested. Omega-3 (EPA/DHA) has reasonable evidence for triglycerides; cardiovascular-outcome trials are mixed and formulation-dependent. Magnesium deficiency is common and repletion is low-risk, though forms differ sharply in absorption and GI tolerance — citrate is notably laxative, glycinate generally better tolerated. Dose, timing, interactions, and anything prescription-adjacent are matters for a physician or pharmacist, not for the Coach to decide.`,
  },
  {
    title: 'How ARC treats "optimal" ranges',
    topic: 'method',
    body: `A laboratory reference range describes the middle 95% of a reference population — it is a statement about who else was tested, not about what is healthy. Many ranges are also age-adjusted in a way that normalises age-related decline. ARC therefore carries longevity-oriented ranges alongside standard ones where a defensible one exists, and shows both. Two rules follow. First, a value inside the standard range can still be worth acting on, and a value slightly outside it is often not an emergency — trajectory across draws usually matters more than a single crossing. Second, ARC does not diagnose: it shows where a value sits, how it has moved, and what the ranges are, and says plainly when something warrants a clinician. Single out-of-range results should be confirmed before acting, since assay and biological variability are real.`,
  },
  {
    title: 'Alcohol, and being honest about the evidence',
    topic: 'lifestyle',
    body: `The old J-curve suggesting light drinking is protective is largely explained by confounding — the abstainer comparison groups contained former drinkers who quit for health reasons. Analyses correcting for this, including Mendelian-randomisation work, find no cardioprotective threshold. Alcohol is a group-1 carcinogen with a dose-dependent relationship to several cancers, notably breast. For ARC's purposes the measurable effects are immediate and personal: alcohol reliably suppresses HRV and raises resting heart rate overnight, fragments the second half of sleep, and blunts next-day training quality — effects visible in a user's own wearable data within a night or two. That is the framing the Coach should use: not moralising, but the cost showing up in the user's own numbers, weighed against a night they may consider worth it.`,
  },
];

/**
 * Load (or reload) the curated pack so the shipped `CORPUS` is always the source
 * of truth. Idempotent, but keyed on actual CONTENT, not just a row count: an
 * identical pack (same version, entries and bodies, in order) is left alone,
 * while ANY drift — a version bump, an edited body, a changed count — replaces
 * the rows. Keying on count alone silently kept stale rows when a body was fixed
 * without bumping CORPUS_VERSION, so the correction never shipped.
 *
 * Vectors are NOT written here — chunk content persists without them by design
 * (0025), so the corpus is searchable by keyword now and can be backfilled
 * when the embedder ships. A replace still clears the OLD chunks' vectors first
 * (mirroring memory.ts), because re-inserted chunks get fresh ids: once a
 * backfill has embedded the corpus, skipping this would orphan the old vectors
 * in vec_chunks forever, and knnSearch would return ids that no longer resolve.
 *
 * Returns how many chunks the pack has after loading.
 */
export function ingestCorpus(db: Database): number {
  const existing = db.all<{ title: string | null; topic: string | null; body: string; pack_version: string | null }>(
    `SELECT title, topic, body, pack_version FROM knowledge_chunks WHERE source = ? ORDER BY chunk_index`,
    [CORPUS_SOURCE]
  );
  const upToDate =
    existing.length === CORPUS.length &&
    existing.every((row, i) => {
      const entry = CORPUS[i];
      return (
        entry !== undefined &&
        row.pack_version === CORPUS_VERSION &&
        row.title === entry.title &&
        row.topic === entry.topic &&
        row.body === entry.body
      );
    });
  if (upToDate) return existing.length;

  db.transaction(() => {
    // Replace any older version of THIS pack; other sources are untouched. Clear
    // the paired vectors first so a re-insert (fresh ids) never orphans them.
    const priorIds = db
      .all<{ id: string }>(`SELECT id FROM knowledge_chunks WHERE source = ?`, [CORPUS_SOURCE])
      .map((r) => r.id);
    deleteVectors(db, priorIds);
    db.run(`DELETE FROM knowledge_chunks WHERE source = ?`, [CORPUS_SOURCE]);
    CORPUS.forEach((entry, index) => {
      insertKnowledgeChunk(db, {
        source: CORPUS_SOURCE,
        packVersion: CORPUS_VERSION,
        title: entry.title,
        topic: entry.topic,
        body: entry.body,
        chunkIndex: index,
        // ~4 characters per token is close enough for a budget hint.
        tokenEstimate: Math.ceil(entry.body.length / 4),
      });
    });
  });
  return CORPUS.length;
}
