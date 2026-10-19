/**
 * 0.16.4 vs 0.16.5 component/command benchmark; NOT physical-terminal latency.
 * Run from this checkout: npx tsx scripts/benchmark-refactor.ts <baseline-root> [pairs=9]
 * Baseline must resolve the same node_modules (a junction is sufficient).
 * Every sample is a fresh process; alternate version order to reduce drift.
 */
import "../tests/pinned-themes.ts";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { performance } from "node:perf_hooks";
import { install } from "@sinonjs/fake-timers";
import { createBashToolDefinition, createReadToolDefinition, initTheme, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

type Counts = { widgetMounts: number; widgetRemovals: number; inputsAdded: number; inputsRemoved: number; renderRequests: number; rowUpdates: number; workingWrites: number };
const zeroCounts = (): Counts => ({ widgetMounts: 0, widgetRemovals: 0, inputsAdded: 0, inputsRemoved: 0, renderRequests: 0, rowUpdates: 0, workingWrites: 0 });
type Measurement = { scenario: string; operations: number; wallMs: number; cpuMs: number; counts: Counts; checksum: number };
const script = fileURLToPath(import.meta.url);
const currentRoot = resolve(dirname(script), "..");
const hash = (value: string) => createHash("sha256").update(value).digest("hex");
function sourceHash(root: string) {
	return hash(readdirSync(join(root, "extensions")).filter(name => name.endsWith(".ts")).sort().map(name => `${name}\n${readFileSync(join(root, "extensions", name), "utf8")}`).join("\n"));
}

async function worker(root: string) {
	const directory = mkdtempSync(join(tmpdir(), "compact-refactor-bench-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	process.env.COLORTERM = "truecolor";
	const configPath = join(directory, "compact-tools.json");
	const save = (style = "claude") => writeFileSync(configPath, JSON.stringify({ style, mode: "normal" }));
	save(); initTheme("dark", false);
	// Freeze elapsed labels and prevent asynchronous animation from racing timing.
	// Wall and CPU measurements still use real perf_hooks/process clocks.
	const clock = install({ now: 2_000_000, toFake: ["Date", "setInterval", "clearInterval"] });
	const compactTools = (await import(pathToFileURL(join(root, "extensions/compact-tools.ts")).href)).default;
	const samples: Measurement[] = [];
	const snapshots: Record<string, string> = {};
	let checksum = 0;
	let h: ReturnType<typeof harness> | undefined;
	function harness() {
		const handlers = new Map<string, Function[]>(), commands = new Map<string, any>();
		const widgets = new Map<string, unknown>(), inputs = new Set<Function>();
		const counts = zeroCounts();
		const chat = new Container();
		const tui = { children: [{ children: [chat] }], requestRender() { counts.renderRequests++; } };
		let resolver: Function = (_name: string, next: Function) => next();
		const ui = {
			theme,
			setWidget(name: string, factory: unknown) {
				if (typeof factory === "function") { counts.widgetMounts++; widgets.set(name, factory(tui)); }
				else { counts.widgetRemovals++; widgets.delete(name); }
			},
			onTerminalInput(listener: Function) { counts.inputsAdded++; inputs.add(listener); return () => { counts.inputsRemoved++; inputs.delete(listener); }; },
			setWorkingVisible() {}, setWorkingIndicator() {}, setWorkingMessage() { counts.workingWrites++; },
			setHiddenThinkingLabel() {}, setStatus() {}, notify(_message: string, level: string) { assert.notEqual(level, "warning"); },
		};
		const ctx = { cwd: directory, mode: "tui", isIdle: () => !busy, isProjectTrusted: () => false, ui, reload: async () => { throw Error("Unexpected reload"); } };
		let busy = false;
		compactTools({ on(name: string, fn: Function) { handlers.set(name, [...handlers.get(name) ?? [], fn]); },
			registerCommand(name: string, command: unknown) { commands.set(name, command); }, registerShortcut() {}, registerMarkdownTransformer() {},
			registerToolRenderer(fn: Function) { resolver = fn; },
		} as unknown as ExtensionAPI);
		const emit = async (name: string, event: unknown) => { for (const fn of handlers.get(name) ?? []) await fn(event, ctx); };
		const command = (style: string) => commands.get("compact-tools").handler(style, ctx);
		const read = createReadToolDefinition(directory), bash = createBashToolDefinition(directory);
		const author = { renderCall: () => new Text("AUTHOR CALL"), renderResult: (result: any) => new Text(result.content[0]?.text ?? "") };
		const addRow = (index: number, partial = false) => {
			const kind = index % 3, name = kind === 0 ? "read" : kind === 1 ? "bash" : "author_tool";
			const args = kind === 0 ? { path: `src/file${index}.ts` } : kind === 1 ? { command: `echo result-${index}` } : { query: `query-${index}` };
			const base = kind === 0 ? read : kind === 1 ? bash : author;
			const row = new ToolExecutionComponent(name, `row-${index}`, args, {}, resolver(name, () => base), { requestRender() {} } as never, directory);
			const target = row as any, original = target.updateDisplay.bind(row);
			target.updateDisplay = () => { counts.rowUpdates++; original(); };
			row.setArgsComplete();
			if (partial) row.markExecutionStarted();
			row.updateResult({ content: [{ type: "text", text: Array.from({ length: 5 }, (_, line) => `output ${index}:${line}`).join("\n") }], details: undefined, isError: false, ...(!partial ? { durationMs: 1234 } : {}) } as never, partial);
			chat.addChild(row);
			return row;
		};
		const draw = () => {
			const lines = chat.render(160);
			checksum += lines.length + (lines[lines.length - 1]?.length ?? 0);
			return lines;
		};
		return { counts, chat, emit, command, addRow, draw, setBusy(value: boolean) { busy = value; },
			async close() { await emit("session_shutdown", { reason: "quit" }); assert.equal(widgets.size, 0); assert.equal(inputs.size, 0); assert.equal(clock.countTimers(), 0); },
		};
	}
	async function measure(scenario: string, operations: number, counts: Counts, run: () => Promise<void>) {
		const before = { ...counts };
		globalThis.gc?.();
		// Let pending background compiler/GC tasks settle outside the timed batch.
		await new Promise(resolve => setTimeout(resolve, 25));
		const cpuStart = process.cpuUsage(), start = performance.now();
		await run();
		const wallMs = performance.now() - start, cpu = process.cpuUsage(cpuStart);
		const delta = Object.fromEntries(Object.entries(counts).map(([key, value]) => [key, value - before[key as keyof Counts]])) as Counts;
		samples.push({ scenario, operations, wallMs, cpuMs: (cpu.user + cpu.system) / 1000, counts: delta, checksum });
	}
	try {
		// Prime optional native renderer loading, JIT, release-notice bookkeeping and
		// persisted settings before measuring warm factory/session work.
		for (let i = 0; i < 8; i++) { const warm = harness(); await warm.emit("session_start", { reason: "reload" }); await warm.close(); }
		for (const style of ["claude", "off"]) {
			save(style);
			const total = zeroCounts();
			await measure(`empty factory + session start/stop (${style})`, 400, total, async () => {
				for (let i = 0; i < 400; i++) {
					const fresh = harness(); await fresh.emit("session_start", { reason: "reload" }); await fresh.close();
					for (const key of Object.keys(total) as Array<keyof Counts>) total[key] += fresh.counts[key];
				}
			});
		}
		save(); h = harness(); await h.emit("session_start", { reason: "reload" });
		await measure("build + first draw (200 completed rows)", 200, h.counts, async () => { for (let i = 0; i < 200; i++) h!.addRow(i); h!.draw(); });
		// Warm each rendering style and its lazy host/theme caches before commands.
		for (let i = 0; i < 2; i++) for (const style of ["off", "compact", "claude", "codex"]) { await h.command(style); h.draw(); }
		await h.command("claude");
		await measure("session rebind (200 completed rows)", 40, h.counts, async () => { for (let i = 0; i < 40; i++) await h!.emit("session_start", { reason: "reload" }); });
		await measure("style command (200 rows, includes config I/O)", 64, h.counts, async () => { for (let i = 0; i < 16; i++) for (const style of ["off", "compact", "claude", "codex"]) await h!.command(style); });
		for (const style of ["compact", "claude", "codex", "off"]) {
			await h.command(style);
			for (let i = 0; i < 200; i++) h.draw();
			// Native file links include this worker's unique temp directory. Compare
			// visible text, excluding ANSI/OSC styling and hyperlink destinations.
			snapshots[style] = hash(h.draw().map(stripTerminalSequences).join("\n"));
			await measure(`cached transcript render (${style}, 200 rows)`, 4000, h.counts, async () => { for (let i = 0; i < 4000; i++) h!.draw(); });
		}
		await h.command("claude"); h.setBusy(true); await h.emit("agent_start", {});
		await h.emit("tool_execution_start", { toolCallId: "row-200", toolName: "author_tool", args: { query: "stream" } });
		const streaming = h.addRow(200, true); // 200 % 3 = 2, author tool: no native shell timer.
		await measure("partial result update + draw (200 history rows)", 1000, h.counts, async () => {
			for (let i = 0; i < 1000; i++) {
				streaming.updateResult({ content: [{ type: "text", text: `partial ${i}` }], details: undefined, isError: false } as never, true); h!.draw();
			}
		});
		h.setBusy(false); await h.emit("agent_end", {}); await h.emit("agent_settled", {});
		streaming.updateResult({ content: [{ type: "text", text: "done" }], details: undefined, isError: false } as never, false);
		await h.close(); h = undefined;
		return { version: JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version, samples, snapshots, sourceHash: sourceHash(root), remainingTimers: clock.countTimers() };
	} finally {
		if (h) await h.close();
		clock.uninstall(); rmSync(directory, { recursive: true, force: true });
	}
}

if (process.argv[2] === "--worker") {
	console.log(JSON.stringify(await worker(resolve(process.argv[3]!))));
} else {
	assert.ok(process.argv[2], "pass the 0.16.4 baseline directory");
	const baseline = resolve(process.argv[2]);
	const pairs = Number(process.argv[3] ?? 9);
	assert.ok(Number.isInteger(pairs) && pairs >= 3);
	const expectedHashes = { before: sourceHash(baseline), after: sourceHash(currentRoot) };
	const runs: Array<{ pair: number; before: Awaited<ReturnType<typeof worker>>; after: Awaited<ReturnType<typeof worker>> }> = [];
	for (let pair = 0; pair < pairs; pair++) {
		const run = (root: string) => JSON.parse(execFileSync(process.execPath, ["--expose-gc", "--import", "tsx", script, "--worker", root], { cwd: currentRoot, encoding: "utf8", maxBuffer: 10 * 1024 * 1024 })) as Awaited<ReturnType<typeof worker>>;
		const [first, second] = pair % 2 === 0 ? [baseline, currentRoot] : [currentRoot, baseline];
		const one = run(first), two = run(second);
		const before = first === baseline ? one : two, after = first === baseline ? two : one;
		assert.deepEqual(after.snapshots, before.snapshots, "visible rendered transcripts must match exactly");
		assert.equal(before.sourceHash, expectedHashes.before); assert.equal(after.sourceHash, expectedHashes.after);
		assert.equal(before.remainingTimers, 0); assert.equal(after.remainingTimers, 0);
		runs.push({ pair, before, after });
		console.error(`Completed pair ${pair + 1}/${pairs}`);
	}
	const median = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return sorted[Math.floor(sorted.length / 2)]!; };
	const results = runs[0]!.before.samples.map((sample, index) => {
		const summarize = (version: "before" | "after", field: "wallMs" | "cpuMs") => runs.map(run => run[version].samples[index]![field] / sample.operations);
		const beforeWall = summarize("before", "wallMs"), afterWall = summarize("after", "wallMs");
		const beforeCpu = summarize("before", "cpuMs"), afterCpu = summarize("after", "cpuMs");
		return { scenario: sample.scenario, operationsPerWorker: sample.operations,
			beforeMsPerOperation: median(beforeWall), afterMsPerOperation: median(afterWall), wallChangePercent: 100 * (median(afterWall) / median(beforeWall) - 1),
			beforeCpuMsPerOperation: median(beforeCpu), afterCpuMsPerOperation: median(afterCpu), cpuChangePercent: 100 * (median(afterCpu) / median(beforeCpu) - 1),
			pairedWallChangesPercent: beforeWall.map((value, pair) => 100 * (afterWall[pair]! / value - 1)),
			beforeWallMsPerOperation: beforeWall, afterWallMsPerOperation: afterWall,
			beforeCounts: sample.counts, afterCounts: runs[0]!.after.samples[index]!.counts,
		};
	});
	console.log(JSON.stringify({ node: process.version, platform: process.platform, arch: process.arch, cpu: cpus()[0]?.model, hostVersion: JSON.parse(readFileSync(join(currentRoot, "node_modules/@earendil-works/pi-coding-agent/package.json"), "utf8")).version,
		method: "isolated fresh processes; alternating version order; real wall/process CPU clocks; frozen Date and intervals; 8 warmup factories, 200 completed real host rows, 160-column component render; GC + 25ms settle before batches; 200 frame warmups before cached-render batches; no physical terminal, model or tool execution", pairs, results, runs }, null, 2));
}
