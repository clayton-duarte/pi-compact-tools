import assert from "node:assert/strict";
import test from "node:test";
import { attemptUI } from "../extensions/compact-tools-transcript.ts";

// The production lifecycle tests exercise the real controller inventory. Keep the
// collector contract explicit too: a failed step cannot stop an independent step.
test("UI failure collection preserves diagnostics and continues independent cleanup", () => {
	const failures: Parameters<typeof attemptUI>[0] = [];
	const error = new Error("host cleanup failed");
	let cleaned = false;
	attemptUI(failures, "bad cleanup", () => { throw error; });
	attemptUI(failures, "good cleanup", () => { cleaned = true; });
	assert.equal(cleaned, true);
	assert.deepEqual(failures, [{ operation: "bad cleanup", error }]);
});
