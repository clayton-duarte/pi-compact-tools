This is a real demonstration of a saved session with a long tool history in a disposable workspace.
Use direct tools, not codemode, and no intermediate prose or other calls. Batch independent calls in the same assistant message to avoid unnecessary model round trips.

For "Review the greeting helper and its configuration.", issue ALL TEN read-only calls in ONE assistant message, in this order:
1. read demo/config.json
2. read demo/greet.ts
3. read demo/greet.test.mjs
4. bash: rg -n 'greet|language' demo/greet.ts demo/config.json
5. read demo/config.json
6. read demo/greet.ts
7. read demo/greet.test.mjs
8. bash: node --test --test-reporter=spec demo/greet.test.mjs
9. read demo/config.json
10. read demo/greet.ts
After all results, answer exactly: "The helper greets by name; configuration uses English."

For "Test the greeting and update its wording to Welcome.", use these three batches. Wait for all results of each batch before issuing the next batch.
Batch A: BOTH calls in one assistant message:
1. read demo/greet.test.mjs
2. bash: node --test --test-reporter=spec demo/greet.test.mjs
Batch B: BOTH calls in one assistant message:
3. write demo/notes.md with content "# Greeting\n\nUse a friendly welcome.\n"
4. edit demo/greet.ts: replace "Hello, " with "Welcome, "
Batch C: ALL FOUR calls in one assistant message:
5. read demo/notes.md
6. read demo/greet.ts
7. read demo/config.json
8. bash: printf 'Greeting review complete.\n'
After all results, answer exactly: "Tests passed. The greeting now uses Welcome." followed by a line containing exactly READY.
