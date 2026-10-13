// Verify actual host session records, not just a READY string in a screenshot.
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const [directory, demo, version, historyBefore] = process.argv.slice(2);
function sessionFiles(path) {
  return readdirSync(path, { withFileTypes: true }).flatMap(entry =>
    entry.isDirectory() ? sessionFiles(join(path, entry.name)) :
      entry.name.endsWith(".jsonl") ? [join(path, entry.name)] : []);
}
const runs = sessionFiles(directory).map(path => {
  const entries = readFileSync(path, "utf8").trim().split("\n").map(line => JSON.parse(line));
  return { entries, messages: entries.filter(entry => entry.type === "message").map(entry => entry.message) };
}).sort((a, b) => String(a.entries[0].timestamp).localeCompare(String(b.entries[0].timestamp)));
const { messages, entries } = runs.at(-1) ?? {};
assert.ok(messages, "No real Pi session was recorded");
const results = messages.filter(message => message.role === "toolResult");
const assistant = messages.filter(message => message.role === "assistant").at(-1);
assert.ok(assistant?.content.some(block => block.type === "text" && /\bREADY\s*$/.test(block.text)), "Missing final answer");
assert.ok(results.every(result => !result.isError), "Unexpected top-level tool failure");
const expected = demo === "nested-calls" ? ["codemode"] :
  demo === "silent-history" ? [
    "read", "read", "read", "bash", "read", "read", "read", "bash", "read", "read",
    "read", "bash", "write", "edit", "read", "read", "read", "bash",
  ] :
  demo === "silent-mode" ? ["read", "bash", "edit"] :
    ["bash", "read", "read", "bash", "write", "edit"];
assert.deepEqual(results.map(result => result.toolName), expected, "Unexpected tool sequence");
const batches = messages.filter(message => message.role === "assistant")
  .map(message => message.content.filter(block => block.type === "toolCall").length).filter(Boolean);
if (["overview", "claude-style", "codex-style", "compact-workflow"].includes(demo)) {
  assert.deepEqual(batches, [4, 2], "Independent tools were not batched into two model requests");
}
if (demo === "silent-mode") assert.deepEqual(batches, [2, 1]);
if (demo === "silent-history") assert.deepEqual(batches, [10, 2, 2, 4]);
const nested = results.flatMap(result => result.nestedCalls?.calls ?? []).map(({ name, status }) => ({ name, status }));
if (demo === "nested-calls") {
  assert.equal(results[0].nestedCalls.complete, true);
  assert.deepEqual(nested, [
    ...Array.from({ length: 3 }, () => ({ name: "read", status: "ok" })),
    { name: "bash", status: "ok" },
    ...Array.from({ length: 3 }, () => ({ name: "edit", status: "ok" })),
    ...Array.from({ length: 2 }, () => ({ name: "edit", status: "error" })),
  ]);
}
if (demo === "silent-history") {
  assert.equal(messages.filter(message => message.role === "user").length, 2);
  if (historyBefore) {
    const previousMessages = readFileSync(historyBefore, "utf8").trim().split("\n")
      .map(line => JSON.parse(line)).filter(entry => entry.type === "message").map(entry => entry.message);
    assert.deepEqual(messages, previousMessages, "Resuming/toggling silent mode changed saved conversation records");
  }
}
const model = entries.findLast(entry => entry.type === "model_change");
const thinking = entries.findLast(entry => entry.type === "thinking_level_change");
console.log(JSON.stringify({ demo, version, verified: true, tools: expected, nested,
  model: model ? `${model.provider}/${model.modelId}` : undefined,
  thinkingLevel: thinking?.thinkingLevel, assistantToolBatches: batches,
  ...(demo === "silent-history" ? { resumed: Boolean(historyBefore), preservedToolRecords: results.length, userMessages: 2 } : {}),
}, null, 2));
