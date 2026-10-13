import type { AgentSession } from "@earendil-works/pi-coding-agent";

/** Model declarations plus registry metadata: renderer routing must not change either. */
export function hostToolSnapshot(session: AgentSession): unknown {
	const reachInputs = [{ code: 'await tools.read({path:"a.txt"})' }, { code: 'await searchTools("read")' }, { code: "" }];
	const registry = session.getAllTools().map(info => {
		const definition = session.getToolDefinition(info.name) as unknown as Record<string, unknown> | undefined;
		const metadata = Object.fromEntries(Object.entries(definition ?? {}).filter(([key, value]) => !key.startsWith("render") && typeof value !== "function"));
		const reachesTools = definition?.reachesTools as ((input: Record<string, unknown>) => unknown) | undefined;
		return {
			info: Object.fromEntries(Object.entries(info).filter(([, value]) => typeof value !== "function")),
			metadata,
			capabilities: Object.keys(definition ?? {}).filter(key => !key.startsWith("render") && typeof definition?.[key] === "function").sort(),
			reach: reachesTools ? reachInputs.map(input => reachesTools(input)) : undefined,
		};
	});
	// Normalize schemas and optional fields as they would enter a request, not by closure identity.
	return JSON.parse(JSON.stringify({ active: session.getActiveToolNames(), prompt: session.systemPrompt,
		declarations: session.agent.state.tools.map(tool => ({ name: tool.name, description: tool.description, parameters: tool.parameters,
			outputSchema: (tool as unknown as { outputSchema?: unknown }).outputSchema })), registry }));
}
