import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

test("greeting helper exports a typed function", () => {
  const source = readFileSync(new URL("./greet.ts", import.meta.url), "utf8");
  assert.match(source, /export function greet\(name: string\): string/);
  assert.match(source, /Hello, \$\{name\}!/);
});
