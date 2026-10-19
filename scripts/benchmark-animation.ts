/** Developer benchmark: npx tsx scripts/benchmark-animation.ts <baseline compact-tools-clock.ts>. */
import assert from "node:assert/strict";
import { resolve } from "node:path";
import { performance as nodePerformance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import { install } from "@sinonjs/fake-timers";
import { onTick } from "../extensions/compact-tools-clock.ts";
// Intentionally internal, development-only: exercise the actual host scheduler
// while counting paint boundaries instead of writing to a real terminal.
import { TuiBase } from "../node_modules/@earendil-works/pi-tui/dist/tui.js";
assert.ok(process.argv[2], "provide the unmodified baseline clock module");
const baseline = await import(pathToFileURL(resolve(process.argv[2])).href);
class CountingTui extends TuiBase {
	paints = 0;
	paintTimes: number[] = [];
	protected doRender(): void { this.paints++; this.paintTimes.push(nodePerformance.now()); }
}
function measure(shared: boolean) {
	const clock = install({ toFake: ["setInterval", "clearInterval", "setTimeout", "clearTimeout", "nextTick", "performance"] });
	// The scheduler imports perf_hooks directly; fake-timers only replaces the
	// global performance object, so explicitly bind that monotonic clock too.
	const realNow = nodePerformance.now;
	nodePerformance.now = () => clock.now;
	const tui = new CountingTui({} as never);
	let indicatorFrames = 0, labelFrames = 0;
	const label = () => { labelFrames++; tui.requestRender(); };
	const indicator = () => { indicatorFrames++; tui.requestRender(); };
	const stopLabel = shared ? onTick(label) : baseline.onTick(label);
	const oldTimer = shared ? undefined : setInterval(indicator, 45);
	const stopIndicator = shared ? onTick(indicator, 45) : () => clearInterval(oldTimer);
	try {
		const animationTimers = clock.countTimers();
		// Advance in small turns so fake nextTick jobs are drained between interval
		// callbacks, as Node does. One giant tick defers them until another timer.
		for (let ms = 0; ms < 7_200; ms++) clock.tick(1);
		stopIndicator(); stopLabel();
		for (let ms = 0; ms < 16; ms++) clock.tick(1); // flush the last scheduled render
		return { elapsedMs: 7_200, animationTimers, indicatorFrames, labelFrames, nativePaints: tui.paints, remainingTimers: clock.countTimers(), ...(process.env.ANIMATION_BENCH_DEBUG ? { firstPaintTimes: tui.paintTimes.slice(0, 12) } : {}) };
	} finally { stopIndicator(); stopLabel(); nodePerformance.now = realNow; clock.uninstall(); }
}
const before = measure(false), after = measure(true);
assert.equal(after.indicatorFrames, before.indicatorFrames);
assert.equal(after.labelFrames, before.labelFrames);
assert.equal(after.remainingTimers, 0);
assert.ok(after.nativePaints < before.nativePaints);
console.log(JSON.stringify({ scenario: "7.2s simultaneous tool indicator and working label, native Pi scheduler, synthetic timer workload (not terminal CPU/latency)", before, after, paintReductionPercent: 100 * (1 - after.nativePaints / before.nativePaints) }, null, 2));
