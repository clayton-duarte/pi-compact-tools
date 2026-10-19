import assert from "node:assert/strict";
import test from "node:test";
import { install } from "@sinonjs/fake-timers";
import { onTick } from "../extensions/compact-tools-clock.ts";

test("indicators and labels use one timer, retain their rates, and stop when idle", () => {
	const clock = install({ toFake: ["setInterval", "clearInterval"] });
	let fast = 0, slow = 0;
	const stopSlow = onTick(() => slow++);
	const stopFast = onTick(() => fast++, 45);
	try {
		assert.equal(clock.countTimers(), 1);
		clock.tick(7_200); // common multiple of 45 and 80
		assert.equal(fast, 160);
		assert.equal(slow, 90, "no cumulative drift in the slower animation");
		stopFast();
		assert.equal(clock.countTimers(), 1);
		clock.tick(80);
		assert.equal(slow, 91, "returns to 80ms when no fast animation remains");
		assert.equal(fast, 160);
		stopSlow();
		assert.equal(clock.countTimers(), 0);
		clock.tick(1_000);
		assert.equal(slow, 91);
	} finally { stopFast(); stopSlow(); clock.uninstall(); }
});

test("dispatch skips disposed listeners and gives newly added listeners their own next tick", () => {
	const clock = install({ toFake: ["setInterval", "clearInterval"] });
	let later = 0, added = 0;
	let stopLater = () => {}, stopAdded = () => {};
	const stopFirst = onTick(() => { stopLater(); if (!added) stopAdded = onTick(() => added++, 80); }, 80);
	stopLater = onTick(() => later++, 80);
	try {
		clock.tick(80);
		assert.equal(later, 0);
		assert.equal(added, 0);
		stopFirst();
		clock.tick(80);
		assert.equal(added, 1);
	} finally { stopFirst(); stopLater(); stopAdded(); clock.uninstall(); }
});

test("invalid animation periods cannot start a runaway clock", () => {
	for (const period of [0, -1, NaN, Infinity]) assert.throws(() => onTick(() => {}, period), RangeError);
});
