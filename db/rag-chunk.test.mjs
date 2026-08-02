/**
 * Headless test of the RAG chunker (src/lib/rag/chunk.ts) — pure text → passages,
 * no DB or native involved. The embedder + sqlite-vec halves of RAG are
 * device-only; this half is fully testable. Run: npm run db:test.
 */
import {
  chunkText,
  estimateTokens,
  DEFAULT_MAX_TOKENS,
  DEFAULT_TARGET_TOKENS,
} from '../src/lib/rag/chunk.ts';

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

const MAX_CHARS = DEFAULT_MAX_TOKENS * 4;

console.log('0. empty / whitespace input yields NO chunks (never an empty passage)');
{
  const cases = ['', '   ', '\n\n\t  \n'];
  cases.every((c) => chunkText(c).length === 0)
    ? ok('empty, spaces, and blank lines all produce zero chunks')
    : bad('empty handling', JSON.stringify(cases.map((c) => chunkText(c).length)));
}

console.log('1. short text is a single chunk, whitespace-normalized');
{
  const chunks = chunkText('  HRV   is a\n\nrecovery  signal. ');
  chunks.length === 1 && chunks[0].index === 0 && chunks[0].text === 'HRV is a recovery signal.'
    ? ok('one chunk, index 0, runs of whitespace collapsed')
    : bad('short chunk', JSON.stringify(chunks));
}

console.log('2. long multi-paragraph text splits into several capped passages');
{
  // ~40 sentences of ~60 chars → well past a single target passage.
  const sentence = 'ApoB is the number of atherogenic particles in the blood. ';
  const paras = [];
  for (let p = 0; p < 8; p++) paras.push(sentence.repeat(5).trim());
  const text = paras.join('\n\n');
  const chunks = chunkText(text);

  chunks.length > 1 ? ok(`splits into multiple passages (${chunks.length})`) : bad('did not split');
  chunks.every((c) => c.text.length <= MAX_CHARS)
    ? ok(`no passage exceeds the hard cap (${MAX_CHARS} chars)`)
    : bad('cap exceeded', JSON.stringify(chunks.map((c) => c.text.length)));
  chunks.every((c, i) => c.index === i)
    ? ok('indices are sequential from 0')
    : bad('indices', JSON.stringify(chunks.map((c) => c.index)));
  chunks.every((c) => c.text.trim().length > 0)
    ? ok('no empty passages')
    : bad('empty passage present');
  // Most passages should land near the target, not tiny.
  const targetChars = DEFAULT_TARGET_TOKENS * 4;
  chunks.slice(0, -1).every((c) => c.text.length >= targetChars * 0.5)
    ? ok('non-final passages are packed near the target (not fragmented)')
    : bad('under-packed', JSON.stringify(chunks.map((c) => c.text.length)));
}

console.log('3. a single over-long sentence is hard-split on character count');
{
  const giant = 'word '.repeat(600).trim(); // 3000 chars, no sentence breaks
  giant.length > MAX_CHARS ? ok(`fixture exceeds the cap (${giant.length} chars)`) : bad('fixture');
  const chunks = chunkText(giant);
  chunks.length > 1 && chunks.every((c) => c.text.length <= MAX_CHARS)
    ? ok('the unbroken sentence is split into capped pieces')
    : bad('long sentence', JSON.stringify(chunks.map((c) => c.text.length)));
}

console.log('4. overlapSentences repeats the boundary sentence across passages');
{
  const sentences = [];
  for (let i = 0; i < 30; i++) sentences.push(`Fact number ${i} about longevity and healthspan.`);
  const text = sentences.join(' ');
  const noOverlap = chunkText(text, { overlapSentences: 0 });
  const withOverlap = chunkText(text, { overlapSentences: 1 });

  noOverlap.length > 1 && withOverlap.length > 1
    ? ok('both variants produce multiple passages')
    : bad('overlap fixture too small');

  // The tail sentence of passage i should reappear at the head of passage i+1.
  let overlaps = true;
  for (let i = 0; i < withOverlap.length - 1; i++) {
    const prevTail = withOverlap[i].text.split(/(?<=\.)\s+/).pop();
    if (prevTail && !withOverlap[i + 1].text.startsWith(prevTail)) overlaps = false;
  }
  overlaps
    ? ok('each passage (after the first) begins with the prior passage’s last sentence')
    : bad('overlap not applied');
  // Overlap duplicates content, so it needs at least as many passages.
  withOverlap.length >= noOverlap.length
    ? ok('overlap does not reduce passage count')
    : bad('overlap count', `${withOverlap.length} < ${noOverlap.length}`);
}

console.log('5. overlap respects the hard cap and never repeats a whole passage');
{
  // Exact-length sentences (one terminator, no whitespace runs to normalize
  // away) so the packing maths is reproducible rather than approximate.
  const sentence = (chars, tag) => {
    const head = `Fact ${tag} `;
    return head + 'x'.repeat(chars - head.length - 1) + '.';
  };
  const run = (n, chars) => Array.from({ length: n }, (_, i) => sentence(chars, i)).join(' ');

  const cases = [
    // Overlap carried the WHOLE previous passage (slice(-2) of a 1-2 sentence
    // array), so each passage restated its predecessor and grew past the cap.
    { name: '6×700-char sentences, overlap 2', text: run(6, 700), opts: { overlapSentences: 2 } },
    { name: '4×1500-char sentences, overlap 2', text: run(4, 1500), opts: { overlapSentences: 2 } },
    // Overlap 1 is legal here (3 sentences precede), but the carried 500-char
    // tail plus a 1199-char sentence is 1700 chars against the 1600 cap.
    {
      name: '300/300/500 then a 1199-char sentence, overlap 1',
      text: [sentence(300, 'a'), sentence(300, 'b'), sentence(500, 'c'), sentence(1199, 'd')].join(
        ' '
      ),
      opts: { overlapSentences: 1 },
    },
  ];

  const overCap = [];
  const supersets = [];
  const unsplit = [];
  for (const c of cases) {
    const chunks = chunkText(c.text, c.opts);
    if (chunks.length < 2) unsplit.push(c.name);
    const lengths = chunks.map((k) => k.text.length);
    if (lengths.some((l) => l > MAX_CHARS)) overCap.push(`${c.name} → ${lengths.join('/')}`);
    if (chunks.some((k, i) => i > 0 && k.text.includes(chunks[i - 1].text))) supersets.push(c.name);
  }
  unsplit.length === 0 ? ok('every overlap fixture splits') : bad('fixture', unsplit.join(' | '));
  overCap.length === 0
    ? ok(`overlap passages stay within the hard cap (${MAX_CHARS} chars)`)
    : bad('overlap breaches the cap', overCap.join(' | '));
  supersets.length === 0
    ? ok('no passage restates its predecessor whole (forward progress guaranteed)')
    : bad('overlap superset', supersets.join(' | '));

  // The shipping default path must be untouched by the clamp/trim above.
  const plain = run(6, 700);
  JSON.stringify(chunkText(plain)) === JSON.stringify(chunkText(plain, { overlapSentences: 0 }))
    ? ok('overlapSentences 0 is byte-identical to the default')
    : bad('default path changed');
}

console.log('6. estimateTokens is chars/4, rounded up, never negative');
{
  estimateTokens('') === 0 &&
  estimateTokens('abcd') === 1 &&
  estimateTokens('abcde') === 2 &&
  estimateTokens('a'.repeat(400)) === 100
    ? ok('token estimate matches the chars/4 proxy')
    : bad('estimateTokens');
}

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
