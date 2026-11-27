import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir } from "node:fs/promises";
import { test } from "node:test";

import { agentUser, stopAgent } from "../../../scripts/run-agent.mjs";
import {
  agentProcesses,
  assertModelRequests,
  assertPrepared,
  describeE2e,
  exec,
  upgradeTestSetup,
} from "../utils.mjs";

const protectedChange = /protected path or unsupported file mode/u;
const scenarios = [
  { name: "happy", status: "prepared" },
  { name: "background", status: "prepared" },
  { name: "node-directory", status: "prepared" },
  { name: "workflow", status: "failed", error: protectedChange },
  { name: "credential", status: "failed", error: /contains the agent credential or proxy token/u },
  { name: "token", status: "failed", error: /contains the agent credential or proxy token/u },
  { name: "symlink", status: "failed", error: protectedChange },
  // The reclaiming chown clears S_ISUID, so the leftover 100755 mode is what gets refused.
  {
    name: "setuid",
    status: "failed",
    error: /special permissions|protected path or unsupported file mode/u,
  },
  // chown and chmod keep S_ISGID on directories, so copyTree refuses it.
  { name: "setgid-directory", status: "failed", error: /special permissions/u },
  {
    name: "wrong-version",
    status: "failed",
    error: /package\.json requires next 15\.5\.0 instead of 15\.5\.1/u,
  },
  { name: "nothing", status: "failed", error: /did not change any files/u },
  { name: "unverified", status: "failed", error: /Claude did not confirm app verification/u },
  // The failed agent command is logged, and its arguments carry the proxy token.
  { name: "crash", status: "failed", error: /Claude upgrade and verification failed/u },
];

describeE2e({
  name: "single npm app",
  suite: () => {
    const { upgrade } = upgradeTestSetup({ files: import.meta.dirname });

    // Inside the PID namespace the kernel reaps leftovers when the agent exits, so stopAgent only
    // has work to do after a timeout. Start an agent process outside any namespace instead.
    test("stopAgent kills every agent process", { timeout: 60_000 }, async (t) => {
      // A failed stopAgent must not leave the sleep behind for the scenarios below.
      t.after(() => exec("sudo", ["-n", "pkill", "-KILL", "-u", agentUser]).catch(() => null));
      const child = spawn("sudo", ["-n", "-u", agentUser, "/bin/sleep", "600"], {
        detached: true,
        stdio: "ignore",
      });
      child.unref();
      for (let attempt = 0; attempt < 40 && (await agentProcesses()) === ""; attempt += 1) {
        await new Promise((resolve) => {
          setTimeout(resolve, 250);
        });
      }

      assert.match(await agentProcesses(), /sleep 600/u);
      await stopAgent();
      assert.equal(await agentProcesses(), "");
    });

    for (const scenario of scenarios) {
      test(`${scenario.name} agent`, { timeout: 300_000 }, async (t) => {
        const run = await upgrade({ t, scenario: scenario.name });
        if (scenario.status === "prepared") {
          await assertPrepared({ run, lockfile: "package-lock.json" });
        } else {
          assert.equal(run.code, 1, run.output);
          assert.deepEqual(run.index, { baseSha: run.baseSha, status: "failed" });
          assert.deepEqual(await readdir(run.artifacts), ["index.json"]);
          assert.match(run.stderr, scenario.error);
        }

        assertModelRequests({ run });
      });
    }
  },
});
