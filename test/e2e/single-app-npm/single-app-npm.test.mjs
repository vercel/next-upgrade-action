import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { agentUser, proxyTokenPattern, stopAgent } from "../../../scripts/run-agent.mjs";
import { git } from "../../helpers.mjs";
import {
  agentProcesses,
  describeE2e,
  exec,
  installedVersion,
  targetVersion,
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
    error: /locks next to 15\.5\.0 instead of 15\.5\.1/u,
  },
  { name: "nothing", status: "failed", error: /did not change any files/u },
  { name: "unverified", status: "failed", error: /Claude did not confirm app verification/u },
  // The failed agent command is logged, and its arguments carry the proxy token.
  { name: "crash", status: "failed", error: /Claude upgrade and verification failed/u },
];

async function assertPatchApplies({ work, consumer, patchPath }) {
  const applied = join(work, "applied");
  git({ cwd: work, args: ["clone", "--quiet", consumer, applied] });
  git({ cwd: applied, args: ["apply", "--index", patchPath] });
  assert.deepEqual(
    git({ cwd: applied, args: ["diff", "--cached", "--name-only"] })
      .toString()
      .trim()
      .split("\n"),
    ["package-lock.json", "package.json"],
  );
  const lock = JSON.parse(await readFile(join(applied, "package-lock.json"), "utf8"));
  assert.equal(lock.packages["node_modules/next"].version, targetVersion);
}

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
        assert.equal(run.code, scenario.status === "prepared" ? 0 : 1, run.output);
        if (scenario.status === "prepared") {
          assert.deepEqual(run.index, {
            baseSha: run.baseSha,
            status: "prepared",
            candidate: { id: run.id, fromVersion: installedVersion, targetVersion },
          });
          assert.deepEqual((await readdir(run.artifacts)).sort(), [
            `${run.id}.patch`,
            "index.json",
          ]);
          await assertPatchApplies({
            work: run.work,
            consumer: run.consumer,
            patchPath: join(run.artifacts, `${run.id}.patch`),
          });
        } else {
          assert.deepEqual(run.index, { baseSha: run.baseSha, status: "failed" });
          assert.deepEqual(await readdir(run.artifacts), ["index.json"]);
          assert.match(run.stderr, scenario.error);
        }

        // The upstream only ever saw the real credential: once from the key check and once
        // through the proxy, never the proxy token.
        assert.deepEqual(
          run.requests.map(({ method, url }) => `${method} ${url}`),
          ["GET /v1/models", "GET /v1/models"],
        );
        for (const { headers } of run.requests) {
          assert.equal(headers["x-api-key"], run.credential);
          assert.equal(headers["anthropic-version"], "2023-06-01");
          assert.equal(headers.authorization, undefined);
          assert.doesNotMatch(JSON.stringify(headers), proxyTokenPattern);
        }
      });
    }
  },
});
