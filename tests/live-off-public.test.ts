import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { install } from "@sinonjs/fake-timers";
import { createBashToolDefinition, initTheme, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, Text } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import compactTools from "../extensions/compact-tools.ts";
import { isSilent } from "../extensions/compact-tools-silent.ts";
import { loadNativeTimerRenderers, syncNativeToolTimer } from "../extensions/compact-tools-rendering.ts";

const nativeCodemodeURL = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js", import.meta.url);

for (const publicAPI of [false, true]) for (const initial of ["off", "claude"]) test(`live off/on preserves streaming rows and authors (public=${publicAPI}, initial=${initial})`, async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const dir = mkdtempSync(join(tmpdir(), "compact-live-off-"));
	process.env.PI_CODING_AGENT_DIR = dir;
	writeFileSync(join(dir, "compact-tools.json"), JSON.stringify({ style: initial }));
	initTheme("dark", false);
	const clock = install({ toFake: ["setInterval", "clearInterval"] });
	const handlers = new Map<string, Function[]>(), commands = new Map<string, any>();
	const widgets = new Map<string, unknown>(), inputs = new Set<Function>();
	const transforms: Array<(value: string, context: any) => string> = [];
	let resolver: Function = (_name: string, next: Function) => next();
	let reloads = 0, busy = true, working: string | undefined, indicator: unknown;
	const thinkingRefreshes: Array<string | undefined> = [];
	const chat = new Container();
	const tui = { children: [{ children: [chat] }], requestRender() {} };
	const emit = (name: string, event: unknown) => handlers.get(name)?.forEach(fn => fn(event, ctx));
	const ui = new Proxy({}, { get(_target, key) {
		if (key === "theme") return theme;
		if (key === "setWidget") return (name: string, factory: unknown) => { if (typeof factory === "function") widgets.set(name, factory(tui)); else widgets.delete(name); };
		if (key === "onTerminalInput") return (fn: Function) => { inputs.add(fn); return () => inputs.delete(fn); };
		if (key === "setWorkingMessage") return (value?: string) => { working = value; };
		if (key === "setWorkingIndicator") return (value?: unknown) => { indicator = value; };
		if (key === "setHiddenThinkingLabel") return (value?: string) => thinkingRefreshes.push(value);
		return () => {};
	} });
	const ctx = { cwd: dir, mode: "tui", isIdle: () => !busy, isProjectTrusted: () => false, ui, reload: async () => { reloads++; throw Error("Reload must not be called"); } };
	try {
		await loadNativeTimerRenderers();
		compactTools({ on(name: string, fn: Function) { handlers.set(name, [...(handlers.get(name) ?? []), fn]); },
			registerCommand(name: string, command: unknown) { commands.set(name, command); }, registerShortcut() {},
			registerMarkdownTransformer(fn: (value: string, context: any) => string) { transforms.push(fn); },
			registerToolRenderer: publicAPI ? (fn: Function) => { resolver = fn; } : undefined,
		} as unknown as ExtensionAPI);
		emit("session_start", { reason: "startup" });
		emit("agent_start", {});
		const base = createBashToolDefinition(dir);
		const args = { command: "echo first; sleep 10; echo second" };
		const create = (name: string, id: string, definition: any) => {
			emit("tool_execution_start", { toolCallId: id, toolName: name, args });
			const row = new ToolExecutionComponent(name, id, args, {}, resolver(name, () => definition), { requestRender() {} } as never, dir);
			row.setArgsComplete(); row.markExecutionStarted();
			row.updateResult({ content: [{ type: "text", text: "first chunk" }], details: undefined, isError: false } as never, true);
			return row;
		};
		const row = create("bash", "live-bash", base);
		const authorStates = new Set<object>();
		const author = { renderShell: "self", renderCall: () => new Text("AUTHOR CALL"), renderResult: (result: any, _options: any, _theme: any, context: any) => {
			authorStates.add(context.state);
			return new Text(`AUTHOR RESULT ${result.content[0].text}`);
		} };
		const custom = create("custom_live", "live-author", author);
		custom.setExpanded(true);
		custom.updateResult({ content: [{ type: "text", text: "first chunk" }], details: undefined, isError: false } as never, false);
		const originalAuthorState = (custom as any).rendererState;
		chat.addChild(row); chat.addChild(custom);
		const codemode = existsSync(nativeCodemodeURL)
			? create("codemode", "live-codemode", (await import(nativeCodemodeURL.href)).codemodeRenderers) : undefined;
		if (codemode) { codemode.setExpanded(true); chat.addChild(codemode); }
		const draw = () => chat.render(160).map(stripTerminalSequences).join("\n");
		const transform = () => transforms.reduce((value, fn) => fn(value, { messageType: "assistant-thinking", availableWidth: 100 }), "# Reasoning\n\nKeep details.");
		const command = (style: string) => commands.get("compact-tools").handler(style, ctx);
		for (const style of ["compact", "off", "claude", "off", "codex", "off", "compact"]) {
			await command(style);
			assert.equal(reloads, 0);
			assert.equal(busy, true);
			const output = draw();
			if (style === "off") {
				assert.equal((row as any).toolDefinition, base, "the original native definition is restored by identity");
				assert.equal((custom as any).toolDefinition, author, "same-shell author renderer is also restored");
				assert.equal(transform(), "# Reasoning\n\nKeep details.");
				assert.match(output, /AUTHOR CALL/);
				assert.equal(indicator, undefined);
				assert.equal(working, undefined);
				assert.equal(inputs.size, 0); assert.equal(widgets.size, 0);
				const timers = Object.values((clock as any).timers) as Array<{ interval?: number }>;
				assert.ok(timers.every(timer => timer.interval !== 45 && timer.interval !== 80), "only Pi's native elapsed timer may remain");
				assert.equal(thinkingRefreshes.at(-1), undefined);
			} else {
				assert.notEqual(transform(), "# Reasoning\n\nKeep details.");
				assert.ok(inputs.size > 0);
				assert.ok(clock.countTimers() > 0, "running indicators/progress resume immediately");
				assert.notEqual(indicator, undefined);
				assert.equal((row as any).rendererState.interval, undefined, "native timer is paused in compact styles");
				if (codemode) assert.equal((codemode as any).rendererState.interval, undefined, "delegating an expanded codemode preview must not restart a second clock");
			}
			assert.equal((custom as any).rendererState, originalAuthorState);
			// More data keeps arriving on the SAME row in every style.
			row.updateResult({ content: [{ type: "text", text: `chunk ${style}` }], details: undefined, isError: false } as never, true);
			custom.setExpanded(true);
			assert.match(draw(), /AUTHOR RESULT first chunk/);
		}
		await commands.get("silent").handler("on", ctx);
		assert.equal(isSilent(), true);
		await command("off");
		assert.equal(isSilent(), false, "off reveals all rows even when silent was active");
		assert.match(draw(), /AUTHOR RESULT/);
		// New calls created while off must also acquire compact renderers on re-enable.
		const fresh = create("bash", "created-off", base); chat.addChild(fresh);
		emit("message_update", { message: { role: "assistant", content: [] }, assistantMessageEvent: { type: "text_delta" } });
		await command("compact");
		assert.equal(isSilent(), true, "the user's silent choice survives off/on");
		assert.equal(widgets.has("compact-tools-silent-activity-render"), false, "resuming during answer streaming must not reinsert thinking dots");
		assert.match(stripTerminalSequences(working ?? ""), /Responding/, "the current streaming phase resumes immediately");
		await commands.get("silent").handler("off", ctx);
		assert.match(stripTerminalSequences(fresh.render(160).join("\n")), /⦁ bash/);
		emit("tool_execution_end", { toolCallId: "live-bash", toolName: "bash", isError: false, durationMs: 1234 });
		row.updateResult({ content: [{ type: "text", text: "final result" }], details: undefined, isError: false, durationMs: 1234 } as never);
		assert.match(draw(), /Done in 1\.234s/);
		assert.equal(authorStates.size, 1, "author state is never replaced across switches");
		fresh.updateResult({ content: [{ type: "text", text: "finished" }], details: undefined, isError: false } as never, false);
		// Closing the preview before completion must still leave no native clock.
		codemode?.setExpanded(false);
		codemode?.updateResult({ content: [{ type: "text", text: "finished" }], details: undefined, isError: false } as never, false);
		busy = false;
		emit("agent_end", {}); emit("agent_settled", {});
		await command("off");
		assert.equal(clock.countTimers(), 0);
	} finally {
		emit("session_shutdown", { reason: "quit" }); clock.uninstall();
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(dir, { recursive: true, force: true });
	}
});

test("native timing seeds the observed end time as well as start; author timing is untouched", () => {
	const base = createBashToolDefinition(process.cwd());
	const state = {};
	syncNativeToolTimer({ rendererState: state }, "bash", base, true, { startedAt: 1000, endedAt: 2234 });
	assert.deepEqual(state, { startedAt: 1000, endedAt: 2234 });
	const authorState = {};
	const author: typeof base = { ...base, renderResult: () => new Text("AUTHOR") };
	syncNativeToolTimer({ rendererState: authorState }, "bash", author, true, { startedAt: 1000, endedAt: 2234 });
	assert.deepEqual(authorState, {});
});
