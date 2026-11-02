import assert from "node:assert/strict";
import test from "node:test";
import { Meter } from "../src/meter.ts";

const delta = "a useful reasoning chunk ";

test("sparse streaming falls back to the current turn average", () => {
  const meter = new Meter();
  meter.reset(0);
  meter.markGenerationStart();
  for (const time of [1000, 2500, 4000, 5500]) meter.record(delta, "output", time);
  assert.equal(meter.activeSeconds, 4.5);
  assert.equal(meter.windowRate(5500), 16 / 4.5);
});

test("large batches retain gaps over two seconds in the measured duration", () => {
  const meter = new Meter();
  meter.reset(0);
  meter.markGenerationStart();
  for (const time of [1000, 3500, 6000, 8500]) meter.record(delta, "output", time);
  assert.equal(meter.activeSeconds, 7.5);
  assert.equal(meter.windowRate(8500), 16 / 7.5);
  meter.finish(120);
  assert.equal(meter.turnRate(), 16);
});

test("TTFT is measured at the first substantive delta, not the stream marker", () => {
  const meter = new Meter();
  meter.reset(0);
  meter.markGenerationStart();
  assert.equal(meter.ttft, null);
  meter.record(delta, "thinking", 4313);
  assert.equal(meter.ttft, 4313);
});

test("response boundaries exclude tool time and clear the previous live window", () => {
  const meter = new Meter();
  meter.reset(0);
  meter.markGenerationStart();
  meter.record(delta, "thinking", 1000);
  meter.record(delta, "output", 1100);
  meter.markGenerationStart();
  meter.record(delta, "output", 1600);
  meter.record(delta, "output", 1700);
  assert.equal(meter.activeSeconds, 0.2);
  assert.equal(meter.ttft, 1000);
  assert.equal(meter.windowRate(1700), 40);
});

test("a response delivered in a single timestamp does not invent a speed", () => {
  const meter = new Meter();
  meter.reset(0);
  meter.markGenerationStart();
  meter.record(delta, "output", 1000);
  meter.record(delta, "output", 1000);
  assert.equal(meter.windowRate(1000), null);
  meter.finish(120);
  assert.equal(meter.turnRate(), null);
  assert.equal(meter.ttft, 1000);
});
