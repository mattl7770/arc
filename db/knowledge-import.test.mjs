/**
 * Headless test of the knowledge-import ladder (docs/knowledge-subapp.md §5) —
 * the pure halves: readable-text + Article provenance extraction over
 * real-page-shaped fixtures, the prompt contract, the defensive reply parse, and
 * the fetch rung with an injected fetch.
 *
 * The rule under test throughout is ANTI-FABRICATION. Every assertion about
 * `found:false`, about a too-thin body, and about the too-short-page guard is
 * the same rule from a different angle: when the source does not contain the
 * doctrine, the ladder says so and routes to paste. It never writes an entry
 * synthesized from a headline — and unlike a fabricated recipe, a fabricated
 * knowledge entry OUTRANKS ARC's own reference in the Coach's search.
 *
 * No network, no model, no database. Run: npm run db:test.
 */
import {
  attributionFrom,
  extractArticleMeta,
} from '../src/lib/knowledge/extract.ts';
import { pageTextForModel } from '../src/lib/html/readable.ts';
import {
  buildKnowledgeExtractionRequest,
  fetchArticle,
  KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT,
  KnowledgeFetchError,
  NoKnowledgeFoundError,
  normalizeArticleUrl,
  parseKnowledgeExtraction,
} from '../src/lib/knowledge/import.ts';

let pass = 0;
let fail = 0;
const ok = (n) => {
  pass++;
  console.log(`  ok   ${n}`);
};
const bad = (n, e) => {
  fail++;
  console.log(`  FAIL ${n}${e ? ' — ' + e : ''}`);
};

const throws = (fn, Type) => {
  try {
    fn();
    return false;
  } catch (e) {
    return Type ? e instanceof Type : true;
  }
};
const rejects = async (promise, Type) => {
  try {
    await promise;
    return false;
  } catch (e) {
    return Type ? e instanceof Type : true;
  }
};

// --- Fixtures: shaped like the pages these rungs actually meet ----------------

/** A publisher page: @graph JSON-LD, og tags, nav/footer furniture, scripts. */
const ARTICLE_PAGE = `<!DOCTYPE html><html><head>
<title>Rethinking ApoB targets | The Longevity Letter</title>
<meta property="og:site_name" content="The Longevity Letter">
<meta property="og:title" content="Rethinking ApoB targets">
<meta name="twitter:creator" content="@notthebyline">
<script type="application/ld+json">{ this is not json }</script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"WebSite","name":"The Longevity Letter"},
  {"@type":"NewsArticle","headline":"Rethinking ApoB targets",
   "author":{"@type":"Person","name":"Dr. ElenaВаsquez"},
   "datePublished":"2026-04-02"}
]}
</script>
<style>.nav{display:none}</style>
</head><body>
<nav><a href="/">Home</a><a href="/archive">Archive</a></nav>
<article>
<h1>Rethinking ApoB targets</h1>
<p>ApoB counts atherogenic particles directly &mdash; one per LDL, IDL, VLDL and Lp(a).</p>
<p>The author argues a target under 60&nbsp;mg/dL is defensible for primary prevention in
高-risk patients, while noting the outcome data is extrapolated rather than direct.</p>
<p>Discordance is the reason it matters: insulin-resistant patients carry many small,
cholesterol-poor particles, so LDL-C reads reassuring while particle count is high.</p>
</article>
<footer>&copy; 2026</footer>
<script>window.analytics = 1;</script>
</body></html>`;

/** A consent interstitial — the shape a paywalled/GDPR page returns. */
const CONSENT_WALL = `<!DOCTYPE html><html><head><title>Before you continue</title></head>
<body><div><h1>We value your privacy</h1><p>We and our 847 partners store cookies.</p>
<button>Accept all</button></div></body></html>`;

/** A page with no structured data at all — og/title fallback only. */
const BARE_PAGE = `<html><head><title>  Zone 2 and the mitochondria  </title>
<meta name="author" content='Sam O&#39;Neill'></head>
<body><p>${'Zone 2 is conversational intensity. '.repeat(30)}</p></body></html>`;

console.log('0. Article provenance — JSON-LD first, og/meta as the gap-filler');
{
  const meta = extractArticleMeta(ARTICLE_PAGE);
  meta.title === 'Rethinking ApoB targets'
    ? ok('headline read from the @graph NewsArticle node')
    : bad('headline', meta.title);
  meta.author === 'Dr. ElenaВаsquez'
    ? ok('author read from the nested author object')
    : bad('author', meta.author);
  meta.site === 'The Longevity Letter' ? ok('og:site_name read') : bad('site', meta.site);
  // The malformed ld+json block sits BEFORE the good one. A publisher shipping a
  // broken analytics blob must not cost the page its Article metadata.
  meta.title !== null
    ? ok('a malformed ld+json block does not hide a valid one after it')
    : bad('malformed block swallowed the good one');
  attributionFrom(meta) === 'Dr. Elena Васquez' || attributionFrom(meta) === meta.author
    ? ok('attribution prefers the byline over the publication')
    : bad('attribution', attributionFrom(meta));
}

{
  const meta = extractArticleMeta(BARE_PAGE);
  meta.title === 'Zone 2 and the mitochondria'
    ? ok('falls back to <title>, whitespace-collapsed')
    : bad('title fallback', meta.title);
  meta.author === "Sam O'Neill"
    ? ok('falls back to meta[name=author], entities decoded')
    : bad('author fallback', meta.author);
  attributionFrom(meta) === "Sam O'Neill"
    ? ok('attribution falls through to the byline it found')
    : bad('attribution fallback', attributionFrom(meta));
}

{
  const meta = extractArticleMeta(CONSENT_WALL);
  meta.author === null
    ? ok('a page with no byline yields null — never a fabricated attribution')
    : bad('invented an author', meta.author);
}

console.log('1. Readable text — furniture out, entities decoded, capped');
{
  const text = pageTextForModel(ARTICLE_PAGE);
  !text.includes('window.analytics') && !text.includes('display:none')
    ? ok('scripts and styles are stripped')
    : bad('script/style leaked into the model text');
  !text.includes('Archive') && !text.includes('© 2026')
    ? ok('nav and footer furniture are stripped')
    : bad('page furniture leaked');
  text.includes('ApoB counts atherogenic particles')
    ? ok('the article body survives')
    : bad('body did not survive');
  text.includes('—') && text.includes('60 mg/dL')
    ? ok('entities decoded (&mdash;, &nbsp;)')
    : bad('entities not decoded');
  pageTextForModel(ARTICLE_PAGE, 50).length === 50
    ? ok('capped at the caller’s limit — a 600 KB page never reaches a prompt')
    : bad('cap not applied');
}

console.log('2. URL normalization');
{
  normalizeArticleUrl('peterattiamd.com/apob') === 'https://peterattiamd.com/apob'
    ? ok('a bare host gets https://')
    : bad('scheme not added');
  normalizeArticleUrl('  https://x.com/a  ') === 'https://x.com/a'
    ? ok('trimmed, scheme preserved')
    : bad('trim/scheme');
  throws(() => normalizeArticleUrl(''), KnowledgeFetchError)
    ? ok('empty URL rejected')
    : bad('empty URL accepted');
  throws(() => normalizeArticleUrl('not a url'), KnowledgeFetchError)
    ? ok('a non-URL is rejected rather than fetched')
    : bad('non-URL accepted');
}

console.log('3. The fetch rung — single-shot, typed failures, honest degradation');
{
  const okFetch = async () => ({
    ok: true,
    status: 200,
    url: 'https://letter.example/apob',
    text: async () => ARTICLE_PAGE,
  });
  const article = await fetchArticle('letter.example/apob', okFetch);
  article.text.includes('ApoB counts') ? ok('fetch yields readable text') : bad('no text');
  article.title === 'Rethinking ApoB targets'
    ? ok('provenance prefilled from the page')
    : bad('provenance', article.title);
  article.url === 'https://letter.example/apob'
    ? ok('the final URL is what gets stored')
    : bad('final url', article.url);

  let calls = 0;
  await fetchArticle('letter.example/apob', async (...args) => {
    calls += 1;
    return okFetch(...args);
  });
  calls === 1
    ? ok('SINGLE-SHOT: exactly one request, per the 2026-08-12 ADR')
    : bad('more than one request', calls);

  const notFound = async () => ({ ok: false, status: 404, text: async () => '' });
  await rejects(fetchArticle('x.example/gone', notFound), KnowledgeFetchError)
    ? ok('404 → a typed fetch error')
    : bad('404 not typed');

  const refused = async () => ({ ok: false, status: 403, text: async () => '' });
  try {
    await fetchArticle('x.example/paywall', refused);
    bad('403 did not throw');
  } catch (e) {
    e.reason === 'blocked'
      ? ok("403 → reason 'blocked', which the UI routes to paste")
      : bad('403 reason', e.reason);
  }

  const wall = async () => ({ ok: true, status: 200, text: async () => CONSENT_WALL });
  try {
    await fetchArticle('x.example/consent', wall);
    bad('a consent wall was accepted as an article');
  } catch (e) {
    e.reason === 'no-content'
      ? ok("a consent wall → 'no-content', NOT a model turn over a cookie banner")
      : bad('consent wall reason', e.reason);
  }

  const dead = async () => {
    throw new Error('ENOTFOUND');
  };
  try {
    await fetchArticle('x.example/offline', dead);
    bad('a dead connection did not throw');
  } catch (e) {
    e.reason === 'offline' ? ok("connection failure → 'offline'") : bad('offline reason', e.reason);
  }

  // A user cancel must be rethrown raw, never relabelled as a network failure.
  const controller = new AbortController();
  controller.abort();
  try {
    await fetchArticle('x.example/a', okFetch, controller.signal);
    bad('an aborted signal still fetched');
  } catch (e) {
    !(e instanceof KnowledgeFetchError)
      ? ok('an already-cancelled import does not fetch, and is not reported as offline')
      : bad('cancel was relabelled as a fetch failure');
  }
}

console.log('4. The prompt contract');
{
  const p = KNOWLEDGE_EXTRACTION_SYSTEM_PROMPT;
  p.includes('NOTHING that is not in the source')
    ? ok('the nothing-not-in-the-source rule is stated')
    : bad('anti-padding rule missing');
  p.includes('"found": false')
    ? ok('the found:false contract is stated')
    : bad('found:false missing');
  p.includes('paywall stub') && p.includes('link farm')
    ? ok('the not-substantive cases are enumerated concretely')
    : bad('non-substantive cases missing');
  p.includes('Built from a title')
    ? ok('"never build from a title" is stated in the prohibitions')
    : bad('title-fabrication rule missing');
  ['cardiovascular', 'supplements', 'lifestyle', 'method'].every((t) => p.includes(t))
    ? ok('the existing topic vocabulary is listed for the model')
    : bad('topic vocabulary not listed');
  p.includes('ATTRIBUTED') && p.includes('hedging')
    ? ok('attribution + carry-the-hedging are stated (doctrine, not a book report)')
    : bad('voice rules missing');

  const req = buildKnowledgeExtractionRequest({ text: 'ARTICLE BODY', sourceNote: 'a test page' });
  req.system === p ? ok('the request carries that system prompt') : bad('system prompt not wired');
  req.messages[0].content[0].text.includes('Source: a test page')
    ? ok('the source note is carried into the turn')
    : bad('source note missing');
  req.messages[0].content[0].text.includes('ARTICLE BODY')
    ? ok('the text is carried into the turn')
    : bad('text missing');
}

console.log('5. The reply parse — defensive, and anti-fabrication both ways');
{
  const good = JSON.stringify({
    found: true,
    title: 'ApoB targets under 60',
    topic: 'Cardiovascular',
    body:
      'The author argues a target under 60 mg/dL is defensible for primary prevention, ' +
      'while noting the outcome data is extrapolated rather than direct. Discordance is the ' +
      'reason the marker matters at all.',
    source_title: 'Rethinking ApoB targets',
    source_author: 'Dr. Elena Vasquez',
    caveats: 'The dosage table was an image and is not captured.',
  });
  const parsed = parseKnowledgeExtraction('Here you go:\n```json\n' + good + '\n```\nHope that helps.');
  parsed.title === 'ApoB targets under 60'
    ? ok('parses through ``` fences and stray prose')
    : bad('fenced parse', parsed.title);
  parsed.topic === 'cardiovascular'
    ? ok('topic is lowercased to the column’s vocabulary')
    : bad('topic normalize', parsed.topic);
  parsed.caveats === 'The dosage table was an image and is not captured.'
    ? ok('caveats survive to source_note')
    : bad('caveats lost');

  throws(
    () => parseKnowledgeExtraction(JSON.stringify({ found: false, reason: 'It is a paywall stub.' })),
    NoKnowledgeFoundError
  )
    ? ok('found:false → NoKnowledgeFoundError (the UI routes to paste)')
    : bad('found:false not honoured');

  try {
    parseKnowledgeExtraction(JSON.stringify({ found: false, reason: 'It is a paywall stub.' }));
  } catch (e) {
    e.message === 'It is a paywall stub.'
      ? ok('the model’s own reason is what the user reads')
      : bad('reason not surfaced', e.message);
  }

  // The second half of anti-fabrication: a model that ignores found:false and
  // returns a two-line entry built from the headline must not get through.
  throws(
    () =>
      parseKnowledgeExtraction(
        JSON.stringify({ found: true, title: 'Rethinking ApoB targets', body: 'ApoB matters.' })
      ),
    NoKnowledgeFoundError
  )
    ? ok('a too-thin body is treated as not-found — a headline-shaped entry cannot slip past')
    : bad('a two-line entry was accepted');

  throws(
    () => parseKnowledgeExtraction(JSON.stringify({ found: true, body: 'x'.repeat(200) })),
    NoKnowledgeFoundError
  )
    ? ok('a missing title is not-found')
    : bad('missing title accepted');

  throws(() => parseKnowledgeExtraction('no json here at all'))
    ? ok('a reply with no JSON object throws')
    : bad('no-JSON accepted');
  throws(() => parseKnowledgeExtraction('{ "found": true, '))
    ? ok('malformed JSON throws')
    : bad('malformed JSON accepted');
  throws(() => parseKnowledgeExtraction('[1,2,3]'))
    ? ok('a JSON array is not a valid reply')
    : bad('array accepted');

  // Unknown fields drop; missing optionals become null rather than "undefined".
  const sparse = parseKnowledgeExtraction(
    JSON.stringify({ found: true, title: 'T', body: 'y'.repeat(200), nonsense: { a: 1 } })
  );
  sparse.source_author === null && sparse.caveats === null && sparse.topic === 'other'
    ? ok('missing optionals are null, unknown fields drop, topic defaults to "other"')
    : bad('sparse reply', JSON.stringify(sparse));
}

console.log('6. the draft handoff — why the manual floor does not use a route param');
{
  const { consumeKnowledgeDraft, resetKnowledgeDraft, stashKnowledgeDraft } = await import(
    '../src/lib/knowledge/draft-handoff.ts'
  );
  resetKnowledgeDraft();
  consumeKnowledgeDraft(0) === null ? ok('nothing stashed → null') : bad('phantom draft');

  // The payload this exists for: arbitrary article prose. A route param would
  // round-trip it through URL decoding, and the `%` here is not exotic — it is
  // what every article about a study contains.
  const ARTICLE = 'In the trial, 50% of patients improved. See https://x.example/a%20b for the table.';
  stashKnowledgeDraft(ARTICLE);
  consumeKnowledgeDraft(1000)?.body === ARTICLE
    ? ok('a body containing % and an encoded URL survives verbatim')
    : bad('handoff mangled the body', consumeKnowledgeDraft(1000));

  // React can run a screen's state initializer twice for one mount, and the
  // first run already cleared the store — without the replay window the user's
  // paste would vanish on the path they reach only after import failed them.
  consumeKnowledgeDraft(1500)?.body === ARTICLE
    ? ok('a second read inside the replay window returns the same text')
    : bad('replay window does not hold');
  consumeKnowledgeDraft(9000) === null
    ? ok('…and expires, so a later unrelated visit to the editor opens blank')
    : bad('stale draft leaked into a later mount');

  resetKnowledgeDraft();
  stashKnowledgeDraft('   \n  ');
  consumeKnowledgeDraft(0) === null
    ? ok('a whitespace-only stash is nothing, not an empty draft')
    : bad('whitespace stash returned a draft');

  // 2026-08-13 review fix: the spec's ladder table says the manual floor keeps
  // "URL into provenance". The handoff is where that either survives or dies.
  resetKnowledgeDraft();
  stashKnowledgeDraft(ARTICLE, ' https://x.example/piece ');
  const withUrl = consumeKnowledgeDraft(0);
  withUrl?.body === ARTICLE && withUrl?.sourceUrl === 'https://x.example/piece'
    ? ok('the URL rides the handoff, trimmed — the manual floor keeps provenance')
    : bad('URL dropped or mangled by the handoff', withUrl);
  stashKnowledgeDraft(ARTICLE);
  consumeKnowledgeDraft(0)?.sourceUrl === null
    ? ok('no URL stashed → sourceUrl is null, never undefined')
    : bad('sourceUrl shape drifted');
  resetKnowledgeDraft();
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
