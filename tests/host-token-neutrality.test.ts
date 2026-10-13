import "./pinned-themes.ts";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createAgentSession, DefaultResourceLoader, SessionManager, SettingsManager, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { hostToolSnapshot } from "./host-tool-snapshot.ts";
import compactTools from "../extensions/compact-tools.ts";

const namespace = { name: "metadata", aliases: ["meta"], description: "Metadata test", instructions: "Preserve these instructions" };
const metadataProbe = (pi: ExtensionAPI) => {
	const definition = { name: "metadata_probe", label: "Metadata probe", description: "Exercise tool metadata without a model call",
		parameters: Type.Object({ count: Type.Integer({ minimum: 1, maximum: 3, default: 1 }) }), outputSchema: Type.Array(Type.String()),
		namespace, annotations: { readOnlyHint: true, destructiveHint: false }, promptGuidelines: ["Preserve this guideline"],
		reachesTools: (input: Record<string, unknown>) => String(input.code ?? "").includes("searchTools") ? "all" as const : ["read"],
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }], details: undefined, structuredContent: ["ok"] }),
	};
	pi.registerTool(definition);
};

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
				extensionFactories: enabled ? [metadataProbe, compactTools] : [metadataProbe],
			});
			await loader.reload();
			const { session } = await createAgentSession({ cwd: directory, agentDir: directory, settingsManager,
				resourceLoader: loader, sessionManager: SessionManager.inMemory(directory) });
			try {
				await session.bindExtensions({ mode: "print" });
				const snapshot = () => hostToolSnapshot(session);
				const probe = session.getToolDefinition("metadata_probe") as unknown as { namespace: unknown; reachesTools: (input: Record<string, unknown>) => unknown };
				assert.deepEqual(probe.namespace, namespace, "fixture includes namespace aliases and instructions");
				assert.equal(probe.reachesTools({ code: "await searchTools(\"read\")" }), "all");
				const before = snapshot();
				await session.reload();
				assert.deepEqual(snapshot(), before, "reload must not change model input");
				snapshots.push(before);
			} finally { session.dispose(); }
		}
		assert.deepEqual(snapshots[1], snapshots[0], "extension must preserve declarations, prompt, output schemas, namespace aliases, guidelines and reachesTools");
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(directory, { recursive: true, force: true });
	}
});
