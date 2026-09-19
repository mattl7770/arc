/**
 * Headless test of the recipe-import pipeline (docs/recipes-grocery.md §2c):
 * URL normalization, the pure extraction parsers (JSON-LD / Instagram og +
 * embed / TikTok oEmbed / YouTube watch page), the anti-fabrication extraction
 * parser, and the fetch ladder with an injected fake fetch. No network, no
 * model, no op-sqlite — fixtures are pinned payloads shaped like the
 * empirically verified real ones (2026-08-08). Run: npm run db:test.
 */
import { existsSync, readFileSync } from 'node:fs';

// expo-router's real route-tree builder — §10 drives it rather than asserting a
// string, so the A2 fix is proved by the library that had the bug.
import { getRoutes } from 'expo-router/build/getRoutes.js';

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
  buildRecipeExtractionRequest,
  buildVideoRail,
  fetchRecipeSource,
  importRecipe,
  instagramShortcode,
  NoRecipeFoundError,
  normalizeSourceUrl,
  parseRecipeExtraction,
  RECIPE_EXTRACTION_PROMPT_CEILING,
  RECIPE_EXTRACTION_SYSTEM_PROMPT,
  RecipeFetchError,
  RecipeImportUnavailableError,
  recipeSourceFromUrl,
  VIDEO_RAIL_CEILING,
} from '../src/lib/recipes/import.ts';
import { unheardAmountCount } from '../src/lib/recipes/ingredients.ts';
import { videoOutcomeMessage } from '../src/lib/recipes/video-outcome.ts';
import { longEdgeResize } from '../src/lib/media/photo-library.ts';
import {
  FRAME_BASE64_CAP,
  FRAME_EDGE,
  formatInterval,
  formatIntervalNumber,
  frameCountFor,
  frameOverCap,
  framesOutcome,
  frameTimesSeconds,
  intervalSeconds,
  isVideoImportAvailable,
  pickVideoFrames,
} from '../src/lib/media/video-frames.ts';
import { buildCoachSystemPrompt } from '../src/lib/ai/system-prompt.ts';
import {
  classifyRecipe,
  estimateServings,
  servingsEstimateBasis,
  servingsForReview,
  SERVING_GRAMS,
} from '../src/lib/recipes/servings.ts';
import {
  firstUrlIn,
  recipeImportShareFromPayloads,
  VIDEO_SHARE_MESSAGE,
} from '../src/lib/recipes/share-payload.ts';
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

// The embed page carries og tags of its own. It did not in the original
// fixture, which is how the rung's hardcoded `author: null, image_url: null`
// went unnoticed (A6).
const IG_EMBED = `<html><head>
<meta property="og:title" content="Flavors by Frangipane on Instagram" />
<meta property="og:image" content="https://scontent.cdninstagram.com/v/embed.jpg" />
</head><body><div class="Embed"><div class="Caption">
<a class="CaptionUsername" href="#">flavorsbyfrangipane</a>
Him: no protein?<br><br>Recipe<br>-2 tbsp oil<br>-2 garlic cloves<br>
<div class="CaptionComments"><a href="#">view comments</a></div>
</div></div></body></html>`;

const TIKTOK_OEMBED = JSON.stringify({
  version: '1.0',
  shareType: 'video',
  title: 'High protein pasta! 2 cups pasta, 1 lb chicken, parm #recipe #fyp',
  author_name: 'testcook',
  author_url: 'https://www.tiktok.com/@testcook',
  thumbnail_url: 'https://p16-sign.tiktokcdn-us.com/thumb.jpg',
  provider_name: 'TikTok',
});

const YT_WATCH = `<html><head>
<meta property="og:title" content="The only pancake recipe you need" />
<meta property="og:image" content="https://i.ytimg.com/vi/abc12345/maxresdefault.jpg" />
</head><body><script>var ytInitialPlayerResponse = {"videoDetails":{"videoId":"abc12345","shortDescription":"Full recipe below!\\n\\nIngredients:\\n- 2 cups flour\\n- 3 eggs\\n\\nMethod: mix and bake."}};</script></body></html>`;

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
  // A6: the rung used to hardcode `author: null, image_url: null` and throw
  // away the embed page's own og tags — on the exact path the shell-UA case
  // always lands on.
  if (
    source.kind === 'text' &&
    source.author === 'Flavors by Frangipane' &&
    source.image_url === 'https://scontent.cdninstagram.com/v/embed.jpg'
  ) {
    ok('the embed rung keeps the author and thumbnail its own page carries');
  } else bad('ig embed provenance', JSON.stringify(source).slice(0, 200));

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
  // A6: the video's own thumbnail, which this rung used to discard. The author
  // stays null on purpose — YouTube's og:title is the VIDEO title, and storing
  // that as `source_author` would be a confident wrong answer.
  if (
    source.kind === 'text' &&
    source.image_url === 'https://i.ytimg.com/vi/abc12345/maxresdefault.jpg' &&
    source.author === null
  ) {
    ok('the YouTube rung keeps og:image and refuses to guess an author');
  } else bad('youtube provenance', JSON.stringify(source).slice(0, 200));

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
      [{ value: 'https://www.instagram.com/reel/ABC123/', shareType: 'url' }],
      { kind: 'url', url: 'https://www.instagram.com/reel/ABC123/' },
    ],
    // Instagram often shares as TEXT containing the link.
    [
      [{ value: 'Check this recipe! https://vm.tiktok.com/ZMabc/ so good', shareType: 'text' }],
      { kind: 'url', url: 'https://vm.tiktok.com/ZMabc/' },
    ],
    // Bare recipe text → the paste rung, prefilled.
    [
      [{ value: 'Chili: 500g beef, 2 cans beans. Simmer.', shareType: 'text' }],
      { kind: 'text', text: 'Chili: 500g beef, 2 cans beans. Simmer.' },
    ],
    // A screenshot share → the vision rung.
    [
      [{ value: 'file:///tmp/screenshot.png', shareType: 'image' }],
      { kind: 'photo', uri: 'file:///tmp/screenshot.png' },
    ],
    // URL beats image when both arrive.
    [
      [
        { value: 'file:///tmp/thumb.jpg', shareType: 'image' },
        { value: 'https://example.com/r', shareType: 'url' },
      ],
      { kind: 'url', url: 'https://example.com/r' },
    ],
    // A movie alone → the video branch, which exists so the screen can say why.
    // Before it, this returned null and the screen said "nothing usable was
    // shared" (docs/spikes/video-recipe-import.md §1b).
    [
      [{ value: 'file:///tmp/reel.mov', shareType: 'video' }],
      { kind: 'video', uri: 'file:///tmp/reel.mov' },
    ],
    // …and it is LAST: a reel shared with its link still takes the rung that
    // works, so widening the share rule can never downgrade a working import.
    [
      [
        { value: 'file:///tmp/reel.mov', shareType: 'video' },
        { value: 'https://www.instagram.com/reel/XYZ/', shareType: 'url' },
      ],
      { kind: 'url', url: 'https://www.instagram.com/reel/XYZ/' },
    ],
    [
      [
        { value: 'file:///tmp/reel.mov', shareType: 'video' },
        { value: 'file:///tmp/shot.png', shareType: 'image' },
      ],
      { kind: 'photo', uri: 'file:///tmp/shot.png' },
    ],
    [[], null],
    [null, null],
    [[{ value: '   ', shareType: 'text' }], null],
  ];
  for (const [payloads, want] of cases) {
    const got = recipeImportShareFromPayloads(payloads);
    if (JSON.stringify(got) === JSON.stringify(want)) {
      ok(`${JSON.stringify(payloads)?.slice(0, 60)} → ${want ? want.kind : 'null'}`);
    } else bad(JSON.stringify(payloads)?.slice(0, 60), JSON.stringify(got));
  }
  if (firstUrlIn('no links here') === null) ok('firstUrlIn: none → null');
  else bad('firstUrlIn none');

  // The message is the whole point of the branch, so it is pinned: it must name
  // BOTH working paths, or a user holding a reel is told "no" and nothing else.
  if (
    /caption/i.test(VIDEO_SHARE_MESSAGE) &&
    /screenshot/i.test(VIDEO_SHARE_MESSAGE) &&
    VIDEO_SHARE_MESSAGE.trim() !== ''
  ) {
    ok('the video message names the caption and the screenshot rungs');
  } else bad('video message', VIDEO_SHARE_MESSAGE);

  // app.json is NOT widened by this fix (it needs a prebuild). The assertion
  // records the current state so the day the rule changes, this line changes
  // with it deliberately rather than drifting.
  {
    const rule =
      JSON.parse(readFileSync(new URL('../app.json', import.meta.url), 'utf8')).expo?.plugins?.find(
        (p) => Array.isArray(p) && p[0] === 'expo-sharing'
      )?.[1]?.ios?.activationRule ?? {};
    if (rule.supportsImageWithMaxCount === 1 && rule.supportsMovieWithMaxCount === undefined) {
      ok('the share rule still accepts images and not movies (a rebuild-scoped change)');
    } else bad('share activation rule', JSON.stringify(rule));
  }

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

// --- 9. A6: the link survives the rungs that don't fetch ----------------------

{
  console.log('9. recipeSourceFromUrl — provenance without a fetch');

  // The owner's path: a URL is shared, Instagram refuses the caption, he pastes
  // it instead. The recipe used to be saved with source_url NULL even though
  // the app was holding the link the whole time.
  const cases = [
    [
      'https://www.instagram.com/reel/DHOQJh3udh9/',
      { source_url: 'https://www.instagram.com/reel/DHOQJh3udh9/', source_platform: 'instagram' },
    ],
    [
      'youtu.be/abc12345',
      { source_url: 'https://www.youtube.com/watch?v=abc12345', source_platform: 'youtube' },
    ],
    [
      'https://www.tiktok.com/@cook/video/1',
      { source_url: 'https://www.tiktok.com/@cook/video/1', source_platform: 'tiktok' },
    ],
    [
      'https://seriouseats.com/x',
      { source_url: 'https://seriouseats.com/x', source_platform: 'website' },
    ],
    // Stories are a FETCH classification, not a platform: `instagram-stories`
    // would violate the 0031 CHECK, so it collapses to instagram.
    [
      'https://www.instagram.com/stories/chef/1/',
      { source_url: 'https://www.instagram.com/stories/chef/1/', source_platform: 'instagram' },
    ],
    // No provenance is a real answer, and must never fail an import.
    ['', null],
    ['   ', null],
    [null, null],
    [undefined, null],
    ['http://127.0.0.1/recipe', null], // the SSRF guard throws; that is "no provenance"
  ];
  for (const [input, want] of cases) {
    const got = recipeSourceFromUrl(input);
    if (JSON.stringify(got) === JSON.stringify(want)) {
      ok(`recipeSourceFromUrl(${JSON.stringify(input)}) → ${want ? want.source_platform : 'null'}`);
    } else bad(`recipeSourceFromUrl(${JSON.stringify(input)})`, JSON.stringify(got));
  }

  // Every platform it can return must be one the 0031 CHECK admits.
  const allowed = new Set(['instagram', 'tiktok', 'youtube', 'website']);
  const platforms = cases
    .map(([input]) => recipeSourceFromUrl(input)?.source_platform)
    .filter((p) => p !== undefined);
  platforms.length > 0 && platforms.every((p) => allowed.has(p))
    ? ok(`every platform returned (${platforms.length}) satisfies the recipes CHECK`)
    : bad('platform vocabulary', platforms.join(','));
}

// --- 10. A2: a deep-linked cold start has the tabs underneath ----------------

/**
 * The root layout must declare an ANCHOR, and this is asserted beside the
 * redirect above because the two together ARE the bug the owner reported as
 * *"after saving a recipe, sometimes the back button doesn't work"*.
 *
 * `redirectSystemPath` sends an `expo-sharing` delivery to `/recipe-import`.
 * On a COLD start that deep link is the whole root stack unless the layout names
 * an anchor — expo-router's `getLayoutNode` only defaults `initialRouteName` to
 * a child matching the layout's own group, and the root layout is in no group.
 * One route deep, `router.replace` after the save keeps it one route deep, and
 * `StackHeader`'s `router.back()` dispatches a GO_BACK that react-navigation
 * drops. The same taps work on a warm start, which is the whole of "sometimes".
 *
 * Read as source rather than imported: `app/_layout.tsx` pulls in global.css,
 * the app lock, the health sync and the backup scheduler, none of which loads
 * under node — and the anchor is a static export, so its declaration is exactly
 * what needs pinning.
 */
{
  console.log('10. The root layout anchors deep links on the tabs');

  // The declaration, read as source. `app/_layout.tsx` itself cannot be
  // imported here — it pulls in global.css, the app lock, the health sync and
  // the backup scheduler, none of which loads under node — but `unstable_settings`
  // is a static export, so the literal is exactly what needs reading.
  const layout = readFileSync(new URL('../app/_layout.tsx', import.meta.url), 'utf8');
  const declared = /export const unstable_settings\s*=\s*\{[^}]*\banchor\s*:\s*'([^']+)'/.exec(
    layout
  );
  declared
    ? ok(`app/_layout.tsx anchors the root stack on '${declared[1]}'`)
    : bad('app/_layout.tsx exports no unstable_settings anchor');
  const anchor = declared ? declared[1] : null;

  // The anchor must name a route that exists, or expo-router throws while it
  // builds the route tree.
  anchor && existsSync(new URL(`../app/${anchor}/_layout.tsx`, import.meta.url))
    ? ok(`the '${anchor}' anchor names a real route group`)
    : bad('the anchor names no route group', String(anchor));

  /**
   * And now the mechanism itself, through expo-router's OWN route-tree builder
   * rather than through a string match: a synthetic context shaped like ARC's
   * `app/` directory, built twice — once with the anchor this repo declares,
   * once without it.
   *
   * Without, `initialRouteName` is undefined, which is the bug: a cold-start
   * share deep-links to `/recipe-import`, and that route is then the whole root
   * stack. With, the tabs sit underneath and `router.back()` has somewhere to
   * land after the save's `router.replace`.
   */
  const routeTree = (settings) => {
    const files = {
      './_layout.tsx': settings
        ? { default: () => null, unstable_settings: settings }
        : { default: () => null },
      './(tabs)/_layout.tsx': { default: () => null },
      './(tabs)/index.tsx': { default: () => null },
      './recipe-import.tsx': { default: () => null },
      './recipe-detail.tsx': { default: () => null },
    };
    const ctx = (key) => files[key];
    ctx.keys = () => Object.keys(files);
    ctx.resolve = (key) => key;
    return getRoutes(ctx, { platform: 'ios' });
  };

  routeTree(null).initialRouteName === undefined
    ? ok('WITHOUT an anchor the root stack has no initial route — the shape the bug needed')
    : bad('the unanchored root stack already had an initial route');
  anchor && routeTree({ anchor }).initialRouteName === anchor
    ? ok(`WITH it, expo-router's own builder mounts '${anchor}' under every deep link`)
    : bad('anchor not applied by getRoutes', String(routeTree({ anchor }).initialRouteName));

  // And the redirect it protects still points at a screen that sits in that
  // stack, on the cold start specifically (`initial: true`).
  const tree = anchor ? routeTree({ anchor }) : routeTree(null);
  redirectSystemPath({ path: 'arc://expo-sharing', initial: true }) === '/recipe-import' &&
  tree.children.some((child) => child.route === 'recipe-import')
    ? ok('a cold-start share resolves to a real screen above the anchored tabs')
    : bad('cold-start share target');
}

// --- 11. Servings estimated from the quantities (C8) --------------------------

{
  console.log('11. estimateServings — the table, the floors, and the caption that wins');

  const eq = (name, actual, expected) =>
    actual === expected
      ? ok(name)
      : bad(name, `got ${JSON.stringify(actual)}, want ${JSON.stringify(expected)}`);

  // THE TABLE, pinned. It is ARC's own portion convention (not a citation), and
  // the point of pinning it here is that changing a row has to be a deliberate
  // act with a test diff attached — a portion size quietly drifting is a yield
  // quietly drifting on every import that follows.
  eq('main-course serving is 500 g (C8 names a 400–600 g band)', SERVING_GRAMS.main, 500);
  eq('a bowl of soup is 400 g', SERVING_GRAMS.soup, 400);
  eq('a side is 200 g', SERVING_GRAMS.side, 200);
  eq('a baked portion is 90 g', SERVING_GRAMS.baked, 90);
  eq('a condiment portion is 60 g', SERVING_GRAMS.sauce, 60);
  eq('a glass is 350 g', SERVING_GRAMS.drink, 350);

  // The kind is read off the title, most specific keyword first.
  eq('a soup is a soup', classifyRecipe('Chicken Noodle Soup'), 'soup');
  eq('…so is a chili', classifyRecipe('Weeknight Turkey Chili'), 'soup');
  eq('banana bread is baked, not a fruit', classifyRecipe('Banana Bread'), 'baked');
  eq('a smoothie is a glass', classifyRecipe('Green Breakfast Smoothie'), 'drink');
  eq('pesto is a condiment', classifyRecipe('Basil Pesto'), 'sauce');
  eq('a slaw is a side', classifyRecipe('Red Cabbage Slaw'), 'side');
  eq('anything unrecognised is a main', classifyRecipe('Chicken & Rice Bowl'), 'main');
  eq('…and the match is case-insensitive', classifyRecipe('LENTIL STEW'), 'soup');

  // The ordinary case: a weighed main. 800 + 500 + 400 = 1,700 g over three of
  // four lines; the tablespoon of soy sauce is volumetric and contributes
  // NOTHING, because this codebase has no density data and will not invent any.
  const mainLines = [
    { raw_text: '800 g chicken thighs' },
    { raw_text: '500 g white rice' },
    { raw_text: '400 g broccoli' },
    { raw_text: '2 tbsp soy sauce' },
  ];
  const main = estimateServings('Chicken & Rice Bowl', mainLines);
  if (!main) bad('a weighed main produced no estimate');
  else {
    eq('1,700 g of main course → 3 servings', main.servings, 3);
    eq('…built on the mass it could read', Math.round(main.totalGrams), 1700);
    eq('…from three of the four lines', main.linesCounted, 3);
    eq('…and it says so', main.linesTotal, 4);
    eq('…at the main-course portion', main.perServingG, 500);
  }

  // Mass units convert; volumetric and countable ones do not. 2 lb + 1 kg.
  const mixed = estimateServings('Beef and Potatoes', [
    { raw_text: '2 lb beef chuck' },
    { raw_text: '1 kg potatoes' },
    { raw_text: '3 cloves garlic' },
    { raw_text: '1 cup stock' },
  ]);
  eq('pounds and kilos both convert', mixed && Math.round(mixed.totalGrams), 1907);
  eq('…and that is 4 main-course servings', mixed && mixed.servings, 4);

  // An attached unit ("100g") parses too — parseIngredientLine handles it, and
  // this is the path a JSON-LD draft always takes (raw lines, no overlay).
  const attached = estimateServings('Flatbreads', [
    { raw_text: '500g strong flour' },
    { raw_text: '300g water' },
  ]);
  eq('an attached unit still weighs', attached && Math.round(attached.totalGrams), 800);

  // An overlay the extraction produced is preferred over re-parsing, so a model
  // that read "two hundred grams" as qty 200 / unit g is honoured.
  const overlaid = estimateServings('Braise', [
    { raw_text: 'two hundred grams of shallots', qty: 200, unit: 'g' },
    { raw_text: 'half a kilo of beef', qty: 0.5, unit: 'kg' },
  ]);
  eq('the extraction overlay is used when present', overlaid && overlaid.totalGrams, 700);

  // The same mass under a different title is a different yield — which is the
  // whole reason the kind is read at all. 1,800 g:
  const table = [
    { raw_text: '1000 g one' },
    { raw_text: '500 g two' },
    { raw_text: '300 g three' },
  ];
  eq('1,800 g as a main → 4', estimateServings('Braised Short Ribs', table)?.servings, 4);
  eq('…as a soup → 5', estimateServings('Short Rib Soup', table)?.servings, 5);
  eq('…as a bake → 20', estimateServings('Short Rib Pie', table)?.servings, 20);
  eq('…as a glass → 5', estimateServings('Short Rib Smoothie', table)?.servings, 5);
  // And the cap: 1,800 g of condiment is 30 portions, which is a number nobody
  // wants suggested. A mis-parsed quantity must not run away.
  eq('…as a sauce it hits the 24 cap', estimateServings('Short Rib Sauce', table)?.servings, 24);

  // THE FLOORS — each one turns a confident wrong number into an honest absence.
  eq(
    'one weighed line in four is not the recipe’s mass',
    estimateServings('Chickpea Curry', [
      { raw_text: '400 g chickpeas' },
      { raw_text: '2 tbsp curry paste' },
      { raw_text: '1 can coconut milk' },
      { raw_text: '2 cloves garlic' },
    ]),
    null
  );
  eq(
    'two weighed lines in six is still a minority — the estimate would read low',
    estimateServings('Big Curry', [
      { raw_text: '400 g chickpeas' },
      { raw_text: '400 g tomatoes' },
      { raw_text: '2 tbsp curry paste' },
      { raw_text: '1 can coconut milk' },
      { raw_text: '2 cloves garlic' },
      { raw_text: '1 bunch coriander' },
    ]),
    null
  );
  eq(
    'exactly half the lines weighed is enough',
    estimateServings('Half Curry', [
      { raw_text: '400 g chickpeas' },
      { raw_text: '400 g tomatoes' },
      { raw_text: '2 tbsp curry paste' },
      { raw_text: '2 cloves garlic' },
    ])?.servings,
    2
  );
  eq(
    'under 100 g in total is a spice blend, not a meal',
    estimateServings('House Rub', [{ raw_text: '50 g paprika' }, { raw_text: '20 g cumin' }]),
    null
  );
  eq('no lines at all, no estimate', estimateServings('Nothing', []), null);
  eq(
    'blank lines are not lines',
    estimateServings('Blanks', [{ raw_text: '   ' }, { raw_text: '' }]),
    null
  );
  eq(
    'a small recipe still yields at least one serving',
    estimateServings('Two-egg Omelette', [
      { raw_text: '120 g eggs' },
      { raw_text: '180 g mushrooms' },
    ])?.servings,
    1
  );

  // THE CAPTION WINS, and an estimate is NEVER pre-filled. This is the 0034
  // provenance rule for a column that has no provenance beside it: an inferred
  // number must not wear the face of one the user asserted.
  const estimate = estimateServings('Chicken & Rice Bowl', mainLines);
  const stated = servingsForReview(4, estimate);
  eq('a source that says "serves 4" wins outright', stated.value, 4);
  eq('…and the estimate is not even offered beside it', stated.estimate, null);

  const inferred = servingsForReview(null, estimate);
  eq('with no stated yield the field starts EMPTY, never pre-filled', inferred.value, null);
  inferred.estimate === estimate
    ? ok('…and the estimate is offered as a suggestion instead')
    : bad('the estimate was not offered');

  const neither = servingsForReview(null, null);
  eq('nothing stated and nothing estimable leaves the field empty', neither.value, null);
  eq('…with nothing to offer', neither.estimate, null);

  // A nonsense stated yield is not a yield.
  eq('a zero stated yield does not win', servingsForReview(0, estimate).estimate, estimate);

  // The basis sentence is what makes the suggestion checkable rather than
  // obeyable: every input it was built from appears in it.
  if (estimate) {
    const basis = servingsEstimateBasis(estimate);
    const says = (part) =>
      basis.includes(part)
        ? ok(`the basis states ${JSON.stringify(part)}`)
        : bad(`the basis omits ${JSON.stringify(part)}`, basis);
    says('1,700 g'); // the mass, with the hand-rolled comma (Hermes has no Intl)
    says('3 of 4 lines'); // the coverage — the direction of the error
    says('500 g'); // the portion size
    says('main-course'); // the dish shape it was read as
    says('cooks down'); // raw weights, not finished weights
    basis.includes('undefined') || basis.includes('NaN')
      ? bad('the basis sentence leaked an undefined', basis)
      : ok('…and nothing leaked into it');
    // Full coverage reads as "all N lines" rather than "4 of 4".
    const full = estimateServings('Flatbreads', [
      { raw_text: '500g strong flour' },
      { raw_text: '300g water' },
    ]);
    full && servingsEstimateBasis(full).includes('all 2 lines')
      ? ok('full coverage reads "all 2 lines", never "2 of 2"')
      : bad('full-coverage phrasing', full ? servingsEstimateBasis(full) : 'no estimate');
  }

  // …and the pipeline actually attaches it. The JSON-LD rung is the one that
  // runs with NO model at all, and its lines carry no overlay — so it is the
  // strictest check that the estimator parses raw text for itself.
  const jsonldDraft = (
    await fetchRecipeSource(
      'https://blog.example.com/adobo',
      fakeFetch([['blog.example.com', page(JSONLD_SIMPLE, 'https://blog.example.com/adobo')]])
    )
  ).draft;
  eq('the JSON-LD draft still carries the SOURCE’s stated yield', jsonldDraft.servings, 4);
  // One weighed line ("1 kg chicken thighs") out of three — below the floor, so
  // honestly nothing. The stated yield covers it, which is the ordinary case.
  eq('…and no estimate, because only one line is weighed', jsonldDraft.servings_estimate, null);
  eq(
    '…so the review shows the source’s 4',
    servingsForReview(jsonldDraft.servings, jsonldDraft.servings_estimate).value,
    4
  );
}

// --- 12. D1: the video-stills rung (rung 8) -----------------------------------

/**
 * docs/spikes/video-recipe-import-build.md §3.9, ten groups.
 *
 * Nothing here calls a model, opens a picker or decodes anything: the native
 * decoder is absent under Node, which is itself one of the assertions. What IS
 * pinned is every rule that decides what gets sent and what the user is told —
 * the sampling arithmetic, the request's block order, the rail's wording, the
 * two token ceilings, the parser's treatment of a missing amount, and the prose
 * for each way the rung can decline.
 */
{
  console.log('12. D1 — recipe import from a video’s stills');

  const proseTok = (s) => Math.round(s.length / 3.6);

  // 12.1 Sampling — how many stills, at what times, and the gap ACTUALLY got.
  console.log('   12.1 sampling');
  frameCountFor(15) === 4 && frameCountFor(45) === 10 && frameCountFor(180) === 10
    ? ok('frameCountFor: 15 s → 4 · 45 s → 10 · 3 min → 10 (adaptive under a cap)')
    : bad('frameCountFor', `${frameCountFor(15)}/${frameCountFor(45)}/${frameCountFor(180)}`);

  const times45 = frameTimesSeconds(45, 10);
  times45.length === 10 &&
  times45[0] === 0.5 &&
  Math.abs(times45[9] - 44.5) < 1e-9 &&
  times45.every((t) => t >= 0 && t <= 45)
    ? ok('frameTimesSeconds(45, 10): 0.5 … 44.5, every time inside the clip')
    : bad('frameTimesSeconds(45,10)', JSON.stringify(times45));
  frameTimesSeconds(0.4, 4).length === 0
    ? ok('…and a clip under MIN_DURATION_S yields no times at all (that is a screenshot)')
    : bad('short clip sampled', JSON.stringify(frameTimesSeconds(0.4, 4)));

  // Ten of ten: the reported interval IS the sampler's own gap.
  Math.abs(intervalSeconds(times45) - (times45[1] - times45[0])) < 1e-9 &&
  formatInterval(intervalSeconds(times45)) === '4.9 s'
    ? ok('intervalSeconds over all ten equals the gap between consecutive times → "4.9 s"')
    : bad('interval (full)', formatInterval(intervalSeconds(times45)));

  // Two frames dropped from the MIDDLE of that same reel. The asked-for gap was
  // still 4.9 s; the achieved one is 6.3 s, and printing 4.9 here would be the
  // app claiming a density it did not reach — the whole reason this is measured.
  const survivors = times45.filter((_, i) => i !== 3 && i !== 6);
  survivors.length === 8 &&
  Math.abs(intervalSeconds(survivors) - (times45[9] - times45[0]) / 7) < 1e-9 &&
  formatInterval(intervalSeconds(survivors)) === '6.3 s'
    ? ok('…and with two dropped it is the TRUE mean gap → "6.3 s", never "4.9 s"')
    : bad('interval (8 survivors)', formatInterval(intervalSeconds(survivors)));
  formatInterval(20) === '20 s' && formatIntervalNumber(4.888) === '4.9'
    ? ok('formatInterval: one decimal under ten seconds, whole seconds above')
    : bad('formatInterval', `${formatInterval(20)} / ${formatIntervalNumber(4.888)}`);

  // The cap binds — both times. A frame the single re-encode cannot bring under
  // it is DROPPED, and the still count falls with it.
  frameOverCap('x'.repeat(FRAME_BASE64_CAP + 1)) && !frameOverCap('x'.repeat(FRAME_BASE64_CAP))
    ? ok(`the payload cap binds at exactly ${FRAME_BASE64_CAP} base64 chars`)
    : bad('frameOverCap');
  {
    const dropped = framesOutcome(['a', 'b', 'c'], [survivors[0], survivors[1], survivors[2]], 45);
    dropped.kind === 'frames' && dropped.stillCount === 3
      ? ok('…and stillCount reports what survived, not what was asked for')
      : bad('stillCount after drops', JSON.stringify(dropped));
    framesOutcome(['only-one'], [0.5], 45).kind === 'no-frames'
      ? ok('one survivor is no-frames — a single still is the screenshot rung’s job')
      : bad('single survivor');
    framesOutcome([], [], 45).kind === 'no-frames'
      ? ok('…and none at all is no-frames too')
      : bad('zero survivors');
  }

  // 12.2 The request's shape: 2N + 1 blocks, images before the rail.
  console.log('   12.2 request shape');
  const framesInput = (n, caption = null) => ({
    kind: 'frames',
    framesBase64: Array.from({ length: n }, (_, i) => `BASE64_${i + 1}`),
    caption,
    stillCount: n,
    durationS: 45,
    everySeconds: 44 / 9,
  });
  {
    const req = buildRecipeExtractionRequest(framesInput(10));
    const blocks = req.messages[0].content;
    const labelled = blocks
      .slice(0, 20)
      .every((b, i) =>
        i % 2 === 0
          ? b.type === 'text' && b.text === `Image ${i / 2 + 1}:`
          : b.type === 'image' && b.source.data === `BASE64_${(i + 1) / 2}`
      );
    blocks.length === 21 && labelled && blocks[20].type === 'text'
      ? ok('10 frames, no caption → exactly 2N+1 blocks: "Image i:" then image, then the rail')
      : bad('frames block shape', `${blocks.length} blocks`);
    const rail = blocks[20].text;
    rail.includes('10 stills') && rail.includes('45-second') && rail.includes('every 4.9 seconds')
      ? ok('…and the rail names the count, the duration and the measured interval')
      : bad('rail substitution', rail.slice(0, 90));

    const withCaption = buildRecipeExtractionRequest(
      framesInput(4, 'Best miso butter pasta 🍝 full recipe below')
    ).messages[0].content;
    withCaption.length === 10 &&
    withCaption[9].type === 'text' &&
    withCaption[9].text.startsWith('Caption from the post:') &&
    withCaption[9].text.includes('miso butter pasta')
      ? ok('4 frames WITH a caption → 2N+2 blocks, the caption last')
      : bad('captioned block shape', `${withCaption.length} blocks`);
    // A caption that is only whitespace is not a caption.
    buildRecipeExtractionRequest(framesInput(4, '   ')).messages[0].content.length === 9
      ? ok('…and a blank caption adds no block')
      : bad('blank caption added a block');

    const textReq = buildRecipeExtractionRequest({ kind: 'text', text: 'x' });
    const photoReq = buildRecipeExtractionRequest({
      kind: 'photo',
      base64Jpeg: 'x',
      mediaType: 'image/jpeg',
    });
    req.system === textReq.system && req.system === photoReq.system
      ? ok('the system prompt is byte-identical across text, photo and frames')
      : bad('system prompt drifted between rungs');
  }

  // 12.3 What the rail actually says. Each clause answers a documented failure.
  console.log('   12.3 the rail’s wording');
  {
    const rail = buildVideoRail({ stillCount: 10, durationS: 45, everySeconds: 44 / 9 });
    const says = (needle, why) =>
      rail.toLowerCase().includes(needle.toLowerCase()) ? ok(why) : bad(why, needle);
    says('audio was not heard', 'the rail states the audio was not heard');
    says('leave them null', '…so a spoken amount is left null rather than supplied');
    says(
      'never infer one from a container',
      '…and an ingredient is never named from a jar (the labs no-fuzzy-match rule)'
    );
    says('more than one recipe', '…a multi-recipe reel extracts the first and notes the rest');
    says('found:false', '…and a plate-only video answers found:false');
  }

  // 12.4 The two ceilings — with floors, because a ceiling nothing reaches
  //      guards nothing (the nutrition-v2 vacuity guard, verbatim).
  console.log('   12.4 the prompt ceilings');
  {
    const promptTokens = proseTok(RECIPE_EXTRACTION_SYSTEM_PROMPT);
    promptTokens < RECIPE_EXTRACTION_PROMPT_CEILING &&
    promptTokens > RECIPE_EXTRACTION_PROMPT_CEILING * 0.6
      ? ok(
          `the extraction prompt fits its (new) ceiling — ~${promptTokens} tok < ${RECIPE_EXTRACTION_PROMPT_CEILING}`
        )
      : bad('extraction prompt budget', String(promptTokens));
    const railTokens = proseTok(
      buildVideoRail({ stillCount: 10, durationS: 45, everySeconds: 44 / 9 })
    );
    railTokens < VIDEO_RAIL_CEILING && railTokens > VIDEO_RAIL_CEILING * 0.6
      ? ok(`the video rail fits its own ceiling — ~${railTokens} tok < ${VIDEO_RAIL_CEILING}`)
      : bad('video rail budget', String(railTokens));
    !buildCoachSystemPrompt().includes(RECIPE_EXTRACTION_SYSTEM_PROMPT) &&
    !buildCoachSystemPrompt().includes(
      buildVideoRail({ stillCount: 10, durationS: 45, everySeconds: 44 / 9 })
    )
      ? ok('…and neither has leaked into the Coach’s cached prefix')
      : bad('a recipe prompt leaked into the Coach prefix');
  }

  // 12.5 Parsing a frames reply, and counting what the video could not hear.
  console.log('   12.5 the frames reply');
  try {
    parseRecipeExtraction('{"found": false, "reason": "These stills show a finished plate only."}');
    bad('plate-only found:false throws');
  } catch (e) {
    e instanceof NoRecipeFoundError && e.message.includes('finished plate')
      ? ok('a plate-only reel → NoRecipeFoundError carrying the model’s own reason')
      : bad('plate-only', String(e));
  }
  {
    // The narrated reel: names read off the screen, amounts only ever spoken.
    const narrated = parseRecipeExtraction(
      '{"found": true, "title": "Miso Butter Pasta",' +
        ' "ingredients": [{"raw": "miso paste", "qty": null, "unit": null, "name": "miso paste"},' +
        ' {"raw": "soy sauce, to taste", "qty": null, "unit": null, "name": "soy sauce"}],' +
        ' "steps": ["Melt the butter.", "Whisk in the miso."]}'
    );
    narrated.ingredients.length === 2 && narrated.ingredients.every((i) => i.qty === null)
      ? ok('a narrated reel’s lines keep qty null — never a plausible amount')
      : bad('narrated nulls', JSON.stringify(narrated.ingredients));
    unheardAmountCount(narrated.ingredients) === 2
      ? ok('…and unheardAmountCount counts both, which is what puts the caveat on the review')
      : bad('unheardAmountCount (narrated)', String(unheardAmountCount(narrated.ingredients)));

    // The overlay card: the model gave null, but its own raw line carries the
    // number it read off the screen — so the backfill wins and nothing is
    // flagged. A caveat over a line that visibly says "2 tbsp" would be a lie.
    const carded = parseRecipeExtraction(
      '{"found": true, "title": "Miso Butter Pasta",' +
        ' "ingredients": [{"raw": "2 tbsp miso", "qty": null, "unit": null, "name": "miso"}],' +
        ' "steps": ["Whisk."]}'
    );
    carded.ingredients[0].qty === 2
      ? ok('a raw line reading "2 tbsp miso" parses to qty 2 even when the model sent null')
      : bad('backfill', JSON.stringify(carded.ingredients[0]));
    unheardAmountCount(carded.ingredients) === 0
      ? ok('…so it is NOT counted as unheard, and no caveat is drawn over it')
      : bad('unheardAmountCount (carded)', String(unheardAmountCount(carded.ingredients)));
  }

  // The frames rung fetches NOTHING. It cannot run headless (no key, no
  // streaming fetch), so what is pinned is that it fails for that reason and
  // touches the network zero times on the way.
  {
    let fetches = 0;
    const counting = async () => {
      fetches++;
      return { ok: true, status: 200, text: async () => '' };
    };
    let thrown = null;
    try {
      await importRecipe(
        {
          kind: 'frames',
          framesBase64: ['A', 'B'],
          caption: null,
          stillCount: 2,
          durationS: 20,
          everySeconds: 9.5,
          sourceUrl: 'https://www.instagram.com/reel/DHOQJh3udh9/',
        },
        { fetchImpl: counting }
      );
    } catch (e) {
      thrown = e;
    }
    thrown instanceof RecipeImportUnavailableError && fetches === 0
      ? ok('the frames rung never fetches — with no key it is unavailable, and the network is idle')
      : bad('frames rung fetched or threw wrong', `${fetches} fetches, ${String(thrown)}`);
  }

  // 12.6 Share routing is untouched by this build (owner question 2 = (c)):
  //      §8 above still asserts the video branch AND that app.json admits no
  //      movie. Nothing is re-asserted here; the point is that nothing moved.

  // 12.7 The seam under Node — the current-binary state, and the honest degrade.
  console.log('   12.7 the decoder is absent here, and says so');
  {
    const outcome = await pickVideoFrames();
    !isVideoImportAvailable() && outcome.kind === 'unavailable'
      ? ok('without expo-video-thumbnails the seam reports unavailable and opens no picker')
      : bad('seam under node', JSON.stringify(outcome));
  }

  // 12.8 The arithmetic that makes 768 the right number.
  console.log('   12.8 what a still actually bills');
  {
    const patches = (w, h) => Math.ceil(w / 28) * Math.ceil(h / 28);
    const shape = (w, h, edge) => {
      const r = longEdgeResize(w, h, edge);
      return r.height != null
        ? { w: Math.round((w / h) * edge), h: edge }
        : { w: edge, h: Math.round((h / w) * edge) };
    };
    JSON.stringify(longEdgeResize(1080, 1920, FRAME_EDGE)) === JSON.stringify({ height: 768 })
      ? ok('a 9:16 frame is bounded by HEIGHT at 768 — the long edge, not the width')
      : bad('longEdgeResize on a reel frame');
    const reel = shape(1080, 1920, FRAME_EDGE);
    patches(reel.w, reel.h) === 448
      ? ok('…so 432×768 bills 448 visual tokens; ten of them ≈ 4.5k in')
      : bad('9:16 patches', String(patches(reel.w, reel.h)));
    const wide = shape(1920, 1080, FRAME_EDGE);
    patches(wide.w, wide.h) === 448
      ? ok('a 16:9 still bills the same 448 — the rule is orientation-blind')
      : bad('16:9 patches', String(patches(wide.w, wide.h)));
    const fourThree = shape(1200, 1600, FRAME_EDGE);
    patches(fourThree.w, fourThree.h) === 588
      ? ok('a 4:3 still bills 588')
      : bad('4:3 patches', String(patches(fourThree.w, fourThree.h)));
  }

  // 12.10 Every way the rung declines, and the words for it.
  console.log('   12.10 the degrade paths');
  {
    const rows = [
      [{ kind: 'unavailable' }, 'next app build'],
      [{ kind: 'failed' }, 'Couldn’t read that video'],
      [{ kind: 'no-frames' }, 'Couldn’t read that video'],
      [{ kind: 'too-long', durationS: 750 }, '12:30'],
      [{ kind: 'too-long', durationS: 330 }, '5:30'],
    ];
    for (const [outcome, needle] of rows) {
      const got = videoOutcomeMessage(outcome);
      got && got.suggestPaste === true && got.message.includes(needle)
        ? ok(
            `${outcome.kind}${outcome.durationS ? ` (${outcome.durationS}s)` : ''} → "${needle}", and the paste/screenshot rungs are offered`
          )
        : bad(`videoOutcomeMessage ${outcome.kind}`, JSON.stringify(got));
    }
    // Every message names BOTH rungs that still work — a dead end that only
    // says no is the failure this whole ladder exists to avoid.
    rows.every(([outcome]) => {
      const m = videoOutcomeMessage(outcome).message;
      return /screenshot/i.test(m) && /caption/i.test(m);
    })
      ? ok('…and every one of them names the screenshot and caption rungs')
      : bad('a video failure message named no way forward');
    videoOutcomeMessage({ kind: 'canceled' }) === null
      ? ok('a cancel maps to null — it is not an error and it is not a message')
      : bad('cancel produced prose');
    videoOutcomeMessage({
      kind: 'frames',
      framesBase64: [],
      stillCount: 0,
      durationS: 0,
      everySeconds: 0,
    }) === null
      ? ok('…and so does a success, which the caller handles itself')
      : bad('frames produced prose');
  }
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
