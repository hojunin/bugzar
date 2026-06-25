// R0 baseline — deterministic golden snapshot of each seed's Copy-for-AI output,
// built exactly as the app builds it (session copy + repro steps). The committed
// snapshot files ARE the pre-R1 baseline: after R1 changes the formatter, the
// git diff on these files IS the reviewable delta. Also a real regression guard.

import { describe, expect, it } from 'vitest';
import { classDistribution, SEEDS } from '../eval/seeds';
import { formatSessionForAI } from '../report/ai-context';
import { extractReproSteps, reproStepText } from '../report/repro-steps';
import scorerIndex from './__snapshots__/eval/_index.json';

describe('eval golden — Copy-for-AI output per seed (baseline)', () => {
  for (const seed of SEEDS) {
    it(`${seed.name} (${seed.bugClass})`, async () => {
      const steps = reproStepText(extractReproSteps(seed.report));
      const out = formatSessionForAI(seed.report, steps.length ? { reproSteps: steps } : {});
      await expect(out).toMatchFileSnapshot(`./__snapshots__/eval/${seed.name}.md`);
    });
  }

  it('records the bug-class distribution (R0 decision input)', () => {
    // 5 seeds: network/server-error vs client-runtime mix. Used to decide
    // R1-first vs pull R2a forward (§5). Not a hard cutoff — judgment input.
    expect(classDistribution()).toEqual({ network: 1, runtime: 2, state: 1, cors: 1, async: 1 });
  });

  it('scorer index (_index.json) stays in sync with SEEDS (drift guard)', () => {
    // The committed _index.json lets the pure-Node live scorer read ground truth
    // without a TS loader; this asserts it never drifts from seeds.ts.
    const fromSeeds = SEEDS.map((s) => ({
      name: s.name,
      bugClass: s.bugClass,
      expected: s.expected,
    }));
    expect(scorerIndex).toEqual(fromSeeds);
  });
});
