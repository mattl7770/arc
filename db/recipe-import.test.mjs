/**
 * Headless test of the recipe-import pipeline (docs/recipes-grocery.md §2c):
 * URL normalization, the pure extraction parsers (JSON-LD / Instagram og +
 * embed / TikTok oEmbed / YouTube watch page), the anti-fabrication extraction
 * parser, and the fetch ladder with an injected fake fetch. No network, no
 * model, no op-sqlite — fixtures are pinned payloads shaped like the
 * empirically verified real ones (2026-08-08). Run: npm run db:test.
 */
import {
  decodeHtmlEntities,
  extractInstagramCaption,
  extractInstagramEmbedCaption,
  extractJsonLdRecipe,
  extractOgImage,
  extractTikTokCaption,
  extractYouTubeDescription,
  isoDurationToMinutes,
  metaContent,
  pageTextForModel,
  parseYield,
} from '../src/lib/recipes/extract.ts';
import {
  fetchRecipeSource,
  instagramShortcode,
  NoRecipeFoundError,
  normalizeSourceUrl,
  parseRecipeExtraction,
  RecipeFetchError,
} from '../src/lib/recipes/import.ts';
import { firstUrlIn, recipeImportShareFromPayloads } from '../src/lib/recipes/share-payload.ts';
import {
  consumeIncomingShare,
  isIncomingShareAvailable,
} from '../src/lib/recipes/incoming-share.ts';
import { redirectSystemPath } from '../app/+native-intent.ts';

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

// --- Fixtures (pinned shapes, not live pages) ---------------------------------

const JSONLD_SIMPLE = `<!doctype html><html><head>
<script type="application/ld+json">
{"@context":"https://schema.org","@type":"Recipe","name":"Weeknight Chicken Adobo",
 "author":{"@type":"Person","name":"Test Chef"},
 "image":["https://example.com/adobo.jpg"],
 "recipeYield":"4 servings","prepTime":"PT15M","cookTime":"PT1H",
 "recipeIngredient":["1 kg chicken thighs","1/2 cup soy sauce","6 cloves garlic"],
 "recipeInstructions":[{"@type":"HowToStep","text":"Brown the chicken."},
   {"@type":"HowToStep","text":"Simmer 45 minutes."}]}
</script></head><body>blog prose</body></html>`;

const JSONLD_GRAPH = `<html><head>
<script type="application/ld+json">{ this is not valid json </script>
<script type="application/ld+json">
{"@context":"https://schema.org","@graph":[
  {"@type":"Article","headline":"My trip to Lisbon"},
  {"@type":["Recipe","Thing"],"name":"Grandma&#39;s Lentil Soup",
   "recipeYield":[6,"6 bowls"],"cookTime":"PT1H15M",
   "recipeIngredient":["2 cups lentils","1 onion, diced"],
   "recipeInstructions":[{"@type":"HowToSection","name":"Prep",
     "itemListElement":[{"@type":"HowToStep","text":"Rinse the lentils."}]},
    {"@type":"HowToSection","name":"Cook",
     "itemListElement":[{"@type":"HowToStep","text":"Simmer <b>75 minutes</b>."}]}]}
]}
</script></head><body></body></html>`;

const IG_OG = `<html><head>
<meta property="og:title" content="Flavors by Frangipane on Instagram: &quot;Him: &#x201C;No protein?&#x201D;&quot;" />
<meta property="og:description" content="200K likes, 1,614 comments - flavorsbyfrangipane on March 15, 2025: &quot;Him: &#x201C;No protein?&#x201D;

Recipe -2 tbsp oil -2 garlic cloves, minced -2 cups pasta
1. Heat the oil.
2. Add garlic.&quot;" />
<meta property="og:image" content="https://scontent.cdninstagram.com/v/test.jpg" />
</head><body></body></html>`;

const IG_SHELL = `<html><head><title>Instagram</title></head><body><script>window._sharedData={}</script></body></html>`;

const IG_EMBED = `<html><body><div class="Embed"><div class="Caption">
<a class="CaptionUsername" href="#">flavorsbyfrangipane</a>
Him: no protein?<br><br>Recipe<br>-2 tbsp oil<br>-2 garlic cloves<br>
<div class="CaptionComments"><a href="#">view comments</a></div>
</div></div></body></html>`;

const TIKTOK_OEMBED = JSON.stringify({
  version: '1.0',
  type: 'video',
  title: 'High protein pasta! 2 cups pasta, 1 lb chicken, parm #recipe #fyp',
  author_name: 'testcook',
  author_url: 'https://www.tiktok.com/@testcook',
  thumbnail_url: 'https://p16-sign.tiktokcdn-us.com/thumb.jpg',
  provider_name: 'TikTok',
});

const YT_WATCH = `<html><body><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc12345","shortDescription":"Full recipe below!\\n\\nIngredients:\\n- 2 cups flour\\n- 3 eggs\\n\\nMethod: mix and bake."}};</script></body></html>`;

const WEBSITE_PLAIN = `<html><head><meta property="og:image" content="https://example.com/hero.jpg"></head>
<body><nav>Home | About</nav><article><h1>Best pancakes</h1>
<p>These pancakes changed my life. Mix 2 cups flour with 3 eggs and a pinch of salt, then fry
in butter until golden. Serves 4 hungry people. My grandmother taught me this on a rainy
Tuesday and I have made them every weekend since.</p></article>
<footer>© test</footer></body></html>`;

// --- 1. URL normalization -----------------------------------------------------

{
  console.log('1. normalizeSourceUrl');
  const cases = [
    ['https://youtu.be/abc12345', 'https://www.youtube.com/watch?v=abc12345', 'youtube'],
    [
      'https://www.youtube.com/shorts/xyz98765',
      'https://www.youtube.com/watch?v=xyz98765',
      'youtube',
    ],
    [
      'https://www.youtube.com/watch?v=abc12345',
      'https://www.youtube.com/watch?v=abc12345',
      'youtube',
    ],
    [
      'www.instagram.com/reel/DHOQJh3udh9/',
      'https://www.instagram.com/reel/DHOQJh3udh9/',
      'instagram',
    ],
    [
      'https://www.instagram.com/stories/somechef/123456/',
      'https://www.instagram.com/stories/somechef/123456/',
      'instagram-stories',
    ],
    ['https://vm.tiktok.com/ZMabcdef/', 'https://vm.tiktok.com/ZMabcdef/', 'tiktok'],
    // Any *.tiktok.com host is TikTok — m.tiktok.com must not fall to the
    // website rung (bug-hunt 2026-08-08).
    [
      'https://m.tiktok.com/v/7301234567890.html',
      'https://m.tiktok.com/v/7301234567890.html',
      'tiktok',
    ],
    ['https://www.seriouseats.com/adobo', 'https://www.seriouseats.com/adobo', 'website'],
  ];
  for (const [input, wantUrl, wantPlatform] of cases) {
    const got = normalizeSourceUrl(input);
    if (got.url === wantUrl && got.platform === wantPlatform) ok(`${input} → ${wantPlatform}`);
    else bad(input, JSON.stringify(got));
  }
  try {
    normalizeSourceUrl('   ');
    bad('blank URL throws');
  } catch (e) {
    e instanceof RecipeFetchError ? ok('blank URL throws RecipeFetchError') : bad('blank URL type');
  }
  if (instagramShortcode('https://www.instagram.com/reel/DHOQJh3udh9/?igsh=x') === 'DHOQJh3udh9') {
    ok('shortcode parsed from reel URL');
  } else bad('shortcode');
}

// --- 2. Pure parsers ----------------------------------------------------------

{
  console.log('2. JSON-LD extraction');
  const simple = extractJsonLdRecipe(JSONLD_SIMPLE);
  if (
    simple &&
    simple.title === 'Weeknight Chicken Adobo' &&
    simple.ingredients.length === 3 &&
    simple.steps.length === 2 &&
    simple.servings === 4 &&
    simple.prep_min === 15 &&
    simple.cook_min === 60 &&
    simple.author === 'Test Chef' &&
    simple.image_url === 'https://example.com/adobo.jpg'
  ) {
    ok('simple Recipe object fully mapped');
  } else bad('simple recipe', JSON.stringify(simple));

  const graph = extractJsonLdRecipe(JSONLD_GRAPH);
  if (
    graph &&
    graph.title === "Grandma's Lentil Soup" &&
    graph.servings === 6 &&
    graph.cook_min === 75 &&
    graph.steps.length === 2 &&
    graph.steps[1] === 'Simmer 75 minutes.'
  ) {
    ok('@graph + @type-array + HowToSection + malformed sibling block handled');
  } else bad('graph recipe', JSON.stringify(graph));

  if (extractJsonLdRecipe('<html><body>no markup</body></html>') === null) {
    ok('no JSON-LD → null (ladder falls through)');
  } else bad('no jsonld');

  if (isoDurationToMinutes('PT1H15M') === 75 && isoDurationToMinutes('garbage') === null) {
    ok('ISO durations parsed, garbage rejected');
  } else bad('durations');
  if (parseYield('one 9-inch pie') === 9) ok('free-text yield takes its first number');
  else bad('yield', String(parseYield('one 9-inch pie')));
}

{
  console.log('3. Instagram parsers');
  const caption = extractInstagramCaption(IG_OG);
  if (caption && caption.startsWith('Him: “No protein?”') && caption.includes('-2 tbsp oil')) {
    ok('og:description → the quoted caption, entities decoded');
  } else bad('og caption', JSON.stringify(caption));
  if (extractInstagramCaption(IG_SHELL) === null) ok('JS shell → null (no og tags)');
  else bad('shell');
  const embed = extractInstagramEmbedCaption(IG_EMBED);
  if (embed && embed.includes('-2 tbsp oil') && !embed.includes('view comments')) {
    ok('embed-captioned parsed, comments excluded');
  } else bad('embed caption', JSON.stringify(embed));
  if (extractOgImage(IG_OG) === 'https://scontent.cdninstagram.com/v/test.jpg') {
    ok('og:image extracted');
  } else bad('og image');
  if (decodeHtmlEntities('&quot;1&#189;&quot; &amp; more') === '"1½" & more') {
    ok('entity decoding (named + numeric)');
  } else bad('entities', decodeHtmlEntities('&quot;1&#189;&quot; &amp; more'));
  // A raw apostrophe inside a double-quoted content attribute is legal HTML
  // and must not truncate the caption (bug-hunt 2026-08-08).
  const apos = extractInstagramCaption(
    `<html><head><meta property="og:description" content="93K likes, 12 comments - chef on August 1, 2026: &quot;Don't skip this! Recipe: 2 cups flour, 3 eggs&quot;" /></head></html>`
  );
  if (apos && apos.includes("Don't skip this!") && apos.includes('3 eggs')) {
    ok('raw apostrophe inside the attribute does not truncate the caption');
  } else bad('apostrophe caption', JSON.stringify(apos));
  if (metaContent('<meta content="x" property="og:description">', 'og:description') === 'x') {
    ok('meta attribute order tolerated');
  } else bad('meta order');
}

{
  console.log('4. TikTok + YouTube parsers');
  const tk = extractTikTokCaption(TIKTOK_OEMBED);
  if (tk && tk.caption.includes('2 cups pasta') && tk.author === 'testcook') {
    ok('oEmbed title is the caption; author carried');
  } else bad('tiktok', JSON.stringify(tk));
  if (extractTikTokCaption('{"no":"title"}') === null) ok('titleless oEmbed → null');
  else bad('tiktok null');
  const yt = extractYouTubeDescription(YT_WATCH);
  if (yt && yt.includes('- 2 cups flour') && yt.includes('Method: mix and bake.')) {
    ok('watch-page shortDescription unescaped');
  } else bad('youtube', JSON.stringify(yt));
  if (extractYouTubeDescription('<html>nothing</html>') === null) ok('missing description → null');
  else bad('youtube null');
}

{
  console.log('5. pageTextForModel');
  const text = pageTextForModel(WEBSITE_PLAIN);
  if (text.includes('Mix 2 cups flour') && !text.includes('Home | About') && !text.includes('©')) {
    ok('nav/footer stripped, prose kept');
  } else bad('page text', text.slice(0, 120));
  if (pageTextForModel('<p>' + 'x'.repeat(50000) + '</p>').length === 20000) {
    ok('size cap enforced (prompts stay bounded)');
  } else bad('cap');
}

// --- 6. The extraction parser (anti-fabrication) ------------------------------

{
  console.log('6. parseRecipeExtraction');
  const good = parseRecipeExtraction(`\`\`\`json
{"found": true, "title": "Garlic Pasta", "servings": 2, "prep_min": null, "cook_min": 20,
 "ingredients": [{"raw": "2 cups pasta", "qty": 2, "unit": "cup", "name": "pasta"},
   {"raw": "parmesan to taste", "qty": null, "unit": null, "name": "parmesan"}],
 "steps": ["Boil the pasta.", "Toss with garlic oil."], "notes": "Creator says use fresh garlic."}
\`\`\``);
  if (good.title === 'Garlic Pasta' && good.ingredients.length === 2 && good.steps.length === 2) {
    ok('fenced JSON parsed; nulls preserved');
  } else bad('good parse', JSON.stringify(good));
  if (good.ingredients[1].qty === null) ok('no-amount ingredient keeps qty null (never invented)');
  else bad('qty null');

  const bare = parseRecipeExtraction(
    '{"found": true, "title": "T", "ingredients": ["2 eggs", "1 cup milk"], "steps": []}'
  );
  if (bare.ingredients.length === 2 && bare.ingredients[0].qty === 2) {
    ok('bare-string ingredients tolerated, overlay parsed locally');
  } else bad('bare strings', JSON.stringify(bare.ingredients));

  try {
    parseRecipeExtraction('{"found": false, "reason": "The caption only names the dish."}');
    bad('found:false throws');
  } catch (e) {
    e instanceof NoRecipeFoundError && e.message.includes('names the dish')
      ? ok('found:false → NoRecipeFoundError with the model’s reason')
      : bad('found:false type', String(e));
  }
  try {
    parseRecipeExtraction('{"found": true, "title": "Empty", "ingredients": [], "steps": []}');
    bad('empty recipe throws');
  } catch (e) {
    e instanceof NoRecipeFoundError
      ? ok('a "found" reply with nothing in it is treated as not-found')
      : bad('empty type', String(e));
  }
  try {
    parseRecipeExtraction('no json here at all');
    bad('no JSON throws');
  } catch {
    ok('no JSON object → error');
  }
}

// --- 7. The fetch ladder (injected fake fetch) --------------------------------

const page = (body, url, status = 200) => ({
  ok: status >= 200 && status < 300,
  status,
  url,
  text: async () => body,
});

function fakeFetch(routes) {
  return async (url) => {
    for (const [pattern, responder] of routes) {
      if (url.includes(pattern))
        return typeof responder === 'function' ? responder(url) : responder;
    }
    throw new TypeError('Network request failed');
  };
}

{
  console.log('7. fetchRecipeSource — the ladder');

  // Rung 1: website with JSON-LD → deterministic draft, zero model involvement.
  let source = await fetchRecipeSource(
    'https://blog.example.com/adobo',
    fakeFetch([['blog.example.com', page(JSONLD_SIMPLE, 'https://blog.example.com/adobo')]])
  );
  if (
    source.kind === 'jsonld' &&
    source.draft.deterministic &&
    source.draft.title === 'Weeknight Chicken Adobo'
  ) {
    ok('website + JSON-LD → deterministic draft');
  } else bad('jsonld rung', JSON.stringify(source).slice(0, 200));

  // Rung 2: website without markup → page text for the model.
  source = await fetchRecipeSource(
    'https://plain.example.com/pancakes',
    fakeFetch([['plain.example.com', page(WEBSITE_PLAIN, 'https://plain.example.com/pancakes')]])
  );
  if (
    source.kind === 'text' &&
    source.text.includes('Mix 2 cups flour') &&
    source.image_url === 'https://example.com/hero.jpg'
  ) {
    ok('website w/o JSON-LD → capped page text + og:image');
  } else bad('text rung', JSON.stringify(source).slice(0, 200));

  // Rung 3: Instagram og path.
  source = await fetchRecipeSource(
    'https://www.instagram.com/reel/DHOQJh3udh9/',
    fakeFetch([['instagram.com/reel/', page(IG_OG, 'https://www.instagram.com/reel/DHOQJh3udh9/')]])
  );
  if (
    source.kind === 'text' &&
    source.text.includes('-2 tbsp oil') &&
    source.platform === 'instagram'
  ) {
    ok('instagram og:description rung');
  } else bad('ig og rung', JSON.stringify(source).slice(0, 200));

  // Rung 3b: shell → embed-captioned fallback.
  source = await fetchRecipeSource(
    'https://www.instagram.com/reel/DHOQJh3udh9/',
    fakeFetch([
      [
        '/embed/captioned',
        page(IG_EMBED, 'https://www.instagram.com/p/DHOQJh3udh9/embed/captioned/'),
      ],
      ['instagram.com/reel/', page(IG_SHELL, 'https://www.instagram.com/reel/DHOQJh3udh9/')],
    ])
  );
  if (source.kind === 'text' && source.text.includes('-2 tbsp oil')) {
    ok('shell page falls through to /embed/captioned/');
  } else bad('ig embed rung', JSON.stringify(source).slice(0, 200));

  // Rung 3c: both shells → typed blocked error.
  try {
    await fetchRecipeSource(
      'https://www.instagram.com/reel/DHOQJh3udh9/',
      fakeFetch([
        ['/embed/captioned', page(IG_SHELL, 'x')],
        ['instagram.com/reel/', page(IG_SHELL, 'y')],
      ])
    );
    bad('double shell throws');
  } catch (e) {
    e instanceof RecipeFetchError && e.reason === 'blocked'
      ? ok('login-wall shape → blocked (paste rung next)')
      : bad('blocked type', String(e));
  }

  // Rung 4: TikTok short link → redirect resolve → oEmbed.
  let oembedRequested = null;
  source = await fetchRecipeSource(
    'https://vm.tiktok.com/ZMabcdef/',
    fakeFetch([
      [
        'tiktok.com/oembed',
        (url) => {
          oembedRequested = url;
          return page(TIKTOK_OEMBED, url);
        },
      ],
      [
        'vm.tiktok.com',
        page('<html>redirected</html>', 'https://www.tiktok.com/@testcook/video/123'),
      ],
    ])
  );
  if (
    source.kind === 'text' &&
    source.text.includes('2 cups pasta') &&
    oembedRequested.includes(encodeURIComponent('https://www.tiktok.com/@testcook/video/123'))
  ) {
    ok('short link resolved via redirect, oEmbed on the canonical URL');
  } else bad('tiktok rung', `${oembedRequested}`);

  // tiktok.com/t/<code> (the current web-share shape) also resolves first.
  oembedRequested = null;
  source = await fetchRecipeSource(
    'https://www.tiktok.com/t/ZTabc123/',
    fakeFetch([
      [
        'tiktok.com/oembed',
        (url) => {
          oembedRequested = url;
          return page(TIKTOK_OEMBED, url);
        },
      ],
      [
        'tiktok.com/t/',
        page('<html>redirected</html>', 'https://www.tiktok.com/@testcook/video/456'),
      ],
    ])
  );
  if (oembedRequested.includes(encodeURIComponent('https://www.tiktok.com/@testcook/video/456'))) {
    ok('tiktok.com/t/ short link resolves before oEmbed');
  } else bad('tiktok /t/ rung', `${oembedRequested}`);

  // Rung 5: YouTube (a Short normalizes to the watch page first).
  source = await fetchRecipeSource(
    'https://www.youtube.com/shorts/abc12345',
    fakeFetch([['youtube.com/watch', page(YT_WATCH, 'https://www.youtube.com/watch?v=abc12345')]])
  );
  if (source.kind === 'text' && source.text.includes('- 2 cups flour')) {
    ok('Shorts URL → watch page → description');
  } else bad('youtube rung', JSON.stringify(source).slice(0, 200));

  // Failures: offline, 404, stories.
  try {
    await fetchRecipeSource('https://gone.example.com/x', fakeFetch([]));
    bad('offline throws');
  } catch (e) {
    e instanceof RecipeFetchError && e.reason === 'offline'
      ? ok('network failure → offline')
      : bad('offline type', String(e));
  }
  try {
    await fetchRecipeSource(
      'https://blog.example.com/missing',
      fakeFetch([['blog.example.com', page('', 'x', 404)]])
    );
    bad('404 throws');
  } catch (e) {
    e instanceof RecipeFetchError && e.reason === 'not-found'
      ? ok('404 → not-found')
      : bad('404 type', String(e));
  }
  try {
    await fetchRecipeSource('https://www.instagram.com/stories/chef/1/', fakeFetch([]));
    bad('stories throws');
  } catch (e) {
    e instanceof RecipeFetchError && e.reason === 'unfetchable'
      ? ok('Stories → unfetchable without any network attempt')
      : bad('stories type', String(e));
  }
}

// --- 8. Share-sheet delivery (Slice 4's code — the build-gated seam) ----------

{
  console.log('8. Share payloads → import input');
  const cases = [
    [
      [{ value: 'https://www.instagram.com/reel/ABC123/', type: 'url' }],
      { kind: 'url', url: 'https://www.instagram.com/reel/ABC123/' },
    ],
    // Instagram often shares as TEXT containing the link.
    [
      [{ value: 'Check this recipe! https://vm.tiktok.com/ZMabc/ so good', type: 'text' }],
      { kind: 'url', url: 'https://vm.tiktok.com/ZMabc/' },
    ],
    // Bare recipe text → the paste rung, prefilled.
    [
      [{ value: 'Chili: 500g beef, 2 cans beans. Simmer.', type: 'text' }],
      { kind: 'text', text: 'Chili: 500g beef, 2 cans beans. Simmer.' },
    ],
    // A screenshot share → the vision rung.
    [
      [{ value: 'file:///tmp/screenshot.png', type: 'image' }],
      { kind: 'photo', uri: 'file:///tmp/screenshot.png' },
    ],
    // URL beats image when both arrive.
    [
      [
        { value: 'file:///tmp/thumb.jpg', type: 'image' },
        { value: 'https://example.com/r', type: 'url' },
      ],
      { kind: 'url', url: 'https://example.com/r' },
    ],
    [[], null],
    [null, null],
    [[{ value: '   ', type: 'text' }], null],
  ];
  for (const [payloads, want] of cases) {
    const got = recipeImportShareFromPayloads(payloads);
    if (JSON.stringify(got) === JSON.stringify(want)) {
      ok(`${JSON.stringify(payloads)?.slice(0, 60)} → ${want ? want.kind : 'null'}`);
    } else bad(JSON.stringify(payloads)?.slice(0, 60), JSON.stringify(got));
  }
  if (firstUrlIn('no links here') === null) ok('firstUrlIn: none → null');
  else bad('firstUrlIn none');

  // Module-absent honesty: under node the expo-sharing require fails, so the
  // seam reports unavailable and consuming no-ops — the current-binary state.
  if (!isIncomingShareAvailable() && consumeIncomingShare() === null) {
    ok('without the native module the seam no-ops (current-binary behavior)');
  } else bad('module-absent seam');

  // The deep-link redirect: expo-sharing deliveries land on the import screen.
  if (
    redirectSystemPath({ path: 'arc://expo-sharing?x=1', initial: false }) === '/recipe-import' &&
    redirectSystemPath({ path: '/labs', initial: false }) === '/labs'
  ) {
    ok('+native-intent routes expo-sharing links to /recipe-import, others pass through');
  } else bad('native-intent redirect');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
