import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

test("automatic calibration saves preserve another session's display preference", async () => {
  const isolated = await mkdtemp(path.join(tmpdir(), "pi-tokrate-store-test-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = isolated;
  const filename = path.join(isolated, "settings.json");
  try {
    await writeFile(filename, JSON.stringify({ unrelated: "preserved", tokrate: { display: { ttft: false }, calibration: {}, baseline: {} } }));
    const { read, write } = await import("../src/store.ts");
    const stale = read();
    const updated = JSON.parse(await readFile(filename, "utf8"));
    updated.tokrate.display.ttft = true;
    await writeFile(filename, JSON.stringify(updated));
    write({ ...stale, calibration: { "test/model": { ratio: 2, samples: 1 } } });
    let persisted = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(persisted.tokrate.display.ttft, true);
    assert.equal(persisted.tokrate.calibration["test/model"].ratio, 2);
    assert.equal(persisted.unrelated, "preserved");

    write({ ...stale, display: { ...stale.display, ttft: false } }, true);
    persisted = JSON.parse(await readFile(filename, "utf8"));
    assert.equal(persisted.tokrate.display.ttft, false);
    assert.equal(persisted.tokrate.calibration["test/model"].ratio, 2);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    await rm(isolated, { recursive: true, force: true });
  }
});
