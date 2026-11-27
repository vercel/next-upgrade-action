import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { once } from "node:events";
import { chmod, lstat, readdir, readFile, readlink, writeFile } from "node:fs/promises";
import { createServer } from "node:https";
import { join } from "node:path";
import { promisify } from "node:util";

import { agentUser } from "../../scripts/run-agent.mjs";
import { scriptsDirectory } from "../helpers.mjs";

const exec = promisify(execFile);

// Stands in for https://api.anthropic.com. The CI job maps the host to 127.0.0.1 in /etc/hosts
// and lowers net.ipv4.ip_unprivileged_port_start so this server can bind port 443 unprivileged.
export async function startFakeModelApi({ directory }) {
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

export async function writeFakeCli({ directory, installedVersion, targetVersion, prompt }) {
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

export async function installFakeAgent({ path }) {
  const contents = `#!${process.execPath}\n"use strict";\n(${fakeAgent})().catch((error) => {\n  console.error(error);\n  process.exit(1);\n});\n`;
  await writeFile(path, contents, { flag: "wx", mode: 0o755 });
  await chmod(path, 0o755);
  return contents;
}

export function runUpgradeScript({ env, timeout }) {
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
export async function snapshotTree({ directory }) {
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

export async function replyDirectories() {
  return (await readdir("/var/tmp")).filter((name) => name.startsWith("next-upgrade-reply-"));
}
