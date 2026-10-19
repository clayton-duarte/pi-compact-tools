import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { createAgentSession, createBashToolDefinition, DefaultResourceLoader, initTheme, SessionManager, SettingsManager, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { hostToolSnapshot } from "./host-tool-snapshot.ts";

const hostVersion = JSON.parse(readFileSync(new URL("../node_modules/@earendil-works/pi-coding-agent/package.json", import.meta.url), "utf8")).version as string;
const [hostMajor, hostMinor] = hostVersion.split(".").map(Number);
// The renderer file predates its elapsed timer: file existence alone does not
// establish that Pi 0.99–1.1 provides the native timer contract tested below.
const supportsNativeCodemodeTimer = hostMajor! > 1 || (hostMajor === 1 && hostMinor! >= 2);

test("real SDK busy command dispatch switches off/on without reload, abort, model request or loadout change", async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-off-host-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	const path = join(directory, "compact-tools.json");
	writeFileSync(path, JSON.stringify({ style: "claude", mode: "silent" }));
	try {
		const settingsManager = SettingsManager.inMemory({});
		const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			additionalExtensionPaths: [process.env.COMPACT_TOOLS_EXTENSION_UNDER_TEST ?? fileURLToPath(new URL("../extensions/compact-tools.ts", import.meta.url))] });
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, [], "the real extension file loads successfully");
		const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager,
			resourceLoader: loader, sessionManager: SessionManager.inMemory(directory) });
		try {
			let reloads = 0;
			await session.bindExtensions({ mode: "print", commandContextActions: { reload: async () => { reloads++; throw Error("Live style changes must not reload"); } } as never });
			// Verify optional native renderer fingerprinting also works through Pi's
			// actual extension loader (including a globally installed package).
			const nativeURL = new URL("../node_modules/@earendil-works/pi-coding-agent/dist/extensions/codemode/renderer.js", import.meta.url);
			if (supportsNativeCodemodeTimer) {
				assert.ok(existsSync(nativeURL), `Pi ${hostVersion} must provide its timed native codemode renderer`);
				await session.prompt("/compact-tools compact");
				initTheme("dark", false);
				const { codemodeRenderers: native } = await import(nativeURL.href);
				const args = { code: 'text("streaming")' };
				const partial = { content: [{ type: "text", text: "partial" }], details: undefined, isError: false };
				const row = new ToolExecutionComponent("codemode", "native-timer-probe", args, {}, native, { requestRender() {} } as never, directory);
				try {
					row.markExecutionStarted(); row.updateResult(partial as never, true);
					assert.ok((row as any).rendererState.interval, "native renderer owns an elapsed clock");
					const runner = session.extensionRunner as unknown as { resolveToolRenderers(name: string, next: () => unknown): unknown };
					(row as any).toolDefinition = runner.resolveToolRenderers("codemode", () => native);
					(row as any).callRendererComponent = undefined; (row as any).resultRendererComponent = undefined;
					row.setExpanded(true); row.updateResult(partial as never, true); row.render(100);
					assert.equal((row as any).rendererState.interval, undefined, "a delegated native preview must not retain a second clock");
				} finally { clearInterval((row as any).rendererState.interval); }
				await session.prompt("/compact-tools claude");
			}
			const before = hostToolSnapshot(session);
			const messages = structuredClone(session.state.messages);
			const thinking = "## Full thinking\n\nEvery detail must remain **unchanged**.";
			const transform = () => session.extensionRunner.getMarkdownTransformers().reduce((value, fn) => fn(value, {
				messageType: "assistant-thinking", availableWidth: 100, isStreaming: false,
			} as never), thinking);
			assert.notEqual(transform(), thinking);
			// Exercise the real session command dispatcher while the agent reports
			// streaming, without a network/model call in this deterministic test.
			const drivenState = session.agent.state as unknown as { isStreaming: boolean };
			drivenState.isStreaming = true;
			const drivenSession = session as unknown as { _isAgentRunActive: boolean };
			drivenSession._isAgentRunActive = true;
			for (const style of ["off", "compact", "off"]) {
				assert.equal(session.isIdle, false);
				await session.prompt(`/compact-tools ${style}`);
				assert.equal(reloads, 0);
				assert.equal(session.agent.state.isStreaming, true, "streaming was not stopped");
				assert.equal(JSON.parse(readFileSync(path, "utf8")).style, style);
				assert.deepEqual(hostToolSnapshot(session), before);
				assert.deepEqual(session.state.messages, messages, "the command must not call a model or add messages");
				assert.equal(transform() === thinking, style === "off");
				// This API first appeared after the peer minimum. Legacy hosts retain
				// native renderers and are covered by the component/reload tests.
				const runner = session.extensionRunner as unknown as { resolveToolRenderers?: (name: string, base: () => any) => any };
				if (runner.resolveToolRenderers) {
					const base = createBashToolDefinition(directory);
					const resolved = runner.resolveToolRenderers("bash", () => base);
					if (style === "off") assert.equal(resolved, base);
					else assert.equal(resolved?.renderShell, "self");
				}
			}
			drivenState.isStreaming = false;
			drivenSession._isAgentRunActive = false;
			await session.reload();
			assert.equal(transform(), thinking, "a later explicit reload preserves saved off");
		} finally {
			(session.agent.state as unknown as { isStreaming: boolean }).isStreaming = false;
			(session as unknown as { _isAgentRunActive: boolean })._isAgentRunActive = false;
			session.dispose();
		}
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
