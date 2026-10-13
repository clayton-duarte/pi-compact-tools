import type { AgentToolResult, Theme } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences } from "@earendil-works/pi-tui";
import { countEditChanges } from "./compact-tools-invocation.ts";

const SUMMARY_KEY = Symbol.for("pi-compact-tools.nested-summaries.v1");
const MAX_PARENTS = 2_000;
const MAX_CALLS = 256;
const EDIT_PREVIEW_CALLS = 3;
const MAX_NAME_LENGTH = 256;
const MAX_ID_LENGTH = 1_024;
type Status = "ok" | "error" | "unfinished";
type Call = { name: string; status: Status; changes?: { added: number; removed: number } };
type Summary = { calls: Map<string, Call>; partial: boolean; finished: boolean; live: boolean; revision: object };
type Shared = typeof globalThis & { [SUMMARY_KEY]?: Map<string, Summary> };
type NestedEvent = { toolCallId: string; toolName: string; parentToolCallId?: string; isError?: boolean; result?: unknown };

/** UI-only, bounded bookkeeping. Never retain arguments, results, or full diffs. */
export class NestedCallSummaries {
	private readonly summaries: Map<string, Summary>;

	constructor() {
		const shared = globalThis as Shared;
		this.summaries = shared[SUMMARY_KEY] ??= new Map();
	}

	clear(): void {
		this.summaries.clear();
	}

	begin(id: string, name: string): void {
		if (name !== "codemode" || id.length > MAX_ID_LENGTH) return;
		this.summaries.delete(id);
		this.summaries.set(id, { calls: new Map(), partial: false, finished: false, live: true, revision: {} });
		this.trim();
	}

	finish(id: string): void {
		const summary = this.summaries.get(id);
		if (summary) {
			summary.finished = true;
			summary.revision = {};
		}
	}

	/** A revision is also read at draw time, so even a late child end cannot freeze a footer. */
	revision(id: string): object | undefined {
		return this.summaries.get(id)?.revision;
	}

	/** Host-assigned descendant ids are `<caller id>/<n>`; retain the whole provider root id. */
	private root(parent: string): string | undefined {
		let id = parent;
		while (id) {
			if (this.summaries.has(id)) return id;
			const slash = id.lastIndexOf("/");
			if (slash < 0) return undefined;
			id = id.slice(0, slash);
		}
		return undefined;
	}

	/** Returns true only when a finished parent needs a fresh terminal frame. */
	note(event: NestedEvent, ended: boolean): boolean {
		if (typeof event.parentToolCallId !== "string" || event.parentToolCallId.length > MAX_ID_LENGTH) return false;
		const root = this.root(event.parentToolCallId);
		const summary = root === undefined ? undefined : this.summaries.get(root);
		if (!summary) return false;
		if (typeof event.toolCallId !== "string" || typeof event.toolName !== "string"
			|| event.toolCallId.length > MAX_ID_LENGTH || event.toolName.length > MAX_NAME_LENGTH) {
			if (!summary.partial) { summary.partial = true; summary.revision = {}; }
			return summary.finished;
		}
		const previous = summary.calls.get(event.toolCallId);
		// A duplicate start must not turn an already settled call back into a running one.
		if (!ended && previous) return false;
		if (!previous && summary.calls.size >= MAX_CALLS) {
			if (!summary.partial) { summary.partial = true; summary.revision = {}; }
			return summary.finished;
		}
		const status = ended ? event.isError ? "error" : "ok" : "unfinished";
		const result = event.result;
		const changes = status === "ok" && event.toolName === "edit" && result && typeof result === "object"
			? countEditChanges(result as AgentToolResult<unknown>) : undefined;
		if (previous?.name === event.toolName && previous.status === status
			&& previous.changes?.added === changes?.added && previous.changes?.removed === changes?.removed) return false;
		summary.calls.set(event.toolCallId, { name: event.toolName, status, ...(changes ? { changes } : {}) });
		summary.live = true;
		summary.revision = {};
		return summary.finished;
	}

	/** Pi persists `{calls: [{id, name, status}], complete}`, deliberately without results. */
	restore(message: unknown): boolean {
		if (!message || typeof message !== "object") return false;
		const value = message as { role?: string; toolName?: string; toolCallId?: string; nestedCalls?: { calls?: unknown; complete?: unknown } };
		if (value.role !== "toolResult" || value.toolName !== "codemode" || typeof value.toolCallId !== "string"
			|| value.toolCallId.length > MAX_ID_LENGTH || !Array.isArray(value.nestedCalls?.calls)) return false;
		// A bounded persisted snapshot must not overwrite exact live edit totals or drop observed calls.
		const existing = this.summaries.get(value.toolCallId);
		if (existing?.live && existing.calls.size > 0) return false;
		const summary: Summary = { calls: new Map(), partial: value.nestedCalls.complete !== true, finished: true, live: false, revision: {} };
		let inspected = 0;
		for (const item of value.nestedCalls.calls) {
			if (inspected++ >= MAX_CALLS) { summary.partial = true; break; }
			if (!item || typeof item !== "object") { summary.partial = true; continue; }
			const call = item as { id?: unknown; name?: unknown; status?: unknown };
			if (typeof call.id !== "string" || typeof call.name !== "string"
				|| call.id.length > MAX_ID_LENGTH || call.name.length > MAX_NAME_LENGTH
				|| (call.status !== "ok" && call.status !== "error" && call.status !== "unfinished")) { summary.partial = true; continue; }
			if (!summary.calls.has(call.id) && summary.calls.size >= MAX_CALLS) { summary.partial = true; break; }
			summary.calls.set(call.id, { name: call.name, status: call.status as Status });
		}
		this.summaries.set(value.toolCallId, summary);
		this.trim();
		return true;
	}

	/** The live branch only, never abandoned entries; callers clear on non-reload session changes. */
	restoreBranch(entries: readonly unknown[]): void {
		for (const entry of entries) {
			if (entry && typeof entry === "object") this.restore((entry as { message?: unknown }).message);
		}
	}

	/** Most tools group by outcome; edits keep every call's status and diff in start order. */
	format(id: string, theme: Theme, expanded = false): string | undefined {
		const summary = this.summaries.get(id);
		if (!summary || (summary.calls.size === 0 && !summary.partial)) return undefined;
		const groups = new Map<string, { name: string; status: Status; calls: Call[] }>();
		for (const call of summary.calls.values()) {
			const key = JSON.stringify([call.name, call.name === "edit" ? "all" : call.status]);
			let group = groups.get(key);
			if (!group) groups.set(key, group = { name: call.name, status: call.status, calls: [] });
			group.calls.push(call);
		}
		const parts: string[] = [];
		for (const group of groups.values()) {
			const color = group.status === "ok" ? "success" : group.status === "error" ? "error" : "warning";
			const glyph = group.status === "ok" ? "✓" : group.status === "error" ? "✗" : "?";
			const name = stripTerminalSequences(group.name).replace(/[\x00-\x20\x7f-\x9f]/gu, " ").replace(/[\u200b-\u200f\u202a-\u202e\u2060-\u206f\ufeff]/gu, "").trim() || "tool";
			if (group.name === "edit") {
				// Include failures and unfinished calls in the same ordered list. A
				// missing successful diff loses only its numbers, not other calls' diffs.
				const shown = expanded ? group.calls : group.calls.slice(0, EDIT_PREVIEW_CALLS);
				const entries = shown.map((call) => {
					if (call.status === "error") return theme.fg("error", "✗");
					if (call.status === "unfinished") return theme.fg("warning", "?");
					return call.changes
						? theme.fg("toolDiffAdded", `+${call.changes.added}`) + " " + theme.fg("toolDiffRemoved", `-${call.changes.removed}`)
						: theme.fg("dim", "ok");
				});
				const hidden = group.calls.slice(shown.length);
				if (hidden.length > 0) {
					// The preview must not hide that an omitted edit failed or is unfinished.
					const failed = hidden.filter((call) => call.status === "error").length;
					const unfinished = hidden.filter((call) => call.status === "unfinished").length;
					let more = theme.fg("dim", `… +${hidden.length} more`);
					const statuses = [failed ? theme.fg("error", `${failed} failed`) : "", unfinished ? theme.fg("warning", `${unfinished} unfinished`) : ""].filter(Boolean);
					if (statuses.length > 0) more += " (" + statuses.join(", ") + ")";
					entries.push(more);
				}
				parts.push(`${name}(${group.calls.length}) [` + entries.join(theme.fg("dim", "|")) + "]");
			} else parts.push(theme.fg(color, glyph) + ` ${name}(${group.calls.length})`);
		}
		if (summary.partial || [...summary.calls.values()].some((call) => call.status === "unfinished")) parts.push(theme.fg("warning", "(partial)"));
		return parts.join(" ");
	}

	private trim(): void {
		if (this.summaries.size <= MAX_PARENTS) return;
		for (const [id, summary] of this.summaries) {
			if (summary.finished) { this.summaries.delete(id); return; }
		}
		const oldest = this.summaries.keys().next().value;
		if (oldest !== undefined) this.summaries.delete(oldest);
	}
}
