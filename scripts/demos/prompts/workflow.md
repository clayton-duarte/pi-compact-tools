This is a real terminal demonstration in a disposable workspace. Use only the six direct tools below, with no intermediate prose or codemode.

Phase 1: issue ALL FOUR calls together in a SINGLE assistant message, in this order. These calls are independent and read-only; do not wait for a result between calls.
1. bash: rg -n 'greet|language' demo/greet.ts demo/config.json
2. read demo/greet.ts
3. read demo/config.json
4. bash: node --test --test-reporter=spec demo/greet.test.mjs

After all four results arrive, phase 2: issue BOTH calls together in a SINGLE assistant message, in this order.
5. write demo/notes.md with content "# Greeting\n\nUse a friendly welcome.\n"
6. edit demo/greet.ts: replace "Hello, " with "Welcome, "

Do not run other calls or retry. After phase 2, reply with exactly READY.
