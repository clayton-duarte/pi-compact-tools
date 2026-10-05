import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import compactTools from "../extensions/compact-tools.ts";

const UI_EVENTS = new Set(["session_start", "session_shutdown", "agent_start", "agent_end", "agent_settled", "message_update", "tool_execution_start", "tool_execution_end", "turn_start", "thinking_level_select"]);
for (const style of ["compact", "claude", "off"] as const) {
	test(`UI calls only allowed rendering/observation APIs (${style})`, () => {
		const previous = process.env.PI_CODING_AGENT_DIR;
		const directory = mkdtempSync(join(tmpdir(), "compact-tools-token-neutral-"));
		process.env.PI_CODING_AGENT_DIR = directory;
		const handlers = new Map<string, Function>();
		const pi = new Proxy({}, {
			get(_target, name) {
				if (name === "registerToolRenderer") return undefined; // exercise legacy host
				if (name === "on") return (event: string, handler: Function) => {
					assert.ok(UI_EVENTS.has(event), `UI must not transform ${event}`);
					handlers.set(event, handler);
				};
				if (["registerCommand", "registerShortcut", "registerMarkdownTransformer"].includes(String(name))) return () => {};
				return () => { assert.fail(`UI must not call model/session API ${String(name)}`); };
			},
		}) as ExtensionAPI;
		const ctx = { cwd: directory, mode: "print", isProjectTrusted: () => false, isIdle: () => true };
		try {
			writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ style }));
			compactTools(pi);
			handlers.get("session_start")!({ reason: "startup" }, ctx);
			for (const reason of ["reload", "new", "fork", "resume"]) {
				handlers.get("session_shutdown")!({ reason }, ctx);
				compactTools(pi);
				handlers.get("session_start")!({ reason }, ctx);
			}
			handlers.get("session_shutdown")!({ reason: "quit" }, ctx);
		} finally {
			if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previous;
			rmSync(directory, { recursive: true, force: true });
		}
	});
}

test("entry point has no tool registration or loadout mutation path", () => {
	const source = readFileSync(new URL("../extensions/compact-tools.ts", import.meta.url), "utf8");
	assert.doesNotMatch(source, /pi\.(?:registerTool|setActiveTools|sendMessage|sendUserMessage|appendEntry)\s*\(/u);
});
