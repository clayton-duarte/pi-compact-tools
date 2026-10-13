This is a real codemode demonstration in a disposable workspace. Make exactly ONE codemode call, running this JavaScript as written. Do not run other calls or retry the intentional failures. The two missing-text edits are intentional: they demonstrate genuine failed tool outcomes. Print only the concise output below (never file contents or Error stacks).

await Promise.allSettled(["demo/greet.ts", "demo/config.json", "demo/greet.test.mjs"].map(path => tools.read({path})));
await tools.bash({command: "node --test --test-reporter=dot demo/greet.test.mjs"});
for (const [oldText, newText] of [["Hello, ", "Welcome, "], ["Welcome, ", "Hi, "], ["Hi, ", "Hello, "], ["missing-one", "unused"], ["missing-two", "unused"]]) {
  try { await tools.edit({path: "demo/greet.ts", edits: [{oldText, newText}]}); } catch {}
}
text("Read 3 files, ran tests, applied 3 edits.\n2 intentional missing-text edits failed.");

After the codemode call, reply with exactly READY.
