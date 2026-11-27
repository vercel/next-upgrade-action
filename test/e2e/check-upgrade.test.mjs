import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { chmod, mkdtemp, readdir, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, test } from "node:test";

import { candidateKey } from "../../scripts/upgrade.mjs";
import { createRepository, git, scriptsDirectory, tempDirectory } from "../unit/utils.mjs";
import { describeE2E } from "./utils.mjs";

const oneLockfile =
  /need exactly one committed package-lock\.json, pnpm-lock\.yaml, or yarn\.lock/u;

describeE2E("check-upgrade stage", () => {
  const readyHandoff = JSON.stringify({
    status: "ready",
    installedVersion: "15.5.0",
    targetVersion: "15.5.4",
    prompt: "Upgrade Next.js.",
  });

  function appFiles(prefix) {
    return {
      [join(prefix, "package.json")]:
        `${JSON.stringify({ name: "app", version: "1.0.0", private: true }, null, 2)}\n`,
      [join(prefix, "package-lock.json")]: `${JSON.stringify(
        {
          name: "app",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: { "": { name: "app", version: "1.0.0" } },
        },
        null,
        2,
      )}\n`,
    };
  }

  async function sharedRepository({ files }) {
    const directory = await realpath(await mkdtemp(join(tmpdir(), "next-upgrade-test-consumer-")));
    const baseSha = await createRepository({ directory, files });
    return { directory, baseSha };
  }

  async function checkUpgrade({ t, root, appPath, policy, cli }) {
    const scratchTmp = await tempDirectory({ t, prefix: "next-upgrade-test-tmp-" });
    // The agent user installs the dependencies in the scratch under TMPDIR.
    await chmod(scratchTmp, 0o755);
    const files = await tempDirectory({ t, prefix: "next-upgrade-test-files-" });
    const cliDirectory = await tempDirectory({ t, prefix: "next-upgrade-test-cli-" });
    const record = join(cliDirectory, "record.jsonl");
    const script = join(cliDirectory, "next.mjs");
    const config = JSON.stringify({
      record,
      version: cli.version ?? "Next.js v15.5.0",
      handoff: cli.handoff,
      modify: cli.modify,
    });
    await writeFile(
      script,
      `import { appendFileSync, writeFileSync } from "node:fs";
const config = ${config};
appendFileSync(
  config.record,
  JSON.stringify({ args: process.argv.slice(2), cwd: process.cwd(), env: process.env }) + "\\n",
);
if (process.argv[2] === "--version") {
  process.stdout.write(config.version + "\\n");
} else if (process.argv[2] === "upgrade") {
  if (config.modify) {
    writeFileSync("package.json", "{}\\n");
  }
  writeFileSync(process.env.__NEXT_AGENT_UPGRADE_CI_HANDOFF, config.handoff);
} else {
  process.exit(2);
}
`,
    );
    const outputPath = join(files, "output");
    const summaryPath = join(files, "summary");
    await writeFile(outputPath, "");
    await writeFile(summaryPath, "");
    const result = spawnSync(process.execPath, [join(scriptsDirectory, "upgrade.mjs")], {
      encoding: "utf8",
      env: {
        PATH: process.env.PATH,
        HOME: process.env.HOME,
        TMPDIR: scratchTmp,
        CHECK_UPGRADE_SENTINEL: "check-upgrade-sentinel",
        NEXT_UPGRADE_STAGE: "check-upgrade",
        NEXT_UPGRADE_ROOT: root,
        NEXT_UPGRADE_APP_PATH: appPath ?? ".",
        NEXT_UPGRADE_POLICY: policy ?? "security",
        NEXT_UPGRADE_CLI_PATH: script,
        GITHUB_OUTPUT: outputPath,
        GITHUB_STEP_SUMMARY: summaryPath,
      },
    });

    assert.equal(git({ cwd: root, args: ["status", "--porcelain"] }).toString(), "");
    const leaked = (await readdir(scratchTmp)).filter(
      (entry) => entry.startsWith("next-upgrade-") && !entry.startsWith("next-upgrade-test-"),
    );
    assert.deepEqual(leaked, []);
    const calls = await readFile(record, "utf8").catch((error) => {
      if (error.code === "ENOENT") {
        return "";
      }

      throw error;
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      output: Object.fromEntries(
        (await readFile(outputPath, "utf8"))
          .split("\n")
          .filter(Boolean)
          .map((line) => {
            const index = line.indexOf("=");
            return [line.slice(0, index), line.slice(index + 1)];
          }),
      ),
      summary: await readFile(summaryPath, "utf8"),
      calls: calls
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line)),
      scratchTmp,
    };
  }

  describe("at the repository root", () => {
    let root;
    let baseSha;
    before(async () => {
      ({ directory: root, baseSha } = await sharedRepository({ files: appFiles(".") }));
    });
    after(() => rm(root, { recursive: true, force: true }));

    test("reports a ready upgrade from a scratch checkout", async (t) => {
      const result = await checkUpgrade({ t, root, cli: { handoff: readyHandoff } });
      assert.equal(result.status, 0, result.stderr);
      const id = candidateKey({ path: ".", policy: "security" });
      assert.deepEqual(result.output, { status: "ready", "base-sha": baseSha, "candidate-id": id });
      assert.equal(result.summary, "");
      assert.match(result.stderr, /Ready to upgrade Next\.js from 15\.5\.0 to 15\.5\.4/u);

      assert.equal(result.calls.length, 2);
      const [version, upgrade] = result.calls;
      assert.deepEqual(version.args, ["--version"]);
      assert.deepEqual(upgrade.args, ["upgrade", ".", "--agent=security"]);
      assert.ok(upgrade.cwd.startsWith(join(result.scratchTmp, "next-upgrade-")), upgrade.cwd);
      assert.ok(upgrade.cwd.endsWith(`/${id}`), upgrade.cwd);
      assert.ok(!upgrade.cwd.startsWith(root));
      assert.ok(!version.cwd.startsWith(root));
      assert.equal(upgrade.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION, "15.5.0");
      assert.equal(upgrade.env.__NEXT_AGENT_UPGRADE_CI_GUIDES, `${upgrade.cwd}-guides`);
      assert.equal(upgrade.env.CHECK_UPGRADE_SENTINEL, undefined);
      assert.equal(upgrade.env.NEXT_UPGRADE_ROOT, undefined);
      assert.equal(upgrade.env.GITHUB_OUTPUT, undefined);
      assert.equal(version.env.CHECK_UPGRADE_SENTINEL, undefined);
      assert.equal(version.env.__NEXT_AGENT_UPGRADE_CI_HANDOFF, undefined);
    });

    test("passes the latest policy to the CLI and the candidate id", async (t) => {
      const result = await checkUpgrade({
        t,
        root,
        policy: "latest",
        cli: { handoff: readyHandoff },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output["candidate-id"], candidateKey({ path: ".", policy: "latest" }));
      assert.deepEqual(result.calls[1].args, ["upgrade", ".", "--agent=latest"]);
    });

    test("reports no upgrade for an unaffected app", async (t) => {
      const result = await checkUpgrade({
        t,
        root,
        cli: { handoff: JSON.stringify({ status: "unaffected", reason: "On the newest patch." }) },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output.status, "no_upgrade");
      assert.equal(result.output["base-sha"], baseSha);
      assert.equal(
        result.summary,
        "## Next.js upgrade\n\n- Already up to date for `.`: On the newest patch.\n",
      );
      assert.doesNotMatch(result.stdout, /::warning/u);
    });

    test("reports a blocked upgrade with an escaped warning", async (t) => {
      const reason = "100% held\r\nby policy";
      const result = await checkUpgrade({
        t,
        root,
        cli: { handoff: JSON.stringify({ status: "blocked", reason }) },
      });
      assert.equal(result.status, 0, result.stderr);
      assert.equal(result.output.status, "blocked");
      assert.equal(result.summary, `## Next.js upgrade\n\n- Blocked for \`.\`: ${reason}\n`);
      assert.ok(
        result.stdout
          .split("\n")
          .includes("::warning title=Next.js upgrade blocked::.: 100%25 held%0D%0Aby policy"),
        result.stdout,
      );
    });

    test("fails on an unknown handoff", async (t) => {
      const result = await checkUpgrade({
        t,
        root,
        cli: { handoff: JSON.stringify({ status: "unknown", reason: "Could not tell." }) },
      });
      assert.equal(result.status, 1);
      assert.equal(result.output.status, "failed");
      assert.equal(result.output["base-sha"], baseSha);
      assert.match(result.stderr, /Failed during check/u);
      assert.match(result.stderr, /Could not tell\./u);
      assert.equal(result.summary, "");
    });

    test("fails on a malformed handoff", async (t) => {
      const result = await checkUpgrade({ t, root, cli: { handoff: "{not json" } });
      assert.equal(result.status, 1);
      assert.equal(result.output.status, "failed");
      assert.match(result.stderr, /Invalid Next\.js upgrade handoff JSON/u);
    });

    test("fails on an unsupported ready handoff", async (t) => {
      const result = await checkUpgrade({
        t,
        root,
        cli: {
          handoff: JSON.stringify({
            status: "ready",
            installedVersion: "15.5.4",
            targetVersion: "15.5.0",
            prompt: "Downgrade.",
          }),
        },
      });
      assert.equal(result.status, 1);
      assert.equal(result.output.status, "failed");
      assert.match(result.stderr, /Unsupported Next\.js upgrade handoff/u);
    });

    test("fails on unsupported version output", async (t) => {
      const result = await checkUpgrade({
        t,
        root,
        cli: { version: "Next.js 15.5.0", handoff: readyHandoff },
      });
      assert.equal(result.status, 1);
      assert.equal(result.output.status, "failed");
      assert.match(result.stderr, /Failed during setup/u);
      assert.match(result.stderr, /Unsupported pinned Next\.js CLI version output/u);
      assert.equal(result.calls.length, 1);
    });

    test("fails when the CLI changes the candidate checkout", async (t) => {
      const result = await checkUpgrade({ t, root, cli: { handoff: readyHandoff, modify: true } });
      assert.equal(result.status, 1);
      assert.equal(result.output.status, "failed");
      assert.match(result.stderr, /changed the candidate checkout/u);
    });

    test("rejects an invalid policy", async (t) => {
      const result = await checkUpgrade({
        t,
        root,
        policy: "everything",
        cli: { handoff: readyHandoff },
      });
      assert.equal(result.status, 1);
      assert.deepEqual(result.output, {});
      assert.match(result.stderr, /Use the security or latest upgrade policy/u);
      assert.deepEqual(result.calls, []);
    });

    test("rejects an app path outside the repository", async (t) => {
      const result = await checkUpgrade({
        t,
        root,
        appPath: "../x",
        cli: { handoff: readyHandoff },
      });
      assert.equal(result.status, 1);
      assert.deepEqual(result.output, {});
      assert.match(result.stderr, /Invalid repository-relative upgrade path/u);
      assert.deepEqual(result.calls, []);
    });
  });

  describe("in a nested app", () => {
    let root;
    let baseSha;
    before(async () => {
      ({ directory: root, baseSha } = await sharedRepository({
        files: { "README.md": "# Monorepo\n", ...appFiles("apps/web") },
      }));
    });
    after(() => rm(root, { recursive: true, force: true }));

    test("runs the CLI in the app directory of the scratch checkout", async (t) => {
      const result = await checkUpgrade({
        t,
        root,
        appPath: "apps/web/",
        cli: { handoff: readyHandoff },
      });
      assert.equal(result.status, 0, result.stderr);
      const id = candidateKey({ path: "apps/web", policy: "security" });
      assert.deepEqual(result.output, { status: "ready", "base-sha": baseSha, "candidate-id": id });
      const upgrade = result.calls[1];
      assert.ok(upgrade.cwd.startsWith(join(result.scratchTmp, "next-upgrade-")), upgrade.cwd);
      assert.ok(upgrade.cwd.endsWith(`/${id}/apps/web`), upgrade.cwd);
      assert.equal(upgrade.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION, "15.5.0");
    });

    test("fails when the app has no lockfile", async (t) => {
      const result = await checkUpgrade({ t, root, appPath: ".", cli: { handoff: readyHandoff } });
      assert.equal(result.status, 1);
      assert.equal(result.output.status, "failed");
      assert.match(result.stderr, oneLockfile);
      assert.deepEqual(result.calls, []);
    });
  });

  describe("with an unsupported setup", () => {
    const cases = [
      { name: "a second lockfile", files: { "yarn.lock": "\n" }, error: oneLockfile },
      {
        name: "a Yarn 2 lockfile",
        files: { "package-lock.json": null, "yarn.lock": "\n__metadata:\n  version: 8\n" },
        error: /support Yarn 1, and the app uses a Yarn 2 or later lockfile/u,
      },
      {
        name: "a pnpm workspace",
        files: { "pnpm-workspace.yaml": "packages:\n  - apps/*\n" },
        error: /do not support pnpm workspaces yet/u,
      },
      {
        name: "a quoted packages key in pnpm-workspace.yaml",
        files: { "pnpm-workspace.yaml": '\uFEFF"packages":\n  - apps/*\n' },
        error: /do not support pnpm workspaces yet/u,
      },
      {
        name: "a pnpm workspace above the app",
        appPath: "apps/web",
        files: { "pnpm-workspace.yaml": "ignoredBuiltDependencies: []\n" },
        error: /do not support pnpm workspaces yet/u,
      },
      {
        name: "workspaces in a package.json above the app",
        appPath: "apps/web",
        files: { "package.json": '{ "private": true, "workspaces": ["apps/*"] }\n' },
        error: /do not support apps inside a workspace yet/u,
      },
      { name: "bun.lock", files: { "bun.lock": "{}\n" }, error: /do not support bun\.lock yet/u },
    ];
    for (const { name, appPath, files, error } of cases) {
      test(`fails with ${name}`, async (t) => {
        const directory = await tempDirectory({ t, prefix: "next-upgrade-test-consumer-" });
        const app = { ...appFiles(appPath ?? "."), ...files };
        await createRepository({
          directory,
          files: Object.fromEntries(
            Object.entries(app).filter(([, contents]) => contents !== null),
          ),
        });
        const result = await checkUpgrade({
          t,
          root: directory,
          appPath,
          cli: { handoff: readyHandoff },
        });
        assert.equal(result.status, 1);
        assert.equal(result.output.status, "failed");
        assert.match(result.stderr, error);
        assert.deepEqual(result.calls, []);
      });
    }
  });
});
