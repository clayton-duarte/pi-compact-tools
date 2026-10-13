import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync } from "node:fs";
import test from "node:test";
import { stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { NestedCallSummaries } from "../extensions/compact-tools-nested.ts";
import { advance, announce, loadExtension, makeRow, restoreClocks, shutdown, text } from "./indicator-harness.ts";
import { theme } from "../node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";

const plain = (lines: string[]) => lines.map(stripTerminalSequences);
function assertCompletionLayout(lines: string[], style: "claude" | "codex", expanded: boolean): void {
	const completion = lines.findIndex(line => /^\s*(?:Done|Failed)(?:\s|$)/u.test(line));
	assert.ok(completion >= 0, "summary is indented without a separate branch marker");
	assert.equal(lines[completion]!.match(/^ +/u)?.[0].length, style === "codex" ? 5 : 6, "summary aligns with output continuation rows");
	assert.doesNotMatch(lines.join("\n"), /[└⎿] +(?:Done|Failed)(?:\s|$)/u);
	const disclosure = lines.findIndex(line => style === "codex"
		? line.includes(expanded ? "− Show less" : "+ Show details")
		: line.includes("(ctrl+o to expand)"));
	if (style === "codex") assert.ok(disclosure >= 0, "Codex retains its disclosure control");
	if (disclosure >= 0) {
		assert.ok(disclosure > completion, "completion precedes the disclosure");
		assert.equal(disclosure, lines.length - 1, "disclosure stays last, including after wrapped summaries");
	}
	if (style === "claude" && expanded) assert.equal(disclosure, -1, "expanded Claude output has no omission hint");
}
const diff = (added: number, removed: number) => text("Edited", { diff: [...Array.from({ length: removed }, (_, i) => `- ${i} old`), ...Array.from({ length: added }, (_, i) => `+ ${i} new`)].join("\n") });
let sequence = 0;
function record(cache: NestedCallSummaries, root: string, index: number, name: string, isError = false, result?: unknown) {
	const event = { toolCallId: `${root}/${index}`, parentToolCallId: root, toolName: name, isError, result };
	cache.note(event, false);
	cache.note(event, true);
	return event;
}
function message(id: string, calls: unknown[], complete = true) {
	return { role: "toolResult", toolName: "codemode", toolCallId: id, nestedCalls: { calls, complete } };
}

const golden: Record<string, string[]> = {};
for (const style of ["compact", "claude", "codex"] as const) {
	test(`${style}: codemode completion summarizes actual children without replacing preview/author output`, async () => {
		const harness = await loadExtension({ style }, { tui: true, idle: false });
		try {
			const id = `codemode-summary-${++sequence}`;
			announce(harness, id, "codemode");
			assert.equal(harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "codemode", args: {} }), undefined);
			const author = { name: "codemode", renderResult: () => ({ render: () => ["AUTHOR output"], invalidate() {} }) };
			const row = makeRow("codemode", id, { code: "await tools.read({path:'a.ts'})" }, author);
			row.setArgsComplete(); row.markExecutionStarted();
			const calls = [["read", false, text("a")], ["read", false, text("b")], ["read", false, text("c")],
				["bash", true, text("Command exited with code 1")], ["edit", false, diff(4, 9)], ["edit", false, diff(7, 14)]] as const;
			calls.forEach(([toolName], index) => {
				assert.equal(harness.handlers.get("tool_execution_start")!({ toolCallId: `${id}/${index + 1}`, parentToolCallId: id, toolName, args: {} }), undefined);
			});
			// End out of order: display order follows starts, not nondeterministic completion order.
			for (const index of [4, 3, 5, 2, 0, 1]) {
				const [toolName, isError, result] = calls[index]!;
				assert.equal(harness.handlers.get("tool_execution_end")!({ toolCallId: `${id}/${index + 1}`, parentToolCallId: id, toolName, result, isError }), undefined);
			}
			row.updateResult({ ...text("first\nsecond\nthird\nfourth\nfifth"), isError: false } as never, true);
			assert.doesNotMatch(plain(row.render(100)).join("\n"), /✓ read|✗ bash|edit\(\d/u, "no completed tally on partial output");
			advance(1234);
			harness.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "codemode", isError: false });
			const result = text("first\nsecond\nthird\nfourth\nfifth");
			row.updateResult({ ...result, isError: false } as never, false);
			const before = JSON.stringify(result);
			for (const expanded of [false, true]) {
				row.setExpanded(expanded);
				for (const width of [120, 44, 20, 8, 3, 1]) {
					const lines = row.render(width);
					assert.ok(lines.every(line => visibleWidth(line) <= width), `fits ${width}`);
					if (width === 120) {
						const output = plain(lines).join("\n");
						assert.match(output, /Done in 1\.234s \(5 lines\) · ✓ read\(3\) ✗ bash\(1\) edit\(2\) \[\+4 -9\|\+7 -14\]/u);
						assert.doesNotMatch(output, /Failed in/u, "caught child error does not fail the script");
						if (expanded) {
							assert.match(output, /AUTHOR output/u, "author still owns expanded body");
							assert.ok(output.indexOf("AUTHOR output") < output.indexOf("Done in"), "completion follows the author's entire body");
						}
					}
					if ([120, 44].includes(width)) {
						if (style !== "compact") assertCompletionLayout(plain(lines), style, expanded);
						golden[`${style}/${expanded ? "open" : "closed"}/${width}`] = plain(lines);
					}
				}
			}
			assert.equal(JSON.stringify(result), before, "model-visible result stays untouched");
			assert.equal(harness.handlers.get("message_end")!({ message: message(id, [{ id: `${id}/1`, name: "read", status: "ok" }], false) }), undefined);
			assert.match(plain(row.render(120)).join("\n"), /edit\(2\) \[\+4 -9\|\+7 -14\]/u, "bounded snapshot cannot overwrite richer live summary");
		} finally { shutdown(harness); }
	});

	test(`${style}: edit lists preview three calls, expand fully, and return to the preview`, async () => {
		const harness = await loadExtension({ style }, { tui: true, idle: false });
		try {
			const id = `many-edits-${++sequence}`;
			harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "codemode" });
			const edits = [[10, 3], undefined, [5, 7], [0, 2], [2, 0], undefined] as const;
			for (let index = 0; index < edits.length; index++) {
				harness.handlers.get("tool_execution_start")!({ toolCallId: `${id}/${index + 1}`, parentToolCallId: id, toolName: "edit" });
			}
			for (const index of [3, 5, 1, 4, 0, 2]) {
				const changes = edits[index];
				harness.handlers.get("tool_execution_end")!({ toolCallId: `${id}/${index + 1}`, parentToolCallId: id, toolName: "edit", isError: !changes,
					result: changes ? diff(changes[0], changes[1]) : text("oldText not found") });
			}
			harness.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "codemode", isError: false });
			const row = makeRow("codemode", id, {}, undefined);
			row.updateResult({ ...text("edits done"), isError: false } as never);
			for (const expanded of [false, true, false]) {
				row.setExpanded(expanded);
				const lines = plain(row.render(120));
				const output = lines.join("\n");
				assert.match(output, expanded ? /edit\(6\) \[\+10 -3\|✗\|\+5 -7\|\+0 -2\|\+2 -0\|✗\]/u
					: /edit\(6\) \[\+10 -3\|✗\|\+5 -7\|… \+3 more \(1 failed\)\]/u);
				assert.doesNotMatch(output, /✓|✗ edit/u, "edit statuses are per call; successes need no checkmark");
				assert.doesNotMatch(output, / \||\| |\|\]/u, "no whitespace around separators or trailing pipe");
				if (style !== "compact") assertCompletionLayout(lines, style, expanded);
				golden[`${style}/many-${expanded ? "open" : "closed"}/120`] = lines;
				for (const width of [44, 20, 8, 3, 1]) {
					const drawn = row.render(width);
					assert.ok(drawn.every(line => visibleWidth(line) <= width), `fits ${width}`);
					if (width === 44) {
						if (style !== "compact") assertCompletionLayout(plain(drawn), style, expanded);
						golden[`${style}/many-${expanded ? "open" : "closed"}/44`] = plain(drawn);
					}
				}
			}
		} finally { shutdown(harness); }
	});

	test(`${style}: empty output and failed scripts still disclose nested outcomes`, async () => {
		const harness = await loadExtension({ style }, { idle: false });
		try {
			for (const isError of [false, true]) {
				const id = `empty-summary-${++sequence}`;
				harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "codemode" });
				harness.handlers.get("tool_execution_end")!({ toolCallId: `${id}/1`, parentToolCallId: id, toolName: "read", isError: false, result: text("a") });
				harness.handlers.get("tool_execution_start")!({ toolCallId: `${id}/2`, parentToolCallId: id, toolName: "bash" });
				harness.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "codemode", isError });
				const row = makeRow("codemode", id, {}, undefined);
				row.updateResult({ ...text(isError ? "Script error: aborted" : ""), isError } as never);
				for (const expanded of [false, true, false]) {
					row.setExpanded(expanded);
					const lines = plain(row.render(120));
					assert.match(lines.join("\n"), isError ? /Failed.*✓ read\(1\) \? bash\(1\) \(partial\)/u : /Done.*✓ read\(1\) \? bash\(1\) \(partial\)/u);
					if (style !== "compact") assertCompletionLayout(lines, style, expanded);
				}
			}
		} finally { shutdown(harness); }
	});

	test(`${style}: late child results refresh an already drawn completion footer`, async () => {
		const harness = await loadExtension({ style }, { tui: true, idle: false });
		try {
			const id = `late-${++sequence}`;
			harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "codemode" });
			harness.handlers.get("tool_execution_start")!({ toolCallId: `${id}/1`, parentToolCallId: id, toolName: "read" });
			harness.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "codemode", isError: false });
			const row = makeRow("codemode", id, {}, undefined);
			row.updateResult({ ...text("result"), isError: false } as never);
			harness.chat.children = [row];
			assert.match(plain(row.render(100)).join("\n"), /\? read\(1\) \(partial\)/u);
			harness.handlers.get("tool_execution_end")!({ toolCallId: `${id}/1`, parentToolCallId: id, toolName: "read", isError: false, result: text("a") });
			const drawn = plain(row.render(100)).join("\n");
			assert.match(drawn, /✓ read\(1\)/u);
			assert.doesNotMatch(drawn, /\? read|partial/u);
		} finally { shutdown(harness); }
	});

	test(`${style}: a late edit failure replaces only that attempt, retaining earlier successful diffs`, async () => {
		const harness = await loadExtension({ style }, { tui: true, idle: false });
		try {
			const id = `late-edit-${++sequence}`;
			harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "codemode" });
			for (const index of [1, 2]) harness.handlers.get("tool_execution_start")!({ toolCallId: `${id}/${index}`, parentToolCallId: id, toolName: "edit" });
			harness.handlers.get("tool_execution_end")!({ toolCallId: `${id}/1`, parentToolCallId: id, toolName: "edit", isError: false, result: diff(5, 7) });
			harness.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "codemode", isError: false });
			const row = makeRow("codemode", id, {}, undefined);
			row.updateResult({ ...text("output"), isError: false } as never);
			for (const expanded of [false, true]) {
				row.setExpanded(expanded);
				assert.match(plain(row.render(120)).join("\n"), /edit\(2\) \[\+5 -7\|\?\] \(partial\)/u);
			}
			harness.handlers.get("tool_execution_end")!({ toolCallId: `${id}/2`, parentToolCallId: id, toolName: "edit", isError: true, result: diff(100, 100) });
			for (const expanded of [false, true]) {
				row.setExpanded(expanded);
				const output = plain(row.render(120)).join("\n");
				assert.match(output, /edit\(2\) \[\+5 -7\|✗\]/u);
				assert.doesNotMatch(output, /partial|\+100|✓ edit/u);
			}
		} finally { shutdown(harness); }
	});

	test(`${style}: no nested record keeps the old output, even for a successful script`, async () => {
		const harness = await loadExtension({ style }, { idle: true });
		try {
			const id = `legacy-${++sequence}`;
			const row = makeRow("codemode", id, {}, undefined);
			row.updateResult({ ...text("legacy output"), isError: false } as never);
			golden[`${style}/legacy/100`] = plain(row.render(100));
			assert.doesNotMatch(golden[`${style}/legacy/100`]!.join("\n"), /✓|✗|partial/u);
		} finally { shutdown(harness); }
	});
}

test("claude: completion is outside the preview limit and precedes the wrapped-output omission hint", async () => {
	const harness = await loadExtension({ style: "claude" }, { idle: false });
	try {
		for (const [output, width, previewRows, hidden, isError = false] of [["1\n2\n3\n4", 120, 4, 0], ["1\n2\n3\n4\n5", 120, 3, 2], ["x".repeat(170), 44, 3, 2], ["", 120, 1, 0],
			["1\n2\n3\n4\n5\nCommand exited with code 1", 120, 4, 2, true], [`${"x".repeat(170)}\nCommand exited with code 1`, 44, 4, 2, true]] as const) {
			const id = `claude-preview-${++sequence}`;
			harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "codemode" });
			harness.handlers.get("tool_execution_end")!({ toolCallId: `${id}/1`, parentToolCallId: id, toolName: "read", isError: false, result: text("a") });
			harness.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "codemode", isError });
			const row = makeRow("codemode", id, {}, undefined);
			row.updateResult({ ...text(output), isError } as never);
			for (const expanded of [false, true, false]) {
				row.setExpanded(expanded);
				const lines = plain(row.render(width));
				assertCompletionLayout(lines, "claude", expanded);
				const hint = lines.filter(line => line.includes("(ctrl+o to expand)"));
				assert.deepEqual(hint, !expanded && hidden ? [`      … +${hidden} lines (ctrl+o to expand)`] : []);
				if (!expanded) {
					const start = lines.findIndex(line => line.startsWith("   ⎿  "));
					const end = lines.findIndex(line => /^\s*(?:Done|Failed)(?:\s|$)/u.test(line));
					assert.equal(end - start, previewRows, "only output rows consume the preview budget");
				}
			}
		}
	} finally { shutdown(harness); }
});

test("nested reducer deduplicates events, separates outcomes, and does not retain tool results", () => {
	const cache = new NestedCallSummaries(); cache.clear(); cache.begin("root", "codemode");
	const event = record(cache, "root", 1, "edit", false, diff(3, 2));
	const revision = cache.revision("root");
	cache.note(event, true); cache.note(event, false);
	assert.equal(cache.revision("root"), revision, "identical events are idempotent");
	record(cache, "root", 2, "edit", true, diff(50, 50));
	record(cache, "root", 3, "bash", false); record(cache, "root", 4, "bash", true);
	assert.equal(stripTerminalSequences(cache.format("root", theme)!), "edit(2) [+3 -2|✗] ✓ bash(1) ✗ bash(1)");
	// Missing diff numbers affect only that call; other known changes stay visible.
	record(cache, "root", 5, "edit", false, text("applied"));
	assert.equal(stripTerminalSequences(cache.format("root", theme)!), "edit(3) [+3 -2|✗|ok] ✓ bash(1) ✗ bash(1)");
	cache.note({ ...event, isError: true }, true);
	assert.equal(stripTerminalSequences(cache.format("root", theme)!), "edit(3) [✗|✗|ok] ✓ bash(1) ✗ bash(1)", "last settled outcome replaces, never double counts");
	const storage = (globalThis as Record<symbol, Map<string, unknown>>)[Symbol.for("pi-compact-tools.nested-summaries.v1")]!;
	const stored = storage.get("root") as { calls: Map<string, unknown> };
	assert.ok([...stored.calls.values()].every(call => !Object.hasOwn(call as object, "result") && !Object.hasOwn(call as object, "args")));
	cache.clear();
});

test("nested reducer follows deep descendants, including roots containing slashes", () => {
	const cache = new NestedCallSummaries(); cache.clear(); cache.begin("provider/root", "codemode");
	record(cache, "provider/root", 1, "orchestrator");
	record(cache, "provider/root/1", 1, "read");
	record(cache, "provider/root/1/1", 1, "edit", false, diff(2, 1));
	assert.equal(stripTerminalSequences(cache.format("provider/root", theme)!), "✓ orchestrator(1) ✓ read(1) edit(1) [+2 -1]");
	assert.equal(cache.format("provider", theme), undefined);
	cache.clear();
});

test("per-call edit formatting preserves zero changes and paints only the pipe dim", () => {
	const cache = new NestedCallSummaries(); cache.clear(); cache.begin("colored", "codemode");
	record(cache, "colored", 1, "edit", false, diff(10, 3));
	record(cache, "colored", 2, "edit", false, text("No changes", { diff: "   1 unchanged" }));
	const formatted = cache.format("colored", theme)!;
	assert.equal(stripTerminalSequences(formatted), "edit(2) [+10 -3|+0 -0]");
	assert.ok(formatted.includes(theme.fg("dim", "|")), "separator uses dim theme color");
	assert.ok(formatted.includes(theme.fg("toolDiffAdded", "+10")));
	assert.ok(formatted.includes(theme.fg("toolDiffRemoved", "-3")));
	cache.clear();
});

test("edit calls retain failures and unfinished states individually, including hidden preview statuses", () => {
	const cache = new NestedCallSummaries(); cache.clear(); cache.begin("statuses", "codemode");
	record(cache, "statuses", 1, "edit", true, diff(100, 100));
	record(cache, "statuses", 2, "edit", false, diff(5, 7));
	record(cache, "statuses", 3, "edit", false, text("applied"));
	record(cache, "statuses", 4, "edit", true);
	cache.note({ toolCallId: "statuses/5", parentToolCallId: "statuses", toolName: "edit" }, false);
	assert.equal(stripTerminalSequences(cache.format("statuses", theme)!), "edit(5) [✗|+5 -7|ok|… +2 more (1 failed, 1 unfinished)] (partial)");
	assert.equal(stripTerminalSequences(cache.format("statuses", theme, true)!), "edit(5) [✗|+5 -7|ok|✗|?] (partial)");
	const failed = cache.format("statuses", theme)!;
	assert.ok(failed.includes(theme.fg("error", "✗")));
	assert.ok(!failed.includes("+100"), "failed results never show claimed changes");
	cache.restore(message("persisted-errors", [{ id: "persisted-errors/1", name: "edit", status: "error" }, { id: "persisted-errors/2", name: "edit", status: "ok" },
		{ id: "persisted-errors/3", name: "edit", status: "error" }]));
	assert.equal(stripTerminalSequences(cache.format("persisted-errors", theme)!), "edit(3) [✗|ok|✗]");
	cache.clear();
});

test("persisted nested records restore counts, not guessed edit totals, and reject malformed records", () => {
	const cache = new NestedCallSummaries(); cache.clear();
	cache.restoreBranch([{ message: message("restored", [{ id: "restored/1", name: "edit", status: "ok", arguments: { oldText: "old", newText: "new" } },
		{ id: "restored/2", name: "read", status: "error" }, { id: "restored/3", name: "bash", status: "unfinished" }], false) },
		{ message: { role: "assistant" } }]);
	assert.equal(stripTerminalSequences(cache.format("restored", theme)!), "edit(1) [ok] ✗ read(1) ? bash(1) (partial)");
	assert.equal(cache.restore(null), false);
	assert.equal(cache.restore(message("bad", [null, { id: 1, name: "read", status: "ok" }, { id: "bad/2", name: "read", status: "invalid" }], true)), true);
	assert.equal(stripTerminalSequences(cache.format("bad", theme)!), "(partial)");
	cache.clear();
});

test("reducer caps calls and parents, keeps active siblings, and sanitizes tool names", () => {
	const cache = new NestedCallSummaries(); cache.clear(); cache.begin("many", "codemode");
	for (let i = 1; i <= 300; i++) record(cache, "many", i, "read");
	assert.equal(stripTerminalSequences(cache.format("many", theme)!), "✓ read(256) (partial)");
	cache.begin("unsafe", "codemode"); record(cache, "unsafe", 1, "\x1b[31mread\nforged\x07");
	assert.equal(stripTerminalSequences(cache.format("unsafe", theme)!), "✓ read forged(1)");
	record(cache, "unsafe", 2, "\u202e\u200bedit");
	assert.match(stripTerminalSequences(cache.format("unsafe", theme)!), /✓ edit\(1\)/u);
	record(cache, "unsafe", 3, "x".repeat(10000));
	assert.match(stripTerminalSequences(cache.format("unsafe", theme)!), /\(partial\)$/u, "oversized names are omitted, never kept in memory");
	cache.finish("unsafe");
	for (let i = 0; i < 2001; i++) cache.begin(`parent-${i}`, "codemode");
	const storage = (globalThis as Record<symbol, Map<string, unknown>>)[Symbol.for("pi-compact-tools.nested-summaries.v1")]!;
	assert.equal(storage.size, 2000); assert.equal(storage.has("unsafe"), false);
	cache.clear();
});

test("reload retains exact live diffs; a non-reload session clears cross-session ids", async () => {
	const harness = await loadExtension({ style: "compact" }, { idle: false });
	const id = `reload-${++sequence}`;
	harness.handlers.get("tool_execution_start")!({ toolCallId: id, toolName: "codemode" });
	harness.handlers.get("tool_execution_end")!({ toolCallId: `${id}/1`, parentToolCallId: id, toolName: "edit", result: diff(2, 1), isError: false });
	harness.handlers.get("tool_execution_end")!({ toolCallId: id, toolName: "codemode", isError: false });
	harness.handlers.get("session_shutdown")!({ reason: "reload" });
	const reloaded = await loadExtension({ style: "compact" }, { reason: "reload", idle: true });
	const row = makeRow("codemode", id, {}, undefined);
	row.updateResult({ ...text("output"), isError: false } as never);
	assert.match(plain(row.render(100)).join("\n"), /edit\(1\) \[\+2 -1\]/u);
	shutdown(reloaded);
	const next = await loadExtension({ style: "compact" }, { reason: "new", idle: true });
	try {
		const other = makeRow("codemode", id, {}, undefined);
		other.updateResult({ ...text("output"), isError: false } as never);
		assert.doesNotMatch(plain(other.render(100)).join("\n"), /edit\(\d/u);
	} finally { shutdown(next); }
});

test("late persisted snapshot fills an already rendered legacy row without changing its result", async () => {
	const harness = await loadExtension({ style: "claude" }, { tui: true, idle: true });
	try {
		const id = `snapshot-${++sequence}`;
		const row = makeRow("codemode", id, {}, undefined);
		row.updateResult({ ...text("output"), isError: false } as never);
		harness.chat.children = [row];
		assert.doesNotMatch(plain(row.render(100)).join("\n"), /✓ read/u);
		const snapshot = message(id, [{ id: `${id}/1`, name: "read", status: "ok" }]);
		const before = JSON.stringify(snapshot);
		assert.equal(harness.handlers.get("message_end")!({ message: snapshot }), undefined);
		assert.equal(JSON.stringify(snapshot), before);
		assert.match(plain(row.render(100)).join("\n"), /Done \(1 line\) · ✓ read\(1\)/u);
	} finally { shutdown(harness); }
});

test("codemode summary renders match their pinned golden at wide and narrow widths", () => {
	const path = new URL("./golden/codemode-summary.json", import.meta.url);
	if (process.env.UPDATE_GOLDEN === "1") writeFileSync(path, `${JSON.stringify(golden, null, "\t")}\n`);
	else assert.deepEqual(golden, JSON.parse(readFileSync(path, "utf8")));
});

test.after(restoreClocks);
