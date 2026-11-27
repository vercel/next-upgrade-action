import assert from "node:assert/strict";
import { test } from "node:test";
import { inspect } from "node:util";

import { run, systemCommand } from "../scripts/process.mjs";

const secret = `next-upgrade-${"a".repeat(48)}`;

async function failure({ file, args, timeout }) {
  try {
    await run({ file, args, description: "Probe", timeout });
  } catch (error) {
    return error;
  }

  throw new Error("The command did not fail.");
}

test("a failed command does not log its arguments", async () => {
  const error = await failure({
    file: systemCommand("sh"),
    args: ["-c", "exit 3", `TOKEN=${secret}`],
  });
  assert.equal(error.message, "Probe failed.");
  assert.deepEqual(error.cause, { code: 3, signal: null, killed: false });
  assert.doesNotMatch(inspect(error, { depth: Infinity }), /next-upgrade-a{48}/u);
});

test("a command that cannot start does not log its arguments", async () => {
  const error = await failure({ file: "/nonexistent/next-upgrade-probe", args: [secret] });
  assert.equal(error.message, "Probe failed.");
  assert.equal(error.cause.code, "ENOENT");
  assert.doesNotMatch(inspect(error, { depth: Infinity }), /next-upgrade-a{48}/u);
});

test("a timed out command does not log its arguments", async () => {
  const error = await failure({
    file: systemCommand("sh"),
    args: ["-c", "sleep 5", secret],
    timeout: 100,
  });
  assert.equal(error.message, "Probe timed out.");
  assert.equal(error.cause.killed, true);
  assert.doesNotMatch(inspect(error, { depth: Infinity }), /next-upgrade-a{48}/u);
});
