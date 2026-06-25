// R0/R4 eval scorer (opt-in, CI-excluded). Pure Node: reads the committed golden
// Copy-for-AI outputs + their ground-truth index, prints the bug-class
// distribution, and — only when ANTHROPIC_API_KEY is set — asks Claude to judge
// each on two axes (localization + fix) so we can track the one-paste-fix rate.
//
//   pnpm --filter @bugzar/viewer eval:ai
//
// Without a key it stays deterministic (distribution + golden presence check),
// so it never blocks CI and never needs the network.

import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const dir = fileURLToPath(new URL('../src/__tests__/__snapshots__/eval/', import.meta.url));
const indexPath = `${dir}_index.json`;

if (!existsSync(indexPath)) {
  console.error('No eval index. Run `pnpm --filter @bugzar/viewer test` first to build goldens.');
  process.exit(1);
}

const seeds = JSON.parse(readFileSync(indexPath, 'utf8'));

const dist = {};
for (const s of seeds) dist[s.bugClass] = (dist[s.bugClass] ?? 0) + 1;
console.log('Bug-class distribution:', dist);
console.log(`Seeds: ${seeds.length}\n`);

const key = process.env.ANTHROPIC_API_KEY;
if (!key) {
  console.log('ANTHROPIC_API_KEY not set — golden/distribution only (no live scoring).');
  for (const s of seeds) {
    const ok = existsSync(`${dir}${s.name}.md`);
    console.log(`  ${ok ? '✓' : '✗ MISSING golden'}  ${s.name} (${s.bugClass})`);
  }
  process.exit(0);
}

// --- live 2-axis scoring (opt-in) ---
const MODEL = process.env.EVAL_MODEL ?? 'claude-opus-4-8';

async function score(copyText, expected) {
  const prompt = `You are triaging a bug report a developer pasted into you. Using ONLY the report below, answer as JSON:
{"area": "<the file/area you'd open first>", "fix": "<one-line fix>", "needFollowup": <true if you'd have to ask for more info to act>}

REPORT:
${copyText}`;
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-api-key': key,
      'anthropic-version': '2023-06-01',
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 400,
      messages: [{ role: 'user', content: prompt }],
    }),
  });
  if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
  const data = await res.json();
  const text = data.content?.map((c) => c.text).join('') ?? '';
  let parsed;
  try {
    parsed = JSON.parse(text.slice(text.indexOf('{'), text.lastIndexOf('}') + 1));
  } catch {
    parsed = { area: text, fix: '', needFollowup: true };
  }
  // 2-axis judgement, reported SEPARATELY (the axes are coupled via needFollowup):
  //  - answered   = the model acted without asking a follow-up
  //  - located    = the model's area actually MATCHES expected.area (correctness,
  //                 not mere confidence) — significant tokens from expected
  //                 (filenames, /api/ paths, identifiers ≥5 chars) appear in it
  //  - fixed      = the model proposed a fix
  const answered = !parsed.needFollowup;
  const located = answered && locMatch(parsed.area, expected.area);
  const fixed = answered && String(parsed.fix || '').length > 0;
  return { answered, located, fixed, parsed, expected };
}

/** Rough correctness match: a significant token of expected.area appears in the model's area. */
function locMatch(modelArea, expectedArea) {
  const a = String(modelArea || '').toLowerCase();
  const tokens = String(expectedArea || '').toLowerCase().match(/[a-z0-9_./-]{3,}/g) || [];
  const sig = tokens.filter(
    (t) => t.includes('.tsx') || t.includes('.ts') || t.includes('/api/') || t.length >= 5,
  );
  return sig.length > 0 && sig.some((t) => a.includes(t));
}

let answeredHits = 0;
let locHits = 0;
let fixHits = 0;
for (const s of seeds) {
  const copy = readFileSync(`${dir}${s.name}.md`, 'utf8');
  try {
    const r = await score(copy, s.expected);
    if (r.answered) answeredHits++;
    if (r.located) locHits++;
    if (r.fixed) fixHits++;
    console.log(`  ${s.name} (${s.bugClass}): answered=${r.answered} located=${r.located} fixed=${r.fixed}`);
    console.log(`      model area: ${r.parsed.area}`);
    console.log(`      expected:   ${s.expected.area}`);
  } catch (e) {
    console.log(`  ${s.name}: ERROR ${e.message}`);
  }
}
const n = seeds.length;
console.log(`\nanswered(no follow-up): ${answeredHits}/${n}`);
console.log(`localization (area matches expected): ${locHits}/${n}`);
console.log(`fix proposed: ${fixHits}/${n}`);
console.log('(located = correctness, not confidence; still review model area vs expected above)');
