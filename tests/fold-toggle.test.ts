/**
 * fold: "toggle" (hs-d488), the fork's one fold language, as README.md "Fold toggle" documents it.
 * Written before the implementation: every test below that names the toggle fails until it lands.
 * Glyph expectations are code points, never pasted glyphs.
 */
import assert from "node:assert/strict";
import test from "node:test";
import {
	advance, announce, CASES, CUSTOM_CASES, loadExtension, makeRow, restoreClocks, shutdown, type Harness,
} from "./indicator-harness.ts";
import { DEFAULT_CONFIG, mergeConfig } from "../extensions/compact-tools-config.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

const plain = (line: string) => line.replace(/\x1b\[[0-9;]*m/gu, "");
const BOX = { head: "\u256D", close: "\u2570", rail: "\u2502", plainClose: "\u2514" }; // ╭ ╰ │ └
const PLAIN = { expand: "\u25B8", collapse: "\u25BE" }; // ▸ ▾
const NERD = { expand: "\u{F004B}", collapse: "\u{F0063}" };
const NERD_JSON = { expand: "\uDB80\uDC4B", collapse: "\uDB80\uDC63" }; // surrogate pairs, as a config file spells them

type Folded = { fold?: unknown; toggle?: unknown };
const foldOf = (config: object) => config as unknown as Folded;

/** mergeConfig's warnings, which go to console.error. */
function merged(value: unknown, base = DEFAULT_CONFIG) {
	const warnings: string[] = [];
	const original = console.error;
	console.error = (...args: unknown[]) => { warnings.push(args.join(" ")); };
	try { return { config: mergeConfig(base, value, "test"), warnings }; } finally { console.error = original; }
}

// --- config ---------------------------------------------------------------------------------

test("fold defaults to status and the glyphs to plain ▸ and ▾", () => {
	assert.equal(foldOf(DEFAULT_CONFIG).fold, "status");
	assert.deepEqual(foldOf(DEFAULT_CONFIG).toggle, PLAIN);
	const { config, warnings } = merged({});
	assert.equal(foldOf(config).fold, "status");
	assert.deepEqual(foldOf(config).toggle, PLAIN);
	assert.deepEqual(warnings, []);
});

test("fold accepts toggle and status, spelled exactly", () => {
	assert.equal(foldOf(merged({ fold: "toggle" }).config).fold, "toggle");
	assert.equal(foldOf(merged({ fold: "status" }, merged({ fold: "toggle" }).config).config).fold, "status");
});

test("an unknown fold warns and keeps the previous value, as the loader does for style", () => {
	for (const bad of ["Toggle", "fancy", "", true, 1, null, ["toggle"]]) {
		const { config, warnings } = merged({ fold: bad });
		assert.equal(foldOf(config).fold, "status", JSON.stringify(bad));
		assert.equal(warnings.length, 1, JSON.stringify(bad));
		assert.match(warnings[0]!, /fold/u);
	}
	const { config } = merged({ fold: "fancy" }, merged({ fold: "toggle" }).config);
	assert.equal(foldOf(config).fold, "toggle", "the previous value, not the default");
});

test("toggle overrides the glyphs field by field, code points and JSON escapes alike", () => {
	assert.deepEqual(foldOf(merged({ toggle: NERD }).config).toggle, NERD);
	assert.deepEqual(foldOf(merged({ toggle: { expand: "+" } }).config).toggle, { expand: "+", collapse: PLAIN.collapse });
	assert.deepEqual(foldOf(merged({ toggle: { collapse: "-" } }).config).toggle, { expand: PLAIN.expand, collapse: "-" });
	// A config file is JSON.parse'd, which turns the escapes into the code points.
	const parsed = JSON.parse(`{"toggle":{"expand":"\\uDB80\\uDC4B","collapse":"\\uDB80\\uDC63"}}`);
	assert.deepEqual(parsed.toggle, NERD_JSON);
	assert.deepEqual(foldOf(merged(parsed).config).toggle, NERD);
	assert.equal([...NERD.expand][0]!.codePointAt(0), 0xF004B);
});

test("an invalid glyph warns and keeps the previous glyph", () => {
	for (const bad of ["", 7, null, "a\nb", "a\x1bb", "\x00"]) {
		const { config, warnings } = merged({ toggle: { expand: bad, collapse: "-" } });
		assert.deepEqual(foldOf(config).toggle, { expand: PLAIN.expand, collapse: "-" }, JSON.stringify(bad));
		assert.equal(warnings.length, 1, JSON.stringify(bad));
		assert.match(warnings[0]!, /toggle\.expand/u);
	}
});

test("a toggle that is not an object warns and keeps the previous glyphs", () => {
	for (const bad of ["▸", 1, ["a", "b"], null]) {
		const { config, warnings } = merged({ toggle: bad });
		assert.deepEqual(foldOf(config).toggle, PLAIN, JSON.stringify(bad));
		assert.equal(warnings.length, 1, JSON.stringify(bad));
		assert.match(warnings[0]!, /toggle/u);
	}
});

test("project settings override fold and each glyph field by field", () => {
	const global = merged({ fold: "toggle", toggle: NERD }).config;
	const project = merged({ toggle: { collapse: "-" } }, global).config;
	assert.equal(foldOf(project).fold, "toggle");
	assert.deepEqual(foldOf(project).toggle, { expand: NERD.expand, collapse: "-" });
});

test("the other keys are unaffected by fold and toggle", () => {
	const { config } = merged({ fold: "toggle", toggle: NERD });
	assert.equal(foldOf(config).fold, "toggle");
	const { fold: _f, toggle: _t, ...rest } = config as unknown as Record<string, unknown>;
	const { fold: _df, toggle: _dt, ...defaults } = DEFAULT_CONFIG as unknown as Record<string, unknown>;
	assert.deepEqual(rest, defaults);
});

// --- compact rows -----------------------------------------------------------------------------

let sequence = 0;
const WIDTH = 100;

interface Drawn { head: string[]; running: string[]; done: string[] }

/** A row run to its end in Pi's order, drawn while it runs and once it has its result. */
async function drawRow(config: object, name: string, options: { failed?: boolean; expanded?: boolean } = {}): Promise<Drawn> {
	const harness: Harness = await loadExtension({ style: "compact", ...config });
	try {
		const id = `fold-${++sequence}`;
		const outcome = (CASES[name] ?? CUSTOM_CASES[name])!;
		announce(harness, id, name);
		const row = makeRow(name, id, outcome.args, harness.definitions.get(name));
		row.setExpanded(options.expanded ?? false);
		row.setArgsComplete();
		harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: name, args: outcome.args });
		row.markExecutionStarted();
		const running = row.render(WIDTH).map(plain);
		advance(300);
		harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: options.failed ?? false });
		row.updateResult({ ...(options.failed ? outcome.failure : outcome.success), isError: options.failed ?? false } as never, false);
		const done = row.render(WIDTH).map(plain);
		return { head: done, running, done };
	} finally {
		shutdown(harness);
	}
}

const TOGGLE = { fold: "toggle" };
const lastLine = (lines: string[]) => lines.filter((line) => line.trim() !== "").at(-1)!;
const firstLine = (lines: string[]) => lines.find((line) => line.trim() !== "")!;
/** What follows the ` └ ` of a status-fold closing row: the row's metadata. */
const metadataOf = (statusLines: string[]) => {
	const line = lastLine(statusLines);
	assert.ok(line.startsWith(` ${BOX.plainClose} `), line);
	return line.slice(` ${BOX.plainClose} `.length);
};

test("the head's leading space becomes ╭ and the rest of the head is unchanged", async () => {
	for (const name of ["bash", "read", "web_search"]) {
		const status = await drawRow({}, name);
		const toggle = await drawRow(TOGGLE, name);
		assert.ok(firstLine(status.done).startsWith(" "), name);
		assert.equal(firstLine(toggle.done), BOX.head + firstLine(status.done).slice(1), name);
	}
});

test("a folded row closes with ╰<glyph> expand · <metadata>", async () => {
	for (const name of ["bash", "read", "grep", "find", "ls", "web_search"]) {
		const status = await drawRow({}, name);
		const toggle = await drawRow({ ...TOGGLE, toggle: NERD }, name);
		assert.equal(lastLine(toggle.done), ` ${BOX.close}${NERD.expand} expand · ${metadataOf(status.done)}`, name);
		assert.equal(toggle.done.filter((line) => line.includes("└")).length, 0, `${name}: no └ left`);
	}
});

test("an expanded row closes with ╰<glyph> collapse · <metadata> under its ' │ ' body", async () => {
	for (const name of ["bash", "read", "web_search"]) {
		const status = await drawRow({}, name, { expanded: true });
		const toggle = await drawRow({ ...TOGGLE, toggle: NERD }, name, { expanded: true });
		assert.equal(lastLine(toggle.done), ` ${BOX.close}${NERD.collapse} collapse · ${metadataOf(status.done)}`, name);
		const body = (lines: string[]) => lines.filter((line) => line.startsWith(` ${BOX.rail} `));
		assert.deepEqual(body(toggle.done), body(status.done), `${name}: the body rail is unchanged`);
		assert.ok(body(toggle.done).length > 0, name);
	}
});

test("the default glyphs are the plain ▸ and ▾", async () => {
	const folded = await drawRow(TOGGLE, "read");
	assert.match(lastLine(folded.done), new RegExp(`^ ${BOX.close}${PLAIN.expand} expand · Done in `, "u"));
	const expanded = await drawRow(TOGGLE, "read", { expanded: true });
	assert.match(lastLine(expanded.done), new RegExp(`^ ${BOX.close}${PLAIN.collapse} collapse · Done in `, "u"));
});

test("a row with no metadata closes with the bare toggle, no ' · '", async () => {
	// A custom tool with an empty result has no line count: the closing row is only the toggle.
	const harness = await loadExtension({ style: "compact", ...TOGGLE, toggle: NERD });
	try {
		const id = `fold-${++sequence}`;
		announce(harness, id, "web_search");
		const row = makeRow("web_search", id, CUSTOM_CASES.web_search!.args, undefined);
		row.setArgsComplete();
		harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "web_search", args: {} });
		row.markExecutionStarted();
		harness.handlers.get("tool_execution_end")!({ toolCallId: id, isError: false });
		row.updateResult({ content: [], details: undefined, isError: false } as never, false);
		const lines = row.render(WIDTH).map(plain);
		const closing = lastLine(lines);
		assert.ok(closing.startsWith(` ${BOX.close}${NERD.expand} expand`), closing);
		if (!closing.includes(" · ")) assert.equal(closing, ` ${BOX.close}${NERD.expand} expand`);
	} finally { shutdown(harness); }
});

test("a failed row closes with ╰<glyph> expand · Failed in …", async () => {
	for (const expanded of [false, true]) {
		const status = await drawRow({}, "bash", { failed: true, expanded });
		const toggle = await drawRow({ ...TOGGLE, toggle: NERD }, "bash", { failed: true, expanded });
		const word = expanded ? "collapse" : "expand";
		const glyph = expanded ? NERD.collapse : NERD.expand;
		const closing = lastLine(toggle.done);
		assert.equal(closing, ` ${BOX.close}${glyph} ${word} · ${metadataOf(status.done)}`);
		assert.match(closing, /· Failed in 0\.300s/u);
	}
	const folded = await drawRow(TOGGLE, "bash", { failed: true });
	assert.match(lastLine(folded.done), /· Failed in 0\.300s · Command exited with code 1$/u, "with a reason, after the time");
});

test("an edit's closing row carries its diff counts after the toggle", async () => {
	const toggle = await drawRow({ ...TOGGLE, toggle: NERD }, "edit");
	assert.match(lastLine(toggle.done), new RegExp(`^ ${BOX.close}${NERD.expand} expand · Done in 0\\.300s \\(\\+1 -1\\)$`, "u"));
});

test("while a row runs the head wears ╭ and the closing row is today's, with no toggle", async () => {
	const status = await drawRow({}, "bash");
	const toggle = await drawRow(TOGGLE, "bash");
	assert.deepEqual(toggle.running.slice(1), status.running.slice(1).map((line, index) => index === 0 ? BOX.head + line.slice(1) : line));
	assert.ok(toggle.running.every((line) => !line.includes(BOX.close)), "no ╰ while running");
});

test("fold: toggle only acts in the compact style", async () => {
	assert.equal(foldOf(merged(TOGGLE).config).fold, "toggle", "the key is accepted");
	for (const style of ["claude", "codex"]) {
		const without = await drawRow({ style }, "bash");
		const withToggle = await drawRow({ style, ...TOGGLE }, "bash");
		assert.deepEqual(withToggle.done, without.done, style);
		assert.ok(withToggle.done.every((line) => !line.includes(BOX.close) && !line.includes(BOX.head)), style);
	}
});

test("with no fold key, or fold: status, every compact row is unchanged", async () => {
	assert.equal(foldOf(merged({}).config).fold, "status", "the key's default is status");
	for (const name of ["bash", "read", "edit", "web_search"]) {
		for (const expanded of [false, true]) {
			const absent = await drawRow({}, name, { expanded });
			const status = await drawRow({ fold: "status" }, name, { expanded });
			assert.deepEqual(status, absent, name);
			assert.ok(firstLine(absent.done).startsWith(" "), name);
			assert.match(lastLine(absent.done), /^ └ (Done in [0-9.]+s|Failed in )|^ │ /u, name);
			assert.ok(absent.done.every((line) => !line.includes(BOX.close) && !line.includes(BOX.head)), name);
		}
	}
});

// --- thinking block ---------------------------------------------------------------------------

/** The thinking block as the extension's Markdown transformer draws it, and Ctrl+T as the user presses it. */
async function thinking(config: object, source = "## **Check the implementation**\n\nInspect the renderer.\nKeep the cache.") {
	await loadExtension({ style: "compact", ...config });
	const compactTools = (await import("../extensions/compact-tools.ts")).default;
	const transforms: Array<(markdown: string, context: unknown) => string> = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => void>>();
	let input: ((data: string) => unknown) | undefined;
	const ui = new Proxy({} as Record<string, unknown>, {
		get: (_target, key) => {
			if (key === "theme") return theme;
			if (key === "onTerminalInput") return (fn: typeof input) => { input = fn; return () => {}; };
			return () => () => {};
		},
	});
	const ctx = { cwd: "/project", mode: "tui", isProjectTrusted: () => false, ui } as unknown as ExtensionContext;
	compactTools({
		on: (name: string, fn: (event: unknown, ctx: unknown) => void) => handlers.set(name, [...(handlers.get(name) ?? []), fn]),
		registerTool() {}, registerCommand() {}, registerShortcut() {},
		registerMarkdownTransformer: (fn: (markdown: string, context: unknown) => string) => transforms.push(fn),
		getThinkingLevel: () => "medium",
	} as unknown as ExtensionAPI);
	handlers.get("session_start")?.forEach((fn) => fn({ reason: "startup" }, ctx));
	const draw = () => transforms.reduce((value, fn) => fn(value, { messageType: "assistant-thinking", isStreaming: false, availableWidth: 80 }), source)
		.split("\n").map(plain);
	return {
		draw,
		press: () => input?.("\x14"),
		end: () => handlers.get("session_shutdown")?.forEach((fn) => fn({ reason: "quit" }, ctx)),
	};
}

test("thinking, folded (summary): the title, then ╰<glyph> expand", async () => {
	const block = await thinking({ ...TOGGLE, toggle: NERD });
	try {
		assert.deepEqual(block.draw().map((line) => line.trimEnd()), ["Check the implementation", `${BOX.close}${NERD.expand} expand`]);
	} finally { block.end(); }
});

test("thinking, expanded (detail): │ lines, then ╰<glyph> collapse · with the ctrl+t hint after the ·", async () => {
	const block = await thinking({ ...TOGGLE, toggle: NERD });
	try {
		block.draw(); // the controller learns the block has detail on its first draw, as in Pi
		block.press();
		assert.deepEqual(block.draw().map((line) => line.trimEnd()), [
			"Check the implementation",
			BOX.rail,
			`${BOX.rail} Inspect the renderer.`,
			`${BOX.rail} Keep the cache.`,
			`${BOX.close}${NERD.collapse} collapse · ctrl+t toggle • click to hide`,
		]);
	} finally { block.end(); }
});

test("thinking: summary after detail is folded again, hidden is unchanged, the default glyphs are plain", async () => {
	const block = await thinking(TOGGLE);
	try {
		assert.equal(block.draw().at(-1)!.trimEnd(), `${BOX.close}${PLAIN.expand} expand`);
		block.press();
		assert.equal(block.draw().at(-1)!.trimEnd(), `${BOX.close}${PLAIN.collapse} collapse · ctrl+t toggle • click to hide`);
		block.press();
		assert.deepEqual(block.draw().map((line) => line.trimEnd()), ["Check the implementation", `${BOX.close}${PLAIN.expand} expand`]);
		assert.equal(block.press(), undefined, "summary-after-detail passes to Pi's own toggle, which hides");
		block.press();
	} finally { block.end(); }
});

test("thinking with no detail has no toggle row, folded or not", async () => {
	assert.equal(foldOf(merged(TOGGLE).config).fold, "toggle", "the key is accepted");
	const block = await thinking(TOGGLE, "**Planning integration harness testing**");
	try {
		assert.equal(block.draw().join("\n").includes(BOX.close), false);
	} finally { block.end(); }
});

test("with no fold key the thinking block is unchanged: └ ctrl+t toggle • click to hide", async () => {
	assert.equal(foldOf(merged({}).config).fold, "status", "the key's default is status");
	for (const config of [{}, { fold: "status" }]) {
		const block = await thinking(config);
		try {
			assert.deepEqual(block.draw().map((line) => line.trimEnd()), ["Check the implementation"]);
			block.press();
			assert.deepEqual(block.draw().map((line) => line.trimEnd()), [
				"Check the implementation",
				BOX.rail,
				`${BOX.rail} Inspect the renderer.`,
				`${BOX.rail} Keep the cache.`,
				`${BOX.plainClose} ctrl+t toggle • click to hide`,
			]);
		} finally { block.end(); }
	}
});

test.after(() => restoreClocks());
