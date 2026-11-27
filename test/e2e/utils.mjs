// Shared setup for the hermetic run-upgrade e2e tests. Each test directory holds a fixture app
// (app/, next.config.mjs, package.json, and a lockfile) next to its .test.mjs, and calls
// upgradeTestSetup({ files: import.meta.dirname }) much like nextTestSetup in the Next.js repo.
// The tests need a Linux machine prepared like .github/workflows/e2e-test.yml, so they only run
// with NEXT_UPGRADE_E2E=1 on Linux.
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
import { createRepository, scriptsDirectory, tempDirectory } from "../helpers.mjs";

export const exec = promisify(execFile);
export const installedVersion = "15.5.0";
export const targetVersion = "15.5.1";
const enabled = process.env.NEXT_UPGRADE_E2E === "1" && process.platform === "linux";
const nodeDirectory = dirname(process.execPath);
const agentPath = join(nodeDirectory, "claude");
const probePath = join(nodeDirectory, "next-upgrade-e2e-probe");

// Stands in for https://api.anthropic.com. The CI job maps the host to 127.0.0.1 in /etc/hosts
// and lowers net.ipv4.ip_unprivileged_port_start so this server can bind port 443 unprivileged.
async function startFakeModelApi({ directory }) {
  const keyPath = join(directory, "key.pem");
  const certPath = join(directory, "cert.pem");
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
  const requests = [];
  const server = createServer(
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

  return {
    caFile: certPath,
    takeRequests: () => requests.splice(0),
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

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

async function writeFakeCli({ directory, installedVersion, targetVersion, prompt }) {
  const path = join(directory, "next.cjs");
  const options = JSON.stringify({ installedVersion, targetVersion, prompt });
  await writeFile(path, `"use strict";\n(${fakeCli})(${options});\n`);
  return path;
}

// Serialized into the fake `claude` executable. It reads its scenario from the SCENARIO= marker
// that the fake CLI put in the handoff prompt, behaves accordingly, and answers like
// `claude --print --output-format json --json-schema ...`.
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
  const lockNext = (version) => {
    const manifestPath = path.join(root, "package.json");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    manifest.dependencies = { next: version };
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const lockPath = path.join(root, "package-lock.json");
    const lock = JSON.parse(fs.readFileSync(lockPath, "utf8"));
    lock.packages[""].dependencies = { next: version };
    lock.packages["node_modules/next"] = {
      version,
      resolved: `https://registry.npmjs.org/next/-/next-${version}.tgz`,
      license: "MIT",
    };
    fs.writeFileSync(lockPath, `${JSON.stringify(lock, null, 2)}\n`);
  };

  if (scenario !== "nothing") {
    lockNext(scenario === "wrong-version" ? "15.5.0" : "15.5.1");
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
      childProcess.spawn("/bin/sleep", ["600"], { detached: true, stdio: "ignore" }).unref();
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
        } catch {
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

async function installFakeAgent({ path }) {
  const contents = `#!${process.execPath}\n"use strict";\n(${fakeAgent})().catch((error) => {\n  console.error(error);\n  process.exit(1);\n});\n`;
  await writeFile(path, contents, { flag: "wx", mode: 0o755 });
  await chmod(path, 0o755);
  return contents;
}

function runUpgradeScript({ env, timeout }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [join(scriptsDirectory, "upgrade.mjs")], {
      env,
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
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.on("error", reject);
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    });
  });
}

// Every entry with its mode, owner, and content hash, so any change to the tree shows up.
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

async function replyDirectories() {
  return (await readdir("/var/tmp")).filter((name) => name.startsWith("next-upgrade-reply-"));
}

async function fixtureFiles({ directory }) {
  const files = {};
  const walk = async (folder) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      if (entry.isDirectory()) {
        await walk(path);
      } else if (!entry.name.endsWith(".test.mjs")) {
        files[relative(directory, path)] = await readFile(path);
      }
    }
  };

  await walk(directory);
  return files;
}

// Registers the suite, or one skipped test where the machine is not prepared for it.
export function describeE2e({ name, suite }) {
  if (!enabled) {
    test(name, {
      skip: "Set NEXT_UPGRADE_E2E=1 on a Linux machine prepared like .github/workflows/e2e-test.yml.",
    });
    return;
  }

  describe(name, suite);
}

// Installs the fake agent and model API around the suite, and returns `upgrade`, which commits a
// copy of the fixture in `files` as the consumer repository and runs the real run-upgrade stage on
// it. Every run must leave no agent process, consumer change, scratch, or credential behind; the
// test checks the outcome itself.
export function upgradeTestSetup({ files }) {
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

  const upgrade = async ({ t, scenario }) => {
    const work = await tempDirectory({ t, prefix: "next-upgrade-e2e-" });
    // The upgrade script keeps its scratch and the agent home under TMPDIR, so the agent user has
    // to be able to traverse it, and none of the run's files may remain afterwards.
    const scratchParent = await tempDirectory({ t, prefix: "next-upgrade-e2e-tmp-" });
    await chmod(scratchParent, 0o755);
    const consumer = join(work, "consumer");
    await mkdir(consumer);
    const baseSha = await createRepository({
      directory: consumer,
      files: await fixtureFiles({ directory: files }),
    });
    const credential = `sk-ant-e2e-${randomBytes(16).toString("hex")}`;
    const prompt = `Upgrade Next.js from ${installedVersion} to ${targetVersion}. SCENARIO=${scenario}${scenario === "credential" ? ` CREDENTIAL=${credential}` : ""}`;
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
    assert.doesNotMatch(output, new RegExp(credential, "u"));
    assert.doesNotMatch(output, proxyTokenPattern);
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
      requests: api.takeRequests(),
    };
  };

  return { upgrade };
}
