import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createBashToolDefinition, initTheme, ToolExecutionComponent, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences } from "@earendil-works/pi-tui";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import compactTools from "../extensions/compact-tools.ts";
import { hasAuthorRenderers } from "../extensions/compact-tools-rendering.ts";

for (const publicAPI of [false, true]) for (const projectOff of [false, true]) test(`real provisional row reconciles trusted project (public=${publicAPI}, off=${projectOff})`, () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-project-reload-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	initTheme("dark", false);
	writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ tools: projectOff ? ["read", "bash"] : ["read"] }));
	mkdirSync(join(directory, ".pi"));
	writeFileSync(join(directory, ".pi", "compact-tools.json"), JSON.stringify({ tools: ["read", "bash"], style: projectOff ? "off" : "compact", custom_tools: { enabled: false } }));
	const handlers = new Map<string, Function>();
	let resolver: Function | undefined;
	try {
		compactTools({ on: (event: string, handler: Function) => handlers.set(event, handler),
			registerToolRenderer: publicAPI ? (value: Function) => { resolver = value; } : undefined,
			registerCommand() {}, registerShortcut() {}, registerMarkdownTransformer() {},
		} as unknown as ExtensionAPI);
		const base = createBashToolDefinition(directory);
		const definition = resolver ? resolver("bash", () => base) : base;
		const row = new ToolExecutionComponent("bash", "project-reload", { command: "echo hello" }, {}, definition, { requestRender() {} } as never, directory);
		row.updateResult({ content: [{ type: "text", text: "hello" }], details: undefined, isError: false });
		const internals = row as unknown as { children: unknown[]; selfRenderContainer: unknown; contentBox: unknown; rendererState: object };
		assert.ok(internals.children.includes(projectOff ? internals.selfRenderContainer : internals.contentBox), "factory-time shell");
		const authorState = { ...internals.rendererState };
		const chat = new Container();
		// Nested container ensures refresh is not limited to top-level rows.
		const group = new Container(); group.addChild(row); chat.addChild(group);
		const tui = { children: [{ children: [chat] }], requestRender() {} };
		const ui = new Proxy({}, { get(_target, key) {
			if (key === "theme") return theme;
			if (key === "setWidget") return (_name: string, factory: unknown) => { if (typeof factory === "function") factory(tui); };
			return () => () => {};
		} });
		handlers.get("session_start")!({ reason: "reload" }, { cwd: directory, mode: "tui", ui, isProjectTrusted: () => true, isIdle: () => true });
		assert.ok(internals.children.includes(projectOff ? internals.contentBox : internals.selfRenderContainer), "trusted project must refresh idle shell, even off");
		const output = row.render(100).map(stripTerminalSequences).join("\n");
		if (projectOff) {
			assert.doesNotMatch(output, /⦁ bash/u);
			assert.match(output, /echo hello/u, "off cannot leave a blank detached shell");
			row.setExpanded(true);
			const expanded = row.render(100).map(stripTerminalSequences).join("\n");
			assert.doesNotMatch(expanded, /⦁ bash/u);
			assert.match(expanded, /hello/u, "off still expands native result");
		} else {
			assert.match(output, /⦁ bash Run echo/u);
			assert.deepEqual(internals.rendererState, authorState, "compact bookkeeping must not touch original state");
		}
		handlers.get("session_shutdown")!({ reason: "quit" });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});

test("shell closures recognized without stealing explicit author renderers", () => {
	assert.equal(hasAuthorRenderers("bash", createBashToolDefinition("/another-project")), false);
	assert.equal(hasAuthorRenderers("bash", { renderResult: () => ({ render: () => ["AUTHOR"], invalidate() {} }) } as never), true);
});

test("public off preserves undefined and next() ?? mine renderer composition", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-off-compose-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ style: "off" }));
	let resolver: Function = () => undefined;
	const handlers = new Map<string, Function>();
	try {
		compactTools({ on: (event: string, handler: Function) => handlers.set(event, handler),
			registerToolRenderer: (value: Function) => { resolver = value; },
			registerCommand() {}, registerShortcut() {}, registerMarkdownTransformer() {},
		} as unknown as ExtensionAPI);
		const mine = { renderCall() {} };
		assert.equal(resolver("mcp_tool", () => undefined), undefined, "provisional off must not manufacture a definition");
		handlers.get("session_start")!({ reason: "startup" }, { cwd: directory, mode: "print", isProjectTrusted: () => false, isIdle: () => true });
		assert.equal(resolver("mcp_tool", () => undefined) ?? mine, mine);
		assert.equal(resolver("mcp_tool", () => mine), mine, "existing base returned by identity");
		handlers.get("session_shutdown")!({ reason: "quit" });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
