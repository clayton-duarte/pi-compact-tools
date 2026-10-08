import "./pinned-themes.ts";
import assert from "node:assert/strict";
import test from "node:test";
import { createBashToolDefinition, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, Text, visibleWidth } from "@earendil-works/pi-tui";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import compactTools from "../extensions/compact-tools.ts";
import type { RowResolver } from "../extensions/compact-tools-custom.ts";
import { withOutputPad } from "../extensions/compact-tools-layout.ts";
import { ToolRuntime } from "../extensions/compact-tools-runtime.ts";
import type { BuiltInDefinition, RenderContext } from "../extensions/compact-tools-types.ts";
import { advance, announce, loadExtension, makeRow, restoreClocks, shutdown, text, CASES, timerClock, elapse } from "./indicator-harness.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const plain = (lines: string[]) => lines.map(stripTerminalSequences);
let sequence = 0;
function context(id: string, fields: Partial<RenderContext> = {}): RenderContext {
	return {
		args: { command: "echo hello" }, argsComplete: true, cwd: "/project", executionStarted: false,
		expanded: false, invalidate() {}, isError: false, isPartial: false, lastComponent: undefined,
		showImages: false, state: {}, toolCallId: id, ...fields,
	};
}

for (const style of ["compact", "claude", "codex"]) test(`${style}: optional outputPad preserves legacy margins and internal indentation`, async () => {
	const harness = await loadExtension({ style }, { idle: true });
	try {
		const definition = harness.definitions.get("bash")! as unknown as BuiltInDefinition;
		const render = (pad?: number) => {
			const ctx = context(`padding-${++sequence}`, pad === undefined ? {} : { outputPad: pad });
			const call = definition.renderCall!(ctx.args, theme, ctx as never);
			const result = definition.renderResult!(text("hello"), { expanded: false, isPartial: false }, theme, ctx as never);
			return { call, result };
		};
		const legacy = render();
		const padded = render(1);
		const unpadded = render(0);
		for (const part of ["call", "result"] as const) {
			assert.deepEqual(plain(padded[part].render(80)), plain(legacy[part].render(80)));
			assert.deepEqual(plain(unpadded[part].render(79)), plain(padded[part].render(80)).map(line => line.startsWith(" ") ? line.slice(1) : line));
			for (const width of [1, 2, 3, 8, 20]) {
				assert.ok(unpadded[part].render(width).every(line => visibleWidth(line) <= width), `fits ${width}`);
			}
		}
	} finally { shutdown(harness); }
});

for (const style of ["compact", "codex"]) test(`${style}: restored final duration uses the optional host value, including zero`, async () => {
	const harness = await loadExtension({ style }, { idle: true });
	try {
		const definition = harness.definitions.get("bash")! as unknown as BuiltInDefinition;
		const draw = (durationMs?: number) => {
			const ctx = context(`duration-${++sequence}`, { expanded: true, ...(durationMs === undefined ? {} : { durationMs }) });
			const component = definition.renderResult!(text("one\ntwo\nthree\nfour\nfive"), { expanded: true, isPartial: false }, theme, ctx as never);
			return plain(component.render(80)).join("\n");
		};
		assert.match(draw(1234), style === "compact" ? /Done in 1\.234s/u : /1\.23s/u);
		assert.match(draw(0), style === "compact" ? /Done in 0\.000s/u : / • 0ms/u);
		for (const invalid of [undefined, NaN, Infinity, -1]) assert.doesNotMatch(draw(invalid), style === "compact" ? /Done in /u : / • \d/u);
	} finally { shutdown(harness); }
});

for (const style of ["claude", "codex"]) test(`${style}: folded group headers follow optional outputPad`, async () => {
	const harness = await loadExtension({ style }, { tui: true, idle: true });
	try {
		const rows = ["a.ts", "b.ts"].map(path => {
			const row = makeRow("read", `group-pad-${++sequence}`, { path }, harness.definitions.get("read"));
			row.updateResult({ ...text("hello"), isError: false } as never);
			return row;
		});
		harness.chat.children = rows;
		const legacy = plain(harness.chat.render(80));
		for (const row of rows) (row as unknown as { outputPad?: number }).outputPad = 1;
		assert.deepEqual(plain(harness.chat.render(80)), legacy);
		for (const row of rows) (row as unknown as { outputPad?: number }).outputPad = 0;
		assert.deepEqual(plain(harness.chat.render(79)), legacy.map(line => line.startsWith(" ") ? line.slice(1) : line));
		for (const width of [1, 3, 10]) assert.ok(harness.chat.render(width).every(line => visibleWidth(line) <= width));
	} finally { shutdown(harness); }
});

test("host duration beats a wall-clock jump and survives event-only reload timing", async () => {
	const harness = await loadExtension({ style: "compact" }, { idle: false });
	try {
		const id = `event-duration-${++sequence}`;
		announce(harness, id, "bash");
		harness.handlers.get("tool_execution_start")!({ toolCallId: id });
		const row = makeRow("bash", id, { command: "echo hello" }, harness.definitions.get("bash"));
		row.setArgsComplete(); row.markExecutionStarted();
		advance(60000);
		harness.handlers.get("tool_execution_end")!({ toolCallId: id, durationMs: 1234 });
		row.updateResult({ ...text("hello"), isError: false } as never);
		assert.match(plain(row.render(80)).join("\n"), /Done in 1\.234s/u);
		harness.handlers.get("agent_end")!({});
		const rebuilt = makeRow("bash", id, { command: "echo hello" }, harness.definitions.get("bash"));
		rebuilt.updateResult({ ...text("hello"), isError: false } as never);
		assert.match(plain(rebuilt.render(80)).join("\n"), /Done in 1\.234s/u);
	} finally { shutdown(harness); }
});

test("legacy events still use the original timing fallback", async () => {
	const harness = await loadExtension({ style: "compact" }, { idle: false });
	try {
		const id = `fallback-${++sequence}`;
		announce(harness, id, "bash");
		harness.handlers.get("tool_execution_start")!({ toolCallId: id });
		const row = makeRow("bash", id, { command: "echo hello" }, harness.definitions.get("bash"));
		row.markExecutionStarted(); advance(345);
		harness.handlers.get("tool_execution_end")!({ toolCallId: id });
		row.updateResult({ ...text("hello"), isError: false } as never);
		assert.match(plain(row.render(80)).join("\n"), /Done in 0\.345s/u);
	} finally { shutdown(harness); }
});

test("final result caches refresh for host duration or padding, and otherwise reuse", async () => {
	const harness = await loadExtension({ style: "compact" }, { idle: true });
	try {
		const definition = harness.definitions.get("bash")! as unknown as BuiltInDefinition;
		const ctx = context(`cache-${++sequence}`, { durationMs: 1000, outputPad: 1 });
		const result = text("hello");
		const draw = () => definition.renderResult!(result, { expanded: false, isPartial: false }, theme, ctx as never);
		const first = draw(); ctx.lastComponent = first;
		assert.equal(draw(), first);
		ctx.durationMs = 2000;
		const second = draw(); assert.notEqual(second, first);
		assert.match(plain(second.render(80)).join("\n"), /Done in 2\.000s/u);
		ctx.lastComponent = second; ctx.outputPad = 0;
		const third = draw(); assert.notEqual(third, second);
		assert.deepEqual(plain(third.render(79)), plain(second.render(80)).map(line => line.slice(1)));
		ctx.lastComponent = third; assert.equal(draw(), third);
		ctx.outputPad = 1;
		const restored = draw();
		assert.deepEqual(plain(restored.render(80)), plain(second.render(80)));
		ctx.lastComponent = restored; delete ctx.outputPad;
		const legacy = draw(); ctx.lastComponent = legacy;
		ctx.outputPad = 0;
		const explicitZero = draw();
		assert.notEqual(explicitZero, legacy, "absent to zero also invalidates the cache");
		assert.deepEqual(plain(explicitZero.render(79)), plain(third.render(79)));
	} finally { shutdown(harness); }
});

test("padding wrapper follows live source frames and propagates invalidation", () => {
	let source = [" \x1b[31m한글 😀\x1b[0m"];
	let invalidations = 0;
	const inner = { render: () => source, invalidate() { invalidations++; } };
	assert.equal(withOutputPad(inner), inner);
	assert.equal(withOutputPad(inner, 1), inner);
	const component = withOutputPad(inner, 0);
	assert.deepEqual(plain(component.render(8)), ["한글 😀"]);
	assert.equal(component.render(8), component.render(8));
	source = [" updated"];
	assert.deepEqual(plain(component.render(8)), ["updated"]);
	component.invalidate(); assert.equal(invalidations, 1);
});

for (const style of ["compact", "claude", "codex"]) test(`${style}: expanded built-ins retain every margin-prefixed code, diff, and output line`, async () => {
	const harness = await loadExtension({ style }, { idle: true });
	try {
		for (const [name, fixture] of Object.entries(CASES)) {
			const definition = harness.definitions.get(name)! as unknown as BuiltInDefinition;
			const draw = (outputPad: number) => {
				const ctx = context(`expanded-${++sequence}`, { args: fixture.args, expanded: true, outputPad });
				const call = definition.renderCall!(ctx.args, theme, ctx as never);
				const result = definition.renderResult!(fixture.success, { expanded: true, isPartial: false }, theme, ctx as never);
				return { call, result };
			};
			const padded = draw(1), unpadded = draw(0);
			for (const part of ["call", "result"] as const) {
				const lines = plain(padded[part].render(80));
				assert.ok(lines.every(line => !line.trim() || line.startsWith(" ")), `${name} ${part} owns its outer margin`);
				assert.deepEqual(plain(unpadded[part].render(79)), lines.map(line => line.startsWith(" ") ? line.slice(1) : line), `${name} ${part}`);
			}
		}
	} finally { shutdown(harness); }
});

for (const style of ["compact", "claude", "codex"]) test(`${style}: embedded authors do not receive a second outer padding`, async () => {
	const harness = await loadExtension({ style }, { idle: true });
	try {
		const resolve = (globalThis as unknown as Record<symbol, RowResolver>)[Symbol.for("pi-compact-tools.custom.resolver.v2")]!;
		const seen: Array<number | undefined> = [];
		const present: boolean[] = [];
		const author = { renderResult: (_result: unknown, _options: unknown, _theme: unknown, ctx: RenderContext) => {
			seen.push(ctx.outputPad); present.push(Object.hasOwn(ctx, "outputPad"));
			return new Text("AUTHOR 한글 😀 " + "long output ".repeat(15), ctx.outputPad ?? 1, 0);
		} };
		const renderers = resolve({ toolName: "author-aware", toolDefinition: author as never })!;
		const draw = (outputPad?: number) => {
			const ctx = context(`author-${++sequence}`, { expanded: true, ...(outputPad === undefined ? {} : { outputPad }) });
			const call = renderers.renderCall(ctx.args, theme, ctx as never);
			const result = renderers.renderResult(text("hello"), { expanded: true, isPartial: false }, theme, ctx as never);
			const width = outputPad === 0 ? 79 : 80;
			return [...plain(call.render(width)), ...plain(result.render(width))];
		};
		const padded = draw(1), unpadded = draw(0);
		assert.deepEqual(seen, [0, 0]);
		assert.deepEqual(unpadded, padded.map(line => line.startsWith(" ") ? line.slice(1) : line));
		assert.ok(padded.some(line => line.includes("AUTHOR 한글 😀")));
		draw(); assert.equal(seen.at(-1), undefined, "legacy author context remains unchanged");
		assert.equal(present.at(-1), false, "legacy context does not acquire the field");
	} finally { shutdown(harness); }
});

test("unmargined fallback lines mark truncation instead of silently dropping a character", () => {
	const component = withOutputPad({ render: width => ["x".repeat(width)], invalidate() {} }, 0);
	assert.deepEqual(plain(component.render(5)), ["xxxx…"]);
});

test("unpadded running calls continue painting live animation frames", async () => {
	const harness = await loadExtension({ style: "compact" }, { idle: false });
	try {
		const id = `live-pad-${++sequence}`;
		announce(harness, id, "bash");
		harness.handlers.get("tool_execution_start")!({ toolCallId: id });
		const ctx = context(id, { executionStarted: true, outputPad: 0 });
		const definition = harness.definitions.get("bash")! as unknown as BuiltInDefinition;
		const component = definition.renderCall!(ctx.args, theme, ctx as never);
		const frames = new Set<string>();
		for (let frame = 0; frame < 15; frame++) {
			frames.add(component.render(80).join("\n"));
			elapse(45); timerClock.tick(45);
		}
		assert.ok(frames.size > 1, "source frame changes pass through the padding cache");
	} finally { shutdown(harness); }
});

test("runtime ignores malformed host duration without losing its fallback", () => {
	const runtime = new ToolRuntime(); runtime.clearTimings();
	for (const value of [undefined, -1, NaN, Infinity, 0, 1234]) {
		const id = `validation-${++sequence}`;
		runtime.noteExecutionStart(id); advance(100);
		runtime.noteExecutionEnd(id, value);
		const ctx = context(id);
		const state = runtime.syncRow(ctx, true);
		assert.equal(state.durationMs, value !== undefined && Number.isFinite(value) && value >= 0 ? value : undefined);
		assert.equal(state.endedAt! - state.startedAt!, 100);
	}
	runtime.reset(true);
});

// Exercise the real native component on hosts which carry the new fields. The
// direct context tests above run unchanged against legacy Pi as well.
for (const style of ["compact", "claude", "codex"]) test(`${style}: native public renderer propagates recorded duration and live padding changes`, {
	skip: typeof (ToolExecutionComponent.prototype as unknown as { setOutputPad?: unknown }).setOutputPad !== "function",
}, () => {
	writeFileSync(join(process.env.PI_CODING_AGENT_DIR!, "compact-tools.json"), JSON.stringify({ style, tools: ["bash"] }));
	const handlers = new Map<string, Function[]>();
	let resolve: Function = () => undefined;
	compactTools({
		on(name: string, fn: Function) { const list = handlers.get(name) ?? []; list.push(fn); handlers.set(name, list); },
		registerToolRenderer(fn: Function) { resolve = fn; },
		registerCommand() {}, registerShortcut() {}, registerMarkdownTransformer() {},
	} as unknown as ExtensionAPI);
	const emit = (name: string, event: unknown, ctx?: unknown) => handlers.get(name)?.forEach(fn => fn(event, ctx));
	try {
		emit("session_start", { reason: "startup" }, { cwd: "/project", mode: "print", isProjectTrusted: () => false, isIdle: () => true });
		const definition = resolve("bash", () => createBashToolDefinition("/project"));
		const row = new ToolExecutionComponent("bash", `native-${++sequence}`, { command: "echo hello" }, {}, definition, { requestRender() {} } as never, "/project");
		row.updateResult({ ...text("one\ntwo\nthree\nfour\nfive"), isError: false, durationMs: 1234 } as never);
		row.setExpanded(true);
		const padded = plain(row.render(80));
		if (style === "compact") assert.match(padded.join("\n"), /Done in 1\.234s/u);
		if (style === "codex") assert.match(padded.join("\n"), /1\.23s/u);
		const native = row as unknown as { setOutputPad(pad: number): void };
		native.setOutputPad(0);
		assert.deepEqual(plain(row.render(79)), padded.map(line => line.startsWith(" ") ? line.slice(1) : line));
		native.setOutputPad(1); assert.deepEqual(plain(row.render(80)), padded);
	} finally { emit("session_shutdown", { reason: "quit" }); }
});

test.after(restoreClocks);
