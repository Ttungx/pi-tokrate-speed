import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DEFAULT_DISPLAY, uniform } from "../src/display.ts";
import { renderStatus } from "../src/render.ts";

const theme = { fg: (_style, text) => text };
const snapshot = {
  rate: null, measured: false, tokens: null, seconds: 0, ttft: null,
  deviation: null, thinking: null, answer: null, budget: null,
};
const strip = text => text?.replace(/\x1b\[[0-9;]*m/g, "").replace(/\u200b/g, "");

test("default status enables token-speed styling and first-token latency", () => {
  assert.equal(renderStatus(snapshot, DEFAULT_DISPLAY, theme), "⚡ TPS: --");
  assert.equal(renderStatus(snapshot, uniform(false), theme), undefined);
  assert.deepEqual(Object.keys(DEFAULT_DISPLAY).filter(key => DEFAULT_DISPLAY[key]), ["rate", "ttft"]);
});

test("live and final rates keep one decimal and the original speed-tier colors", () => {
  const cases = [
    [0, "255;68;68", "0.0"],
    [14.9, "255;68;68", "14.9"],
    [15, "255;170;0", "15.0"],
    [29.9, "255;170;0", "29.9"],
    [30, "0;255;136", "30.0"],
    [32.5, "0;255;136", "32.5"],
    [44.9, "0;255;136", "44.9"],
    [45, "68;221;255", "45.0"],
    [119, "68;221;255", "119.0"],
    [128.24, "68;221;255", "128.2"],
    [1000, "68;221;255", "1000.0"],
  ];
  for (const [rate, rgb, value] of cases) {
    for (const measured of [false, true]) {
      const actual = renderStatus({ ...snapshot, rate, measured, deviation: "slow" }, DEFAULT_DISPLAY, theme);
      assert.equal(actual, `⚡ TPS: \x1b[38;2;${rgb}m${value} tok/s\x1b[0m\u200b`);
    }
  }
});

test("TTFT is visible by default and can be hidden through the existing toggle", () => {
  const current = { ...snapshot, rate: 119, ttft: 4313 };
  assert.equal(strip(renderStatus(current, DEFAULT_DISPLAY, theme)), "⚡ TPS: 119.0 tok/s (ttft 4313 ms)");
  assert.equal(strip(renderStatus(current, { ...DEFAULT_DISPLAY, ttft: false }, theme)), "⚡ TPS: 119.0 tok/s");
});

test("extension displays calibrated live rates and authoritative final rates on one status key", async () => {
  const isolated = await mkdtemp(path.join(tmpdir(), "pi-tokrate-speed-test-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  const previousNow = Date.now;
  process.env.PI_CODING_AGENT_DIR = isolated;
  const key = "opencode-go/deepseek-v4.1-flash";
  try {
    await writeFile(path.join(isolated, "settings.json"), JSON.stringify({
      unrelated: "preserved",
      tokrate: { display: DEFAULT_DISPLAY, calibration: { [key]: { ratio: 2, samples: 1 } }, baseline: {} },
    }));
    const { default: extension } = await import("../index.ts");
    const hooks = new Map(), commands = new Map(), statuses = new Map();
    const pi = {
      on(name, handler) { const handlers = hooks.get(name) ?? []; handlers.push(handler); hooks.set(name, handlers); return () => {}; },
      registerCommand(name, command) { commands.set(name, command); },
    };
    const model = { provider: "opencode-go", id: "deepseek-v4.1-flash", maxTokens: 32768 };
    const ctx = {
      model,
      modelRegistry: { find: () => model },
      ui: { theme, notify() {}, setStatus(name, text) { if (text === undefined) statuses.delete(name); else statuses.set(name, text); } },
    };
    let clock = 1000000;
    Date.now = () => clock;
    await extension(pi);
    const emit = async (name, event = {}) => { for (const handler of hooks.get(name) ?? []) await handler(event, ctx); };
    statuses.set("tokrate", "old display");
    await emit("session_start");
    assert.deepEqual([...statuses], [["tokenSpeed", "⚡ TPS: --"]]);
    await emit("agent_start");
    const message = { role: "assistant", provider: model.provider, model: model.id, content: [{ type: "thinking", thinking: "" }], usage: { output: 0 } };
    await emit("message_start", { message });
    await emit("message_update", { message, assistantMessageEvent: { type: "thinking_start" } });
    for (let i = 1; i <= 12; i++) {
      clock = 1000000 + i * 100;
      const delta = "a useful reasoning chunk ";
      message.content[0].thinking += delta;
      await emit("message_update", { message, assistantMessageEvent: { type: "thinking_delta", delta } });
    }
    assert.equal(strip(statuses.get("tokenSpeed")), "⚡ TPS: 80.0 tok/s (ttft 100 ms)");
    message.usage.output = 120;
    await emit("message_end", { message });
    await emit("agent_end", { messages: [message] });
    assert.equal(strip(statuses.get("tokenSpeed")), "⚡ TPS: 109.1 tok/s (ttft 100 ms)");
    assert.deepEqual([...statuses.keys()], ["tokenSpeed"]);
    const persisted = JSON.parse(await readFile(path.join(isolated, "settings.json"), "utf8"));
    assert.equal(persisted.unrelated, "preserved");
    assert.ok(Math.abs(persisted.tokrate.calibration[key].ratio - 2.15) < 1e-10);
    assert.equal(persisted.tokrate.calibration[key].samples, 2);

    model.provider = "magpie";
    model.id = "cpa/gemini-3.8-flash-high";
    clock += 1000;
    await emit("model_select", { model });
    assert.equal(strip(statuses.get("tokenSpeed")), "⚡ TPS: --");
    await emit("agent_start");
    const requestAt = clock;
    const gemini = { role: "assistant", provider: model.provider, model: model.id, content: [], usage: { output: 0 } };
    await emit("message_start", { message: gemini });
    await emit("message_update", { message: gemini, assistantMessageEvent: { type: "thinking_start" } });
    clock = requestAt + 4313;
    await emit("message_update", { message: gemini, assistantMessageEvent: { type: "thinking_delta", delta: "a useful reasoning chunk " } });
    assert.equal(strip(statuses.get("tokenSpeed")), "⚡ TPS: -- (ttft 4313 ms)");
    clock += 500;
    await emit("message_update", { message: gemini, assistantMessageEvent: { type: "text_start" } });
    clock = requestAt + 6813;
    await emit("message_update", { message: gemini, assistantMessageEvent: { type: "text_delta", delta: "a useful answer chunk " } });
    assert.equal(strip(statuses.get("tokenSpeed")), "⚡ TPS: 3.2 tok/s (ttft 4313 ms)");
    gemini.usage.output = 120;
    await emit("message_end", { message: gemini });
    await emit("agent_end", { messages: [gemini] });
    assert.equal(strip(statuses.get("tokenSpeed")), "⚡ TPS: 48.0 tok/s (ttft 4313 ms)");
    await commands.get("tokrate").handler("none", ctx);
    assert.equal(statuses.has("tokenSpeed"), false);
    await commands.get("tokrate").handler("rate", ctx);
    assert.equal(strip(statuses.get("tokenSpeed")), "⚡ TPS: 48.0 tok/s");
  } finally {
    Date.now = previousNow;
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(isolated, { recursive: true, force: true });
  }
});
