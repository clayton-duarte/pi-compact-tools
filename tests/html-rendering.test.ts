import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createReadToolDefinition, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import compactTools from "../extensions/compact-tools.ts";

test("public renderer route reaches HTML and keeps collapsed/expanded and author state separate", () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-html-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	initTheme("dark", false);
	writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ tools: ["read"], style: "compact" }));
	let resolver: Function = () => undefined;
	const handlers = new Map<string, Function>();
	const authorComponents: unknown[] = [];
	const author = {
		renderResult: (_result: unknown, options: { expanded: boolean }, _theme: unknown, ctx: { state: Record<string, unknown>; lastComponent?: unknown }) => {
			authorComponents.push(ctx.lastComponent);
			ctx.state.author = (Number(ctx.state.author) || 0) + 1;
			return { render: () => [`AUTHOR ${options.expanded ? "expanded" : "collapsed"} ${ctx.state.author}`], invalidate() {} };
		},
	};
	try {
		compactTools({ on: (event: string, handler: Function) => handlers.set(event, handler),
			registerToolRenderer: (value: Function) => { resolver = value; },
			registerCommand() {}, registerShortcut() {}, registerMarkdownTransformer() {},
		} as unknown as ExtensionAPI);
		handlers.get("session_start")!({ reason: "startup" }, { cwd: directory, mode: "print", isIdle: () => true, isProjectTrusted: () => false });
		let lookups = 0;
		const get = (name: string) => { lookups++; return resolver(name, () => name === "read" ? createReadToolDefinition(directory) : author); };
		// The legacy exporter uses getToolDefinition; Pi >=1.0.2 uses getToolRenderers.
		const renderer = createToolHtmlRenderer({ getToolDefinition: get, getToolRenderers: get, theme, cwd: directory } as never);
		assert.match(renderer.renderCall("read-html", "read", { path: "a.ts" })!, /read/u);
		const result = renderer.renderResult("read-html", "read", [{ type: "text", text: "one\ntwo\nthree" }], undefined, false)!;
		assert.ok(result.collapsed && result.collapsed !== result.expanded, "HTML expansion must reveal full output");
		assert.match(result.expanded!, /three/u);
		renderer.renderCall("author-html", "web_search", { query: "q" });
		const first = renderer.renderResult("author-html", "web_search", [{ type: "text", text: "output" }], undefined, false)!;
		assert.match(first.expanded!, /AUTHOR expanded 1/u);
		renderer.renderResult("author-html", "web_search", [{ type: "text", text: "output" }], undefined, false);
		assert.equal(authorComponents.length, 2);
		assert.equal(authorComponents[0], undefined);
		assert.ok(authorComponents[1], "author's previous Component survives a new public resolver lookup");
		assert.equal(lookups, 5);
		handlers.get("session_shutdown")!({ reason: "quit" });
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
