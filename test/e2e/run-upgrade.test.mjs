// Hermetic end-to-end run of the run-upgrade stage. It needs a Linux machine prepared like the
// reusable workflow's "Create the agent user" step plus the fake model API wiring in the e2e job
// of .github/workflows/ci.yml, so it only runs there (NEXT_UPGRADE_E2E=1).
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { access, chmod, mkdir, mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { agentUser, proxyTokenPattern, stopAgent } from "../../scripts/run-agent.mjs";
import { candidateKey } from "../../scripts/upgrade.mjs";
import { createRepository, git, tempDirectory } from "../helpers.mjs";
import {
  agentProcesses,
  installFakeAgent,
  replyDirectories,
  runUpgradeScript,
  snapshotTree,
  startFakeModelApi,
  writeFakeCli,
} from "./helpers.mjs";

const exec = promisify(execFile);
const enabled = process.env.NEXT_UPGRADE_E2E === "1" && process.platform === "linux";
const installedVersion = "15.5.0";
const targetVersion = "15.5.1";
const nodeDirectory = dirname(process.execPath);
const agentPath = join(nodeDirectory, "claude");
const probePath = join(nodeDirectory, "next-upgrade-e2e-probe");
const json = (value) => `${JSON.stringify(value, null, 2)}\n`;
const baseFiles = {
  "package.json": json({ name: "e2e-app", version: "1.0.0", private: true }),
  "package-lock.json": json({
    name: "e2e-app",
    version: "1.0.0",
    lockfileVersion: 3,
    requires: true,
    packages: { "": { name: "e2e-app", version: "1.0.0" } },
  }),
  "app/page.js": "export default function Page() {\n  return null;\n}\n",
};
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

if (enabled) {
  describe("run-upgrade end to end", () => {
    let fixtures;
    let api;
    let agentContents;

    before(async () => {
      const { address } = await lookup("api.anthropic.com", { family: 4 });
      assert.equal(address, "127.0.0.1", "Map api.anthropic.com to 127.0.0.1 in /etc/hosts.");
      assert.equal(await agentProcesses(), "");
      fixtures = await mkdtemp(join(tmpdir(), "next-upgrade-e2e-api-"));
      api = await startFakeModelApi({ directory: fixtures });
      agentContents = await installFakeAgent({ path: agentPath });
    });

    after(async () => {
      if (api) {
        await api.close();
      }

      if (agentContents) {
        await rm(agentPath, { force: true });
      }

      await rm(probePath, { force: true });
      if (fixtures) {
        await rm(fixtures, { recursive: true, force: true });
      }
    });

    beforeEach(async () => {
      assert.equal(await agentProcesses(), "");
      api.takeRequests();
    });

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
        const work = await tempDirectory({ t, prefix: "next-upgrade-e2e-" });
        // The upgrade script keeps its scratch and the agent home under TMPDIR, so the agent
        // user has to be able to traverse it, and none of the run's files may remain afterwards.
        const scratchParent = await tempDirectory({ t, prefix: "next-upgrade-e2e-tmp-" });
        await chmod(scratchParent, 0o755);
        const consumer = join(work, "consumer");
        await mkdir(consumer);
        const baseSha = await createRepository({ directory: consumer, files: baseFiles });
        const credential = `sk-ant-e2e-${randomBytes(16).toString("hex")}`;
        const prompt = `Upgrade Next.js from ${installedVersion} to ${targetVersion}. SCENARIO=${scenario.name}${scenario.name === "credential" ? ` CREDENTIAL=${credential}` : ""}`;
        const cliPath = await writeFakeCli({
          directory: work,
          installedVersion,
          targetVersion,
          prompt,
        });
        const artifacts = join(work, "artifacts");
        const consumerBefore = await snapshotTree({ directory: consumer });
        const repliesBefore = await replyDirectories();

        const result = await runUpgradeScript({
          timeout: 240_000,
          env: {
            PATH: process.env.PATH,
            ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
            TMPDIR: scratchParent,
            NODE_EXTRA_CA_CERTS: api.caFile,
            NEXT_UPGRADE_STAGE: "run-upgrade",
            NEXT_UPGRADE_ROOT: consumer,
            NEXT_UPGRADE_ARTIFACT_DIR: artifacts,
            NEXT_UPGRADE_CLI_PATH: cliPath,
            NEXT_UPGRADE_APP_PATH: ".",
            NEXT_UPGRADE_POLICY: "security",
            NEXT_UPGRADE_AGENT: "claude",
            NEXT_UPGRADE_AUTH: "api-key",
            NEXT_UPGRADE_MODEL: "",
            NEXT_UPGRADE_EFFORT: "",
            NEXT_UPGRADE_AGENT_CREDENTIAL: credential,
          },
        });
        const output = `${result.stdout}${result.stderr}`;
        assert.equal(result.code, scenario.status === "prepared" ? 0 : 1, output);

        const id = candidateKey({ path: ".", policy: "security" });
        const index = JSON.parse(await readFile(join(artifacts, "index.json"), "utf8"));
        if (scenario.status === "prepared") {
          assert.deepEqual(index, {
            baseSha,
            status: "prepared",
            candidate: { id, fromVersion: installedVersion, targetVersion },
          });
          assert.deepEqual((await readdir(artifacts)).sort(), [`${id}.patch`, "index.json"]);
          await assertPatchApplies({ work, consumer, patchPath: join(artifacts, `${id}.patch`) });
        } else {
          assert.deepEqual(index, { baseSha, status: "failed" });
          assert.deepEqual(await readdir(artifacts), ["index.json"]);
          assert.match(result.stderr, scenario.error);
        }

        // The upstream only ever saw the real credential: once from the key check and once
        // through the proxy, never the proxy token.
        const requests = api.takeRequests();
        assert.deepEqual(
          requests.map(({ method, url }) => `${method} ${url}`),
          ["GET /v1/models", "GET /v1/models"],
        );
        for (const { headers } of requests) {
          assert.equal(headers["x-api-key"], credential);
          assert.equal(headers["anthropic-version"], "2023-06-01");
          assert.equal(headers.authorization, undefined);
          assert.doesNotMatch(JSON.stringify(headers), proxyTokenPattern);
        }

        assert.doesNotMatch(output, new RegExp(credential, "u"));
        assert.doesNotMatch(output, proxyTokenPattern);

        // No agent process outlives the run, the consumer checkout is untouched, and every
        // file the agent owned was reclaimed so the scratch could be removed.
        assert.equal(await agentProcesses(), "");
        assert.deepEqual(await snapshotTree({ directory: consumer }), consumerBefore);
        // npm keeps its own node-compile-cache there, so only the upgrade script's entries count.
        assert.deepEqual(
          (await readdir(scratchParent)).filter((entry) => entry.startsWith("next-upgrade-")),
          [],
        );
        assert.deepEqual(await replyDirectories(), repliesBefore);
        for (const entry of consumerBefore) {
          assert.equal(entry.uid, process.getuid(), entry.path);
        }

        // The agent user cannot write next to node, which is first on its PATH.
        await assert.rejects(access(probePath), { code: "ENOENT" });
        assert.equal(await readFile(agentPath, "utf8"), agentContents);
      });
    }
  });
} else {
  test("run-upgrade end to end", {
    skip: "Set NEXT_UPGRADE_E2E=1 on a Linux machine prepared by the e2e job in ci.yml.",
  });
}
