import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install } from "@sinonjs/fake-timers";
import { createBashToolDefinition, initTheme, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import compactTools from "../extensions/compact-tools.ts";
import { isSilent } from "../extensions/compact-tools-silent.ts";

for (const publicAPI of [false, true]) test(`off restores native rows, thinking, keys and animation live from silent mode (public=${publicAPI})`, async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "compact-native-off-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	initTheme("dark", false);
	const clock = install({ toFake: ["setInterval", "clearInterval"] });
	const config = (style: string) => writeFileSync(join(dir, "compact-tools.json"), JSON.stringify({ style, mode: "silent" }));
	const base = createBashToolDefinition(dir);
	const args = { command: "echo native" };
	const result = { content: [{ type: "text" as const, text: "native output" }], details: undefined, isError: false };
	const makeRow = (definition: any) => {
		const row = new ToolExecutionComponent("bash", "native-off", args, {}, definition, { requestRender() {} } as never, dir);
		row.updateResult(result);
		row.setExpanded(true);
		return row;
	};
	const baseline = makeRow(base).render(100);
	const thinking = "## Original thinking\n\nKeep **all** details and formatting.";
	function boot() {
		const handlers = new Map<string, Function[]>();
		const commands = new Map<string, any>();
		const transforms: Array<(text: string, context: any) => string> = [];
		const widgets = new Map<string, unknown>();
		const inputs = new Set<Function>();
		let resolver: Function = (_name: string, next: Function) => next();
		let workingCalls = 0;
		const chat = new Container();
		const tui = { children: [{ children: [chat] }], requestRender() {} };
		const emit = (event: string, value: unknown, context?: unknown) => handlers.get(event)?.forEach(fn => fn(value, context));
		const ui = new Proxy({}, { get(_target, key) {
			if (key === "setWidget") return (name: string, factory: unknown) => { if (typeof factory === "function") { widgets.set(name, factory(tui)); } else widgets.delete(name); };
			if (key === "onTerminalInput") return (handler: Function) => { inputs.add(handler); return () => inputs.delete(handler); };
			if (key === "setWorkingMessage" || key === "setWorkingIndicator") return () => { workingCalls++; };
			if (key === "theme") return theme;
			return () => {};
		} });
		const ctx = { cwd: dir, mode: "tui", isIdle: () => true, isProjectTrusted: () => false, ui };
		compactTools({
			on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
			registerToolRenderer: publicAPI ? (fn: Function) => { resolver = fn; } : undefined,
			registerCommand(name: string, command: any) { commands.set(name, command); },
			registerShortcut() {}, registerMarkdownTransformer(fn: (text: string, context: any) => string) { transforms.push(fn); },
		} as unknown as ExtensionAPI);
		return { emit, ctx, commands, widgets, inputs, workingCalls: () => workingCalls, resolve: () => resolver("bash", () => base),
			transform: () => transforms.reduce((text, fn) => fn(text, { messageType: "assistant-thinking", availableWidth: 100, isStreaming: false }), thinking) };
	}
	try {
		// Off must also be native during factory-time transcript reconstruction, not
		// just after session_start (important for HTML export and resumed sessions).
		config("off");
		let app = boot();
		assert.equal(app.transform(), thinking);
		app.emit("session_start", { reason: "startup" }, app.ctx);
		assert.equal(app.transform(), thinking);
		assert.deepEqual(makeRow(app.resolve()).render(100), baseline);
		assert.equal(isSilent(), false, "configured silent cannot override off");
		assert.equal(app.inputs.size, 0, "Ctrl+T belongs to Pi");
		assert.equal(app.widgets.size, 0);
		app.emit("agent_start", {});
		clock.tick(1_000);
		assert.equal(clock.countTimers(), 0);
		assert.equal(app.workingCalls(), 0);
		// Exercise live on->off as well as startup-off, and verify that a later
		// explicit reload also keeps the native style.
		app.emit("session_shutdown", { reason: "reload" });
		config("claude");
		app = boot();
		app.emit("session_start", { reason: "reload" }, app.ctx);
		assert.equal(isSilent(), true);
		assert.notEqual(app.transform(), thinking);
		let reloads = 0;
		await app.commands.get("compact-tools").handler("off", { ...app.ctx, reload: async () => { reloads++; } });
		assert.equal(reloads, 0, "off is a live UI transition");
		assert.equal(app.transform(), thinking);
		assert.deepEqual(makeRow(app.resolve()).render(100), baseline);
		assert.equal(app.inputs.size, 0);
		assert.equal(app.widgets.size, 0);
		assert.equal(isSilent(), false);
		app.emit("session_shutdown", { reason: "reload" });
		app = boot();
		app.emit("session_start", { reason: "reload" }, app.ctx);
		assert.equal(app.transform(), thinking);
		assert.deepEqual(makeRow(app.resolve()).render(100), baseline);
		assert.equal(isSilent(), false);
		assert.equal(app.inputs.size, 0);
		assert.equal(app.widgets.size, 0);
		app.emit("session_shutdown", { reason: "quit" });
		assert.equal(clock.countTimers(), 0);
	} finally {
		clock.uninstall();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});
