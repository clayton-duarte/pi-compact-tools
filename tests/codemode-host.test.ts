import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, initTheme, SessionManager, SettingsManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import compactTools from "../extensions/compact-tools.ts";
import { hostToolSnapshot } from "./host-tool-snapshot.ts";

process.env.COLORTERM = "truecolor";
initTheme("dark", false);
const nativeExtension = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/index.js", import.meta.url);
const [major, minor] = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version.split(".").map(Number);
const supportsPersistedCalls = major > 1 || (major === 1 && minor >= 2);
if (supportsPersistedCalls) assert.ok(existsSync(nativeExtension), "Pi 1.2+ must expose its native codemode extension; host coverage must not silently skip");
// Dev-only event driver: run the real sandbox and nested pipeline, without calling a model/provider.
for (const style of ["compact", "claude", "codex"]) test(`${style}: real host codemode reports actual read, bash failure, edit diff and restored counts`, { skip: !supportsPersistedCalls }, async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-real-codemode-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ style }));
	writeFileSync(join(directory, "a.txt"), "one\ntwo\nthree\n");
	try {
		const native = await import(nativeExtension.href);
		const settingsManager = SettingsManager.inMemory({ defaultTools: ["read", "bash", "edit", "codemode"] });
		const sessionManager = SessionManager.inMemory(directory);
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [native.default, compactTools],
		});
		await loader.reload();
		const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager, resourceLoader: loader, sessionManager });
		try {
			await session.bindExtensions({ mode: "print", onError: (event) => { assert.fail(event.error); } });
			const driver = session as unknown as { _handleAgentEvent(event: unknown): Promise<void>; _extensionRunner: { resolveToolRenderers(name: string, base: () => unknown): unknown } };
			const id = `host-codemode-${style}`;
			const args = { code: 'const calls = await Promise.allSettled([tools.read({path:"a.txt"}), tools.read({path:"a.txt"}), tools.read({path:"a.txt"}), tools.bash({command:"exit 7"}), tools.edit({path:"a.txt", edits:[{oldText:"two", newText:"TWO\\nadded"}]}), tools.edit({path:"a.txt", edits:[{oldText:"NOT EXIST", newText:"!"}]})]); if (calls[3].status !== "fulfilled" || calls[3].value.exit_code !== 7 || calls[5].status !== "rejected") throw Error("Tool failure contract changed"); text("done");' };
			const assistant = { role: "assistant", content: [{ type: "toolCall", id, name: "codemode", arguments: args }],
				api: "anthropic-messages", provider: "anthropic", model: "test", stopReason: "toolUse", timestamp: Date.now(),
				usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
			session.agent.state.messages = [assistant as never];
			const assistantEntry = sessionManager.appendMessage(assistant as never);
			const declaration = () => JSON.stringify(hostToolSnapshot(session));
			const before = declaration();
			await driver._handleAgentEvent({ type: "tool_execution_start", toolCallId: id, toolName: "codemode", args });
			const tool = session.agent.state.tools.find(tool => tool.name === "codemode")!;
			const result = await tool.execute(id, args, new AbortController().signal);
			await driver._handleAgentEvent({ type: "tool_execution_end", toolCallId: id, toolName: "codemode", args, result, isError: false, durationMs: 1234 });
			const message = { role: "toolResult", toolCallId: id, toolName: "codemode", ...result, isError: false, timestamp: Date.now(), durationMs: 1234 };
			await driver._handleAgentEvent({ type: "message_start", message });
			await driver._handleAgentEvent({ type: "message_end", message });
			assert.equal(declaration(), before, "UI observers never change model declarations or prompt");
			assert.equal(readFileSync(join(directory, "a.txt"), "utf8"), "one\nTWO\nadded\nthree\n");
			const nested = (message as unknown as { nestedCalls: { calls: { name: string; status: string }[]; complete: boolean } }).nestedCalls;
			assert.equal(nested.calls.length, 6); assert.equal(nested.complete, true);
			assert.deepEqual(nested.calls.map(({ name, status }) => ({ name, status })), [{ name: "read", status: "ok" }, { name: "read", status: "ok" }, { name: "read", status: "ok" }, { name: "bash", status: "error" }, { name: "edit", status: "ok" }, { name: "edit", status: "error" }]);
			const draw = (callId = id, finalResult: unknown = message) => {
				const base = session.getToolDefinition("codemode");
				const renderer = driver._extensionRunner.resolveToolRenderers("codemode", () => base);
				const row = new ToolExecutionComponent("codemode", callId, args, {}, renderer as never, { requestRender() {} } as never, directory);
				row.updateResult(finalResult as never);
				return row.render(180).map(stripTerminalSequences).join("\n");
			};
			assert.match(draw(), /Done in 1\.234s.*✓ read\(3\) ✗ bash\(1\) edit\(2\) \[\+2 -1\|✗\]/u);
			assert.equal(declaration(), before, "rendering must preserve native codemode reachesTools and all metadata");
			await session.reload();
			assert.match(draw(), /edit\(2\) \[\+2 -1\|✗\]/u, "same-process reload keeps real edit deltas and errors");
			// Simulate a fresh process: only the host's persisted nested record survives.
			(globalThis as Record<symbol, Map<string, unknown>>)[Symbol.for("pi-compact-tools.nested-summaries.v1")]!.clear();
			await session.reload();
			assert.match(draw(), /Done in 1\.234s.*✓ read\(3\) ✗ bash\(1\) edit\(2\) \[ok\|✗\]/u);
			assert.doesNotMatch(draw(), /\+2 -1/u, "saved arguments are never mistaken for actual edit results");
			const originalLeaf = sessionManager.getLeafId()!;
			sessionManager.branch(assistantEntry);
			const sibling = { ...message, toolCallId: `${id}-sibling`, nestedCalls: { complete: true, calls: [{ id: `${id}-sibling/1`, name: "grep", status: "ok" }] } };
			const siblingLeaf = sessionManager.appendMessage(sibling as never);
			sessionManager.branch(originalLeaf);
			assert.doesNotMatch(draw(sibling.toolCallId, sibling), /✓ grep/u, "sibling has not been restored yet");
			const navigated = await session.navigateTree(siblingLeaf);
			assert.equal(navigated.cancelled, false);
			assert.match(draw(sibling.toolCallId, sibling), /✓ grep\(1\)/u, "/tree restores the new branch without a session_start");
		} finally { session.dispose(); }
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
