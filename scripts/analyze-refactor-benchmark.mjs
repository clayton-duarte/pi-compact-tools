// Summarize paired benchmark uncertainty; input is benchmark-refactor.ts JSON.
// Bootstrap intervals describe this component harness, not real terminal latency.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
const input = process.argv[2];
assert.ok(input, "provide the benchmark JSON path");
const data = JSON.parse(readFileSync(input, "utf8"));
const median = values => { const ordered = [...values].sort((a, b) => a - b); return ordered[Math.floor(ordered.length / 2)]; };
let state = 0x1652026;
const random = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return (state >>> 0) / 2 ** 32; };
function interval(before, after) {
  const changes = [];
  for (let sample = 0; sample < 20_000; sample++) {
    const indices = Array.from({ length: before.length }, () => Math.floor(random() * before.length));
    changes.push(100 * (median(indices.map(index => after[index])) / median(indices.map(index => before[index])) - 1));
  }
  changes.sort((a, b) => a - b);
  return [changes[500], changes[19499]];
}
const results = data.results.map((result, index) => {
  for (const run of data.runs) {
    assert.deepEqual(run.before.samples[index].counts, result.beforeCounts);
    assert.deepEqual(run.after.samples[index].counts, result.afterCounts);
  }
  const cpuBefore = data.runs.map(run => run.before.samples[index].cpuMs / result.operationsPerWorker);
  const cpuAfter = data.runs.map(run => run.after.samples[index].cpuMs / result.operationsPerWorker);
  const wall95 = interval(result.beforeWallMsPerOperation, result.afterWallMsPerOperation);
  const cpu95 = interval(cpuBefore, cpuAfter);
  return { ...result, wallChange95Percent: wall95, cpuChange95Percent: cpu95,
    beforeCountsPerOperation: Object.fromEntries(Object.entries(result.beforeCounts).map(([key, value]) => [key, value / result.operationsPerWorker])),
    afterCountsPerOperation: Object.fromEntries(Object.entries(result.afterCounts).map(([key, value]) => [key, value / result.operationsPerWorker])),
    interpretation: wall95[1] < 0 ? "lower wall time in this harness" : wall95[0] > 0 ? "higher wall time in this harness" : "inconclusive wall-time difference",
  };
});
console.log(JSON.stringify({ statistic: `median across ${data.pairs} fresh-process pairs; paired bootstrap percentile 95% intervals for ratio of medians (20000 resamples, fixed xorshift seed); exploratory small-sample intervals, no multiple-comparison adjustment`, pairs: data.pairs, node: data.node, hostVersion: data.hostVersion, cpu: data.cpu, sourceHashes: { before: data.runs[0].before.sourceHash, after: data.runs[0].after.sourceHash }, results }, null, 2));
