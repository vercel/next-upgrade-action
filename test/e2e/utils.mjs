// The stage needs sudo and the agent user, so these suites only run on a Linux machine prepared
// like .github/workflows/e2e-test.yml.
import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { lookup } from "node:dns/promises";
import { once } from "node:events";
import {
  access,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { after, before, beforeEach, describe, test } from "node:test";
import { promisify } from "node:util";

import { agentUser, proxyTokenPattern } from "../../scripts/run-agent.mjs";
import { candidateKey } from "../../scripts/upgrade.mjs";
import { createRepository, git, scriptsDirectory, tempDirectory } from "../unit/utils.mjs";

export const exec = promisify(execFile);
const installedVersion = "15.5.0";
const targetVersion = "15.5.1";
const enabled = process.env.NEXT_UPGRADE_E2E === "1" && process.platform === "linux";
const nodeDirectory = dirname(process.execPath);
const agentPath = join(nodeDirectory, "claude");
const probePath = join(nodeDirectory, "next-upgrade-e2e-probe");

// Serialized into the fake Next.js CLI. The upgrade script runs it with a stripped environment,
// so everything it needs is passed in as a literal.
function fakeCli({ installedVersion, targetVersion, prompt }) {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const args = process.argv.slice(2);
  if (args.length === 1 && args[0] === "--version") {
    process.stdout.write(`Next.js v${installedVersion}\n`);
    return;
  }

  if (
    args.length !== 3 ||
    args[0] !== "upgrade" ||
    args[1] !== "." ||
    !/^--agent=(?:security|latest)$/u.test(args[2]) ||
    process.env.__NEXT_UPGRADE_EXPECTED_CLI_VERSION !== installedVersion
  ) {
    console.error("Unexpected fake Next.js CLI call:", JSON.stringify(args));
    process.exit(1);
  }

  const guides = process.env.__NEXT_AGENT_UPGRADE_CI_GUIDES;
  fs.mkdirSync(guides, { recursive: true });
  fs.writeFileSync(path.join(guides, "upgrade.md"), "# Upgrade guide\n");
  fs.writeFileSync(
    process.env.__NEXT_AGENT_UPGRADE_CI_HANDOFF,
    JSON.stringify({ status: "ready", installedVersion, targetVersion, prompt }),
  );
}

// Serialized into the fake `claude` executable, which answers like `claude --print --output-format
// json` and takes its scenario from the SCENARIO= marker in the handoff prompt.
async function fakeAgent() {
  const fs = process.getBuiltinModule("node:fs");
  const path = process.getBuiltinModule("node:path");
  const childProcess = process.getBuiltinModule("node:child_process");
  const args = process.argv.slice(2);
  const root = args[args.indexOf("--add-dir") + 1];
  const instructions = args.at(-1);
  const scenario = /SCENARIO=([a-z-]+)/u.exec(instructions)[1];
  const credential = /CREDENTIAL=(\S+)/u.exec(instructions);
  const response = await fetch(new URL("/v1/models", process.env.ANTHROPIC_BASE_URL), {
    headers: { "x-api-key": process.env.ANTHROPIC_API_KEY },
  });
  if (!response.ok) {
    throw new Error(`The agent proxy answered HTTP ${response.status}.`);
  }

  await response.text();
  if (scenario !== "nothing") {
    const version = scenario === "wrong-version" ? "15.5.0" : "15.5.1";
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies = { next: version };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // The stale-lockfile agent leaves the lockfile at the installed version.
    if (scenario !== "stale-lockfile") {
      if (fs.existsSync(path.join(root, "yarn.lock"))) {
        fs.appendFileSync(
          path.join(root, "yarn.lock"),
          `next@${version}:\n  version "${version}"\n  resolved "https://registry.yarnpkg.com/next/-/next-${version}.tgz"\n`,
        );
      } else if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) {
        const lock = fs.readFileSync(path.join(root, "pnpm-lock.yaml"), "utf8");
        fs.writeFileSync(
          path.join(root, "pnpm-lock.yaml"),
          lock.replace(
            "  .: {}\n",
            `  .:\n    dependencies:\n      next:\n        specifier: ${version}\n        version: ${version}\n`,
          ),
        );
      } else {
        const lockPath = path.join(root, "package-lock.json");
        const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
        lock.packages[""].dependencies = { next: version };
        lock.packages["node_modules/next"] = {
          version,
          resolved: `https://registry.npmjs.org/next/-/next-${version}.tgz`,
          license: "MIT",
        };
        fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
      }
    }
  }

  let verified = true;
  switch (scenario) {
    case "workflow":
      fs.mkdirSync(path.join(root, ".github", "workflows"), { recursive: true });
      fs.writeFileSync(path.join(root, ".github", "workflows", "x.yml"), "on: push\n");
      break;
    case "credential":
      fs.writeFileSync(path.join(root, "notes.txt"), `${credential[1]}\n`);
      break;
    case "token":
      fs.writeFileSync(path.join(root, "notes.txt"), `${process.env.ANTHROPIC_API_KEY}\n`);
      break;
    case "symlink":
      fs.symlinkSync("package.json", path.join(root, "linked.json"));
      break;
    case "setuid":
      fs.writeFileSync(path.join(root, "tool.sh"), "#!/bin/sh\n");
      fs.chmodSync(path.join(root, "tool.sh"), 0o4755);
      break;
    case "setgid-directory":
      fs.mkdirSync(path.join(root, "shared"));
      fs.chmodSync(path.join(root, "shared"), 0o2755);
      fs.writeFileSync(path.join(root, "shared", "file.txt"), "shared\n");
      break;
    case "unverified":
      verified = false;
      break;
    case "background":
      childProcess.spawn("/bin/sleep", ["infinity"], { detached: true, stdio: "ignore" }).unref();
      break;
    case "node-directory": {
      const attempts = [
        () =>
          fs.writeFileSync(
            path.join(path.dirname(process.execPath), "next-upgrade-e2e-probe"),
            "x",
          ),
        () => fs.appendFileSync(process.argv[1], "\n// changed by the agent\n"),
      ];
      verified = attempts.every((attempt) => {
        try {
          attempt();
          return false;
        } catch (error) {
          if (error.code !== "EACCES" && error.code !== "EPERM") {
            throw error;
          }

          return true;
        }
      });
      break;
    }

    default:
      break;
  }

  process.stdout.write(
    `${JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      result: "Done.",
      structured_output: { verified, summary: `Ran the ${scenario} scenario.` },
      permission_denials: [],
    })}\n`,
  );
}

async function snapshotTree({ directory }) {
  const entries = [];
  const walk = async (relative) => {
    for (const name of (await readdir(join(directory, relative))).sort()) {
      const path = join(directory, relative, name);
      const info = await lstat(path);
      let digest = "";
      if (info.isSymbolicLink()) {
        digest = await readlink(path);
      } else if (info.isFile()) {
        digest = createHash("sha256")
          .update(await readFile(path))
          .digest("hex");
      }

      entries.push({ path: join(relative, name), mode: info.mode, uid: info.uid, digest });
      if (info.isDirectory()) {
        await walk(join(relative, name));
      }
    }
  };

  await walk(".");
  return entries;
}

export async function agentProcesses() {
  try {
    const { stdout } = await exec("pgrep", ["-a", "-u", agentUser]);
    return stdout.trim();
  } catch (error) {
    if (error.code === 1) {
      return "";
    }

    throw error;
  }
}

export const describeE2E = enabled
  ? describe
  : (name) =>
      test(name, {
        skip: "Set NEXT_UPGRADE_E2E=1 on a Linux machine prepared like .github/workflows/e2e-test.yml.",
      });

// Like nextTestSetup in the Next.js repo, the suite's own directory is the fixture app.
export function upgradeTestSetup({ files }) {
  let fixtures;
  let server;
  let caFile;
  let agentContents;
  const requests = [];

  before(async () => {
    const { address } = await lookup("api.anthropic.com", { family: 4 });
    assert.equal(address, "127.0.0.1", "Map api.anthropic.com to 127.0.0.1 in /etc/hosts.");
    assert.equal(await agentProcesses(), "");
    fixtures = await mkdtemp(join(tmpdir(), "next-upgrade-e2e-api-"));
    // The CI job maps api.anthropic.com to 127.0.0.1 and lowers the unprivileged port range, so
    // this stands in for the model API on port 443.
    const keyPath = join(fixtures, "key.pem");
    const certPath = join(fixtures, "cert.pem");
    await exec("openssl", [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-subj",
      "/CN=api.anthropic.com",
      "-addext",
      "subjectAltName=DNS:api.anthropic.com",
    ]);
    server = createServer(
      { key: await readFile(keyPath), cert: await readFile(certPath) },
      (request, response) => {
        requests.push({ method: request.method, url: request.url, headers: request.headers });
        request.resume();
        response.writeHead(200, { "content-type": "application/json", connection: "close" });
        response.end(
          JSON.stringify({ data: [{ id: "claude-e2e", type: "model" }], has_more: false }),
        );
      },
    );
    server.listen(443, "127.0.0.1");
    await once(server, "listening");
    caFile = certPath;
    const contents = `#!${process.execPath}\n"use strict";\n(${fakeAgent})().catch((error) => {\n  console.error(error);\n  process.exit(1);\n});\n`;
    // after() only removes the fake agent once it is ours, so a claude that was already
    // installed survives the failed write.
    await writeFile(agentPath, contents, { flag: "wx", mode: 0o755 });
    agentContents = contents;
    await chmod(agentPath, 0o755);
  });

  after(async () => {
    if (server) {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
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
    requests.splice(0);
  });

  const upgrade = async ({ t, scenario }) => {
    const work = await tempDirectory({ t, prefix: "next-upgrade-e2e-" });
    // The agent user must traverse the scratch and its home under TMPDIR.
    const scratchParent = await tempDirectory({ t, prefix: "next-upgrade-e2e-tmp-" });
    await chmod(scratchParent, 0o755);
    const consumer = join(work, "consumer");
    await mkdir(consumer);
    const fixtureFiles = {};
    const walk = async (folder) => {
      for (const entry of await readdir(folder, { withFileTypes: true })) {
        const path = join(folder, entry.name);
        if (entry.isDirectory()) {
          await walk(path);
        } else if (!entry.name.endsWith(".test.mjs")) {
          fixtureFiles[relative(files, path)] = await readFile(path);
        }
      }
    };

    await walk(files);
    const baseSha = await createRepository({ directory: consumer, files: fixtureFiles });
    const credential = `sk-ant-e2e-${randomBytes(16).toString("hex")}`;
    const prompt = `Upgrade Next.js from ${installedVersion} to ${targetVersion}. SCENARIO=${scenario}${scenario === "credential" ? ` CREDENTIAL=${credential}` : ""}`;
    const cliPath = join(work, "next.cjs");
    await writeFile(
      cliPath,
      `"use strict";\n(${fakeCli})(${JSON.stringify({ installedVersion, targetVersion, prompt })});\n`,
    );
    const artifacts = join(work, "artifacts");
    const consumerBefore = await snapshotTree({ directory: consumer });
    const repliesBefore = (await readdir("/var/tmp")).filter((name) =>
      name.startsWith("next-upgrade-reply-"),
    );

    const result = await new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [join(scriptsDirectory, "upgrade.mjs")], {
        env: {
          PATH: process.env.PATH,
          ...(process.env.HOME === undefined ? {} : { HOME: process.env.HOME }),
          TMPDIR: scratchParent,
          NODE_EXTRA_CA_CERTS: caFile,
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
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (chunk) => {
        stdout += chunk;
      });
      child.stderr.setEncoding("utf8").on("data", (chunk) => {
        stderr += chunk;
      });
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        child.kill("SIGKILL");
      }, 30_000);
      child.on("error", reject);
      child.on("close", (code, signal) => {
        clearTimeout(timer);
        resolve({ code, signal, stdout, stderr, timedOut });
      });
    });
    const output = `${result.stdout}${result.stderr}`;
    if (result.timedOut) {
      // Killing the script leaves its agent processes behind for the next scenario.
      try {
        await exec("sudo", ["-n", "pkill", "-KILL", "-u", agentUser]);
      } catch (error) {
        // pkill exits 1 without output when nothing was left to kill.
        if (error.code !== 1 || error.stderr !== "") {
          console.error(error);
        }
      }

      assert.fail(`The upgrade script timed out:\n${output}`);
    }

    assert.doesNotMatch(output, new RegExp(credential, "u"));
    assert.doesNotMatch(output, proxyTokenPattern);
    assert.equal(await agentProcesses(), "");
    assert.deepEqual(await snapshotTree({ directory: consumer }), consumerBefore);
    // npm keeps its own node-compile-cache there, so only the upgrade script's entries count.
    assert.deepEqual(
      (await readdir(scratchParent)).filter((entry) => entry.startsWith("next-upgrade-")),
      [],
    );
    assert.deepEqual(
      (await readdir("/var/tmp")).filter((name) => name.startsWith("next-upgrade-reply-")),
      repliesBefore,
    );
    // node's directory is first on the agent's PATH.
    await assert.rejects(access(probePath), { code: "ENOENT" });
    assert.equal(await readFile(agentPath, "utf8"), agentContents);

    return {
      ...result,
      output,
      work,
      consumer,
      baseSha,
      credential,
      artifacts,
      id: candidateKey({ path: ".", policy: "security" }),
      index: JSON.parse(await readFile(join(artifacts, "index.json"), "utf8")),
      requests: requests.splice(0),
    };
  };

  return { upgrade };
}

export async function assertFailed({ run, error }) {
  assert.equal(run.code, 1, run.output);
  assert.deepEqual(run.index, { baseSha: run.baseSha, status: "failed" });
  assert.deepEqual(await readdir(run.artifacts), ["index.json"]);
  assert.match(run.stderr, error);
}

export async function assertPrepared({ run, lockfile }) {
  assert.equal(run.code, 0, run.output);
  assert.deepEqual(run.index, {
    baseSha: run.baseSha,
    status: "prepared",
    candidate: { id: run.id, fromVersion: installedVersion, targetVersion },
  });
  assert.deepEqual((await readdir(run.artifacts)).sort(), [`${run.id}.patch`, "index.json"]);
  const applied = join(run.work, "applied");
  git({ cwd: run.work, args: ["clone", "--quiet", run.consumer, applied] });
  git({ cwd: applied, args: ["apply", "--index", join(run.artifacts, `${run.id}.patch`)] });
  assert.deepEqual(
    git({ cwd: applied, args: ["diff", "--cached", "--name-only"] })
      .toString()
      .trim()
      .split("\n"),
    [lockfile, "package.json"].sort(),
  );
  const manifest = JSON.parse(await readFile(join(applied, "package.json"), "utf8"));
  assert.equal(manifest.dependencies.next, targetVersion);
  assert.match(await readFile(join(applied, lockfile), "utf8"), new RegExp(targetVersion, "u"));
}

// Once from the key check and once through the proxy.
export function assertModelRequests({ run }) {
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
}
