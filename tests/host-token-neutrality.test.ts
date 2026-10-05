import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import compactTools from "../extensions/compact-tools.ts";

for (const defaults of [undefined, ["read"]]) test(`real SDK session keeps exact prompt/loadout on startup and reload (${defaults?.join() ?? "defaults"})`, async () => {
	const previous = process.env.PI_CODING_AGENT_DIR;
	const directory = mkdtempSync(join(tmpdir(), "compact-tools-host-token-"));
	process.env.PI_CODING_AGENT_DIR = directory;
	writeFileSync(join(directory, "compact-tools.json"), JSON.stringify({ tools: ["read", "write", "edit", "bash", "powershell", "grep", "find", "ls"] }));
	try {
		const snapshots = [];
		for (const enabled of [false, true]) {
			const settingsManager = SettingsManager.inMemory(defaults ? { defaultTools: defaults } : {});
			const loader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
				noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
				extensionFactories: enabled ? [compactTools] : [],
			});
			await loader.reload();
			const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager,
				resourceLoader: loader, sessionManager: SessionManager.inMemory(directory) });
			try {
				await session.bindExtensions({ mode: "print" });
				const snapshot = () => ({ active: session.getActiveToolNames(), prompt: session.systemPrompt,
					declarations: session.agent.state.tools.map(({ name, description, parameters }) => ({ name, description, parameters })) });
				const before = snapshot();
				await session.reload();
				assert.deepEqual(snapshot(), before, "reload must not change model input");
				snapshots.push(before);
			} finally { session.dispose(); }
		}
		assert.deepEqual(snapshots[1], snapshots[0], "extension must add zero model-facing declarations/prompt text");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
