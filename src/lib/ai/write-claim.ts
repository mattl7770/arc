/**
 * Detecting a PHANTOM WRITE: the Coach saying it changed the record when no
 * write tool ran.
 *
 * ## The report
 *
 * Owner, 2026-08-14: *"Coach is still frequently thinking that it has done
 * something but not actually calling the tool - i.e. saying that a recipe has
 * been saved when the tool was not called and not actually saved."*
 *
 * This is the worst class of bug the app can have. Every other mistake the Coach
 * makes is visible in the moment; this one is invisible until the user goes
 * looking for a recipe that was never written, and by then it has retired the
 * credibility of everything else the Coach said. The turn record proves it
 * happens with no tool call at all: a reply of "Saved it. Chicken bowl is in
 * your recipe book now." settles as `end_turn` with `toolCalls: []`, which the
 * thread then renders identically to a turn that really wrote.
 *
 * ## What this module is, and what it is NOT
 *
 * It is the LOUD half of a two-part fix, and the weaker half on purpose.
 *
 * The structural half is the receipt (`CoachToolCall.receipt`, set in
 * coach-service.ts only after `tool.execute` returns): a receipt cannot exist
 * unless a tool ran, so prose alone can never manufacture one, and the thread
 * prints what the tool record says rather than what the sentence says. That
 * needs no text analysis and cannot be fooled.
 *
 * This module answers the residual question the receipt cannot: the user still
 * has to NOTICE a missing receipt. So when a turn lands zero writes and the
 * prose nonetheless claims one, the thread says so in words instead of leaving
 * an absence to be spotted.
 *
 * ## Why it is deliberately conservative
 *
 * A false positive is worse than a miss. A turn that merely OFFERED to save
 * something, wrongly captioned "nothing was saved", teaches the owner to ignore
 * the caption — and then the caption is worth nothing on the day it is right.
 * So every rule here demands a COMPLETED, FIRST-PERSON action, and three guards
 * throw a sentence out before any rule is tried. Under-firing is the accepted
 * failure mode; the receipt is what covers the gap.
 *
 * Note also that this only ever runs on turns that landed NO writes
 * (use-coach-chat.ts), so a turn that genuinely wrote is never examined and can
 * never be mislabelled.
 *
 * Pure — no database, no expo — so it is headless-tested in
 * db/coach-fidelity.test.mjs, and recomputed on thread load rather than stored
 * (the inputs, text and tool record, are both already persisted).
 */

/**
 * Sentence terminators, plus the two dividers the Coach's own voice uses to
 * join independent clauses. The VOICE section bans em dashes, but the model
 * still emits them and a banned character is exactly the one a claim would hide
 * behind ("Done — it is in your book"), so both are split on rather than
 * trusted to be absent.
 */
const SENTENCE_SPLIT = /[.!?\n;·—]+/;

/** Any negation at all voids the sentence: "I have not saved it" is honest. */
const NEGATION = /\b(?:not|never|cannot|unable|nothing|neither)\b|n['’]t\b/i;

/**
 * An offer or a question is a proposal, not a claim. This is the guard that
 * matters most: "Want me to save that?" and "I can add those" are the Coach
 * behaving correctly, and they share every verb with the failure case.
 */
const OFFER =
  /\b(?:want me to|shall i|should i|would you like|do you want|if you (?:want|like|prefer)|let me know|i can|i could|i will|i'?ll|happy to|ready to)\b/i;

/**
 * The USER did it, not the Coach. "You logged 178 lb yesterday" and "You have
 * not logged weight in 11 days" are read-grounded statements about their
 * behaviour and must never be read as the Coach claiming an action.
 */
const SECOND_PERSON_ACTOR =
  /\byou(?:['’]ve|['’]d| have| had| already)?\s+(?:just\s+|already\s+)?(?:saved|added|logged|created|updated|set|put|marked|started)\b/i;

/**
 * First person, completed. Every verb is past tense or a participle, which is
 * what excludes the entire future/offer family without needing to enumerate it:
 * "I'll save", "I can add" and "want me to log" have no past-tense form to
 * match. `set` is the one verb whose tense is ambiguous, and it is safe here
 * because an intervening modal ("I can set") breaks the adjacency this requires.
 */
const FIRST_PERSON_DONE =
  /\bi(?:['’]ve|\s+have|\s+just|\s+already)?\s+(?:just\s+|already\s+|now\s+)?(?:saved|added|logged|created|updated|scheduled|set|marked|removed|dismissed|completed|started|put)\b/i;

/**
 * A bare completed-action sentence: "Saved.", "Logged it.", "Done." The Coach
 * leads with the answer and is told to be terse, so this is its natural way of
 * reporting a write — and it carries no pronoun for the rule above to find.
 * Anchored at both ends so a sentence that merely BEGINS with one of these words
 * ("Logged meals this week total 12,000 kcal") cannot match.
 */
const BARE_DONE =
  /^(?:saved|added|logged|updated|created|scheduled|marked|dismissed|done)(?:\s+(?:it|that|them|those|both|all))?$/i;

/**
 * "Added milk to your grocery list." — sentence-initial verb with an explicit
 * destination. The `to your` is load-bearing: without it this would also match
 * "Saved recipes appear in your book", which is a read, not a write.
 */
const INITIAL_VERB_TO_STORE = /^(?:saved|added|logged|put|moved)\b.{0,60}?\bto your\b/i;

/**
 * Does `text` assert that the Coach already changed the user's record?
 *
 * Call it only for turns that landed no writes — see the module note.
 */
export function claimsCompletedWrite(text: string): boolean {
  for (const raw of text.split(SENTENCE_SPLIT)) {
    const sentence = raw.trim();
    if (sentence.length === 0) continue;

    // Guards first, and any one of them clears the sentence entirely. Order is
    // irrelevant to the result; it is written cheapest-first.
    if (NEGATION.test(sentence)) continue;
    if (OFFER.test(sentence)) continue;
    if (SECOND_PERSON_ACTOR.test(sentence)) continue;

    if (
      FIRST_PERSON_DONE.test(sentence) ||
      BARE_DONE.test(sentence) ||
      INITIAL_VERB_TO_STORE.test(sentence)
    ) {
      return true;
    }
  }
  return false;
}
