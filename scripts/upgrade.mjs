import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  appendFile,
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { fileURLToPath } from "node:url";

import semver from "semver";

import { commandEnv, run, sudo, systemCommand, systemPath } from "./process.mjs";
import { agentUser, proxyTokenPattern, runAgent } from "./run-agent.mjs";

const policies = new Set(["security", "latest"]);
const otherLockfiles = [
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
];
export function normalizeUpgradePath(path) {
  if (
    typeof path !== "string" ||
    path.trim() !== path ||
    path.length === 0 ||
    posix.isAbsolute(path) ||
    /[\\:\p{Cc}]/u.test(path) ||
    path.split("/").some((part) => part === ".." || part.toLowerCase() === ".git")
  ) {
    throw new Error("Invalid repository-relative upgrade path.");
  }

  return posix.normalize(path).replace(/\/$/u, "") || ".";
}

export function candidateKey({ path, policy }) {
  return createHash("sha256")
    .update(JSON.stringify({ path: normalizeUpgradePath(path), policy }))
    .digest("hex")
    .slice(0, 24);
}

async function git({ cwd, args, input }) {
  const { stdout } = await run({
    file: systemCommand("git"),
    args: ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", ...args],
    cwd,
    env: {
      ...commandEnv(),
      PATH: systemPath,
      GIT_TEMPLATE_DIR: "",
    },
    description: `Git ${args[0]}`,
    input,
  });

  return stdout;
}

async function checkout({ source, root, baseSha }) {
  await git({
    cwd: source,
    args: ["clone", "--template=", "--no-checkout", "--shared", "--dissociate", "--", source, root],
  });
  await git({ cwd: root, args: ["remote", "remove", "origin"] });
  await git({ cwd: root, args: ["checkout", "--detach", baseSha] });
  await mkdir(join(root, ".git", "info"), { recursive: true });
  await appendFile(join(root, ".git", "info", "exclude"), "\nnode_modules/\n.next/\n");
}

async function copyTree({ source, destination }) {
  for (const entry of await readdir(source)) {
    const from = join(source, entry);
    const to = join(destination, entry);
    const info = await lstat(from);
    if (
      entry === ".git" ||
      (info.isDirectory() && (entry === "node_modules" || entry === ".next"))
    ) {
      continue;
    }

    if ((info.mode & 0o6000) !== 0) {
      throw new Error("The candidate contains a file with special permissions.");
    }

    if (info.isSymbolicLink()) {
      await symlink(await readlink(from), to);
    } else if (info.isDirectory()) {
      await mkdir(to);
      await copyTree({ source: from, destination: to });
    } else if (info.isFile()) {
      const file = await open(from, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        const opened = await file.stat();
        if (opened.dev !== info.dev || opened.ino !== info.ino) {
          throw new Error("The candidate changed while it was copied.");
        }

        await writeFile(to, await file.readFile(), {
          mode: opened.mode & 0o777,
        });
      } finally {
        await file.close();
      }
    } else {
      throw new Error("The candidate contains an unsupported file type.");
    }
  }
}

async function candidatePatch({ root, baseRoot, baseSha, credential }) {
  await git({ cwd: root, args: ["add", "--all"] });
  await git({
    cwd: root,
    args: ["reset", "--quiet", baseSha, "--", ":(glob)**/node_modules/**", ":(glob)**/.next/**"],
  });
  const unchanged = [];
  for (const file of (
    await git({
      cwd: root,
      args: ["diff", "--cached", "--name-only", "-z", "--no-renames", baseSha],
    })
  )
    .toString()
    .split("\0")
    .filter(Boolean)) {
    if (await sameFile({ base: join(baseRoot, file), candidate: join(root, file) })) {
      unchanged.push(`:(literal)${file}`);
    }
  }

  if (unchanged.length > 0) {
    await git({
      cwd: root,
      args: ["reset", "--quiet", "--pathspec-from-file=-", "--pathspec-file-nul", baseSha],
      input: unchanged.join("\0"),
    });
  }

  const changes = (
    await git({
      cwd: root,
      args: ["diff", "--cached", "--raw", "--no-abbrev", "-z", "--no-renames", baseSha],
    })
  )
    .toString()
    .split("\0");
  if (changes.length < 2) {
    throw new Error("The agent did not change any files.");
  }

  for (let i = 0; i + 1 < changes.length; i += 2) {
    const [before, after, , blob] = changes[i].slice(1).split(" ");
    const file = changes[i + 1];
    if (
      normalizeUpgradePath(file) !== file ||
      file.split("/").some((part) => /^(?:\.github|\.gitmodules)$/iu.test(part)) ||
      !["000000", "100644", "100755"].includes(before) ||
      (after !== "000000" && after !== (before === "000000" ? "100644" : before))
    ) {
      throw new Error("The candidate contains a protected path or unsupported file mode.");
    }

    if (file.includes(credential) || proxyTokenPattern.test(file)) {
      throw new Error("A candidate file path contains the agent credential or proxy token.");
    }

    if (after !== "000000") {
      const contents = await git({ cwd: root, args: ["cat-file", "blob", blob] });
      if (contents.includes(credential) || proxyTokenPattern.test(contents.toString("latin1"))) {
        throw new Error("The candidate contains the agent credential or proxy token.");
      }
    }
  }

  return git({
    cwd: root,
    args: [
      "diff",
      "--cached",
      "--binary",
      "--no-renames",
      "--no-ext-diff",
      "--no-textconv",
      baseSha,
    ],
  });
}

function parseJson({ value, description }) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`Invalid ${description} JSON.`, { cause: error });
  }
}

async function statIfExists(path) {
  try {
    return await lstat(path);
  } catch (error) {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") {
      return null;
    }

    throw error;
  }
}

async function sameFile({ base, candidate }) {
  const [baseInfo, candidateInfo] = await Promise.all([base, candidate].map(statIfExists));
  if (
    !baseInfo ||
    !candidateInfo ||
    !baseInfo.isFile() ||
    !candidateInfo.isFile() ||
    baseInfo.size !== candidateInfo.size ||
    (baseInfo.mode & 0o111) !== (candidateInfo.mode & 0o111)
  ) {
    return false;
  }

  const [baseBytes, candidateBytes] = await Promise.all([readFile(base), readFile(candidate)]);
  return baseBytes.equals(candidateBytes);
}

function readHandoff(contents) {
  const handoff = parseJson({ value: contents, description: "Next.js upgrade handoff" });
  if (handoff === null || typeof handoff !== "object") {
    throw new Error("Unsupported Next.js upgrade handoff.");
  }

  switch (handoff.status) {
    case "ready":
      if (
        semver.valid(handoff.installedVersion) === handoff.installedVersion &&
        semver.valid(handoff.targetVersion) === handoff.targetVersion &&
        semver.gt(handoff.targetVersion, handoff.installedVersion) &&
        typeof handoff.prompt === "string" &&
        handoff.prompt.trim()
      ) {
        return handoff;
      }

      break;
    case "unaffected":
    case "blocked":
    case "unknown":
      if (typeof handoff.reason === "string") {
        return handoff;
      }

      break;
    default:
      break;
  }

  throw new Error("Unsupported Next.js upgrade handoff.");
}

function validateApp({ appPath, policy }) {
  if (!policies.has(policy)) {
    throw new Error("Use the security or latest upgrade policy.");
  }

  return normalizeUpgradePath(appPath);
}

async function createScratch({ shared }) {
  const scratch = await realpath(await mkdtemp(join(tmpdir(), "next-upgrade-")));
  const privateRoot = join(scratch, "private");
  await mkdir(privateRoot, { mode: 0o700 });
  if (shared) {
    await sudo({
      args: ["chgrp", agentUser, scratch],
      description: "Sharing the scratch directory",
    });
    await chmod(scratch, 0o710);
  }

  return { scratch, privateRoot };
}

async function checkUpgradeAt({
  root,
  path,
  policy,
  cliPath,
  baseSha,
  scratch,
  privateRoot,
  stage,
}) {
  stage.name = "setup";
  const baseRoot = join(privateRoot, "base");
  await checkout({ source: root, root: baseRoot, baseSha });
  const lockfile = await statIfExists(join(baseRoot, path, "package-lock.json"));
  if (!lockfile || !lockfile.isFile()) {
    throw new Error(
      "Scheduled upgrades need a committed package-lock.json next to the app package.json on the default branch.",
    );
  }

  for (const lockfile of otherLockfiles) {
    if (await statIfExists(join(baseRoot, path, lockfile))) {
      throw new Error(
        `Scheduled upgrades need package-lock.json as the only lockfile, and the app also has ${lockfile}.`,
      );
    }
  }

  const id = candidateKey({ path, policy });
  const candidateRoot = join(scratch, id);
  const appDirectory = join(candidateRoot, path);
  await checkout({ source: root, root: candidateRoot, baseSha });
  await run({
    file: "npm",
    args: ["ci", `--git=${systemCommand("git")}`, "--ignore-scripts", "--no-audit", "--no-fund"],
    cwd: appDirectory,
    description: "Dependency install",
  });
  const installedStatus = await git({ cwd: candidateRoot, args: ["status", "--porcelain", "-z"] });

  const { stdout: versionOutput } = await run({
    file: process.execPath,
    args: [cliPath, "--version"],
    cwd: baseRoot,
    description: "Pinned Next.js CLI version lookup",
  });
  const versionMatch = versionOutput
    .toString()
    .trim()
    .match(/^Next\.js v(\S+)$/u);
  const cliVersion = versionMatch && versionMatch[1];
  if (!cliVersion || semver.valid(cliVersion) !== cliVersion) {
    throw new Error("Unsupported pinned Next.js CLI version output.");
  }

  stage.name = "check";
  const handoffPath = join(privateRoot, "handoff.json");
  const guides = join(scratch, `${id}-guides`);
  await run({
    file: process.execPath,
    args: [cliPath, "upgrade", ".", `--agent=${policy}`],
    cwd: appDirectory,
    env: {
      ...commandEnv(),
      __NEXT_UPGRADE_EXPECTED_CLI_VERSION: cliVersion,
      __NEXT_AGENT_UPGRADE_CI_HANDOFF: handoffPath,
      __NEXT_AGENT_UPGRADE_CI_GUIDES: guides,
    },
    description: "Pinned Next.js upgrade handoff",
  });
  const handoff = readHandoff(await readFile(handoffPath, "utf8"));
  if (handoff.status === "unknown") {
    throw new Error(handoff.reason);
  }

  if (handoff.status === "ready") {
    if (
      !(await git({ cwd: candidateRoot, args: ["status", "--porcelain", "-z"] })).equals(
        installedStatus,
      )
    ) {
      throw new Error("The CLI handoff changed the candidate checkout.");
    }
  }

  return { id, baseRoot, candidateRoot, appDirectory, guides, handoff };
}

function settledStatus({ handoff, path }) {
  if (handoff.status === "unaffected") {
    console.error(`${path}: No upgrade needed. ${handoff.reason}`);
    return "no_upgrade";
  }

  console.error(`${path}: Blocked by the upgrade policy. ${handoff.reason}`);
  return "blocked";
}

async function checkUpgrade({ root, appPath, policy, cliPath }) {
  const path = validateApp({ appPath, policy });
  const baseSha = (await git({ cwd: root, args: ["rev-parse", "HEAD"] })).toString().trim();
  const { scratch, privateRoot } = await createScratch({ shared: false });
  const stage = { name: "setup" };
  try {
    const { handoff } = await checkUpgradeAt({
      root,
      path,
      policy,
      cliPath,
      baseSha,
      scratch,
      privateRoot,
      stage,
    });
    if (handoff.status !== "ready") {
      return { path, baseSha, status: settledStatus({ handoff, path }), reason: handoff.reason };
    }

    console.error(
      `${path}: Ready to upgrade Next.js from ${handoff.installedVersion} to ${handoff.targetVersion}.`,
    );
    return { path, baseSha, status: "ready" };
  } catch (error) {
    console.error(`${path}: Failed during ${stage.name}.`, error);
    return { path, baseSha, status: "failed" };
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

async function runUpgrade({
  root,
  artifactDirectory,
  appPath,
  policy,
  cliPath,
  agent,
  auth,
  credential,
  model,
  effort,
}) {
  const path = validateApp({ appPath, policy });
  const baseSha = (await git({ cwd: root, args: ["rev-parse", "HEAD"] })).toString().trim();
  const index = { baseSha };
  const { scratch, privateRoot } = await createScratch({ shared: true });
  const stage = { name: "setup" };
  try {
    await mkdir(artifactDirectory, { recursive: true });
    const { id, baseRoot, candidateRoot, appDirectory, guides, handoff } = await checkUpgradeAt({
      root,
      path,
      policy,
      cliPath,
      baseSha,
      scratch,
      privateRoot,
      stage,
    });
    if (handoff.status !== "ready") {
      index.status = settledStatus({ handoff, path });
      return index;
    }

    stage.name = "agent run";
    await runAgent({
      agent,
      auth,
      credential,
      model,
      effort,
      root: candidateRoot,
      guides,
      cwd: appDirectory,
      prompt: handoff.prompt,
    });

    stage.name = "packaging";
    await chmod(scratch, 0o700);
    await sudo({
      args: [systemCommand("chmod"), "-R", "go-w", candidateRoot],
      description: "Locking the candidate checkout",
    });
    const snapshotRoot = join(privateRoot, `${id}-snapshot`);
    await checkout({ source: baseRoot, root: snapshotRoot, baseSha });
    for (const entry of await readdir(snapshotRoot)) {
      if (entry !== ".git") {
        await rm(join(snapshotRoot, entry), { recursive: true, force: true });
      }
    }

    await copyTree({ source: candidateRoot, destination: snapshotRoot });
    const patch = await candidatePatch({ root: snapshotRoot, baseRoot, baseSha, credential });
    const lockfile = parseJson({
      value: (
        await git({
          cwd: snapshotRoot,
          args: ["cat-file", "blob", `:${posix.join(path, "package-lock.json")}`],
        })
      ).toString("utf8"),
      description: "candidate package-lock.json",
    });
    const packages = lockfile !== null && typeof lockfile === "object" ? lockfile.packages : null;
    const lockedNext =
      packages !== null && typeof packages === "object" ? packages["node_modules/next"] : null;
    const lockedVersion =
      lockedNext !== null && typeof lockedNext === "object" ? lockedNext.version : undefined;
    if (lockedVersion !== handoff.targetVersion) {
      throw new Error(
        `The candidate locks next to ${lockedVersion} instead of ${handoff.targetVersion}.`,
      );
    }

    await writeFile(join(artifactDirectory, `${id}.patch`), patch);
    index.status = "prepared";
    index.candidate = {
      id,
      fromVersion: handoff.installedVersion,
      targetVersion: handoff.targetVersion,
    };
    return index;
  } catch (error) {
    console.error(`${path}: Failed during ${stage.name}.`, error);
    index.status = "failed";
    return index;
  } finally {
    await writeFile(join(artifactDirectory, "index.json"), `${JSON.stringify(index, null, 2)}\n`);
    await chmod(scratch, 0o700);
    await rm(scratch, { recursive: true, force: true });
  }
}

async function main(env) {
  if (env.NEXT_UPGRADE_STAGE === "check-upgrade") {
    const { path, baseSha, status, reason } = await checkUpgrade({
      root: await realpath(env.NEXT_UPGRADE_ROOT),
      appPath: env.NEXT_UPGRADE_APP_PATH,
      policy: env.NEXT_UPGRADE_POLICY,
      cliPath: await realpath(env.NEXT_UPGRADE_CLI_PATH),
    });
    await appendFile(
      env.GITHUB_OUTPUT,
      `status=${status}\nbase-sha=${baseSha}\ncandidate-id=${candidateKey({ path, policy: env.NEXT_UPGRADE_POLICY })}\n`,
    );
    if (status === "blocked" || status === "no_upgrade") {
      const label = status === "blocked" ? "Blocked" : "Already up to date";
      await appendFile(
        env.GITHUB_STEP_SUMMARY,
        `## Next.js upgrade\n\n- ${label} for \`${path}\`: ${reason}\n`,
      );
    }

    if (status === "blocked") {
      const message = `${path}: ${reason}`
        .replaceAll("%", "%25")
        .replaceAll("\r", "%0D")
        .replaceAll("\n", "%0A");
      console.log(`::warning title=Next.js upgrade blocked::${message}`);
    }

    return status !== "failed";
  }

  if (env.NEXT_UPGRADE_STAGE !== "run-upgrade") {
    throw new Error("Set NEXT_UPGRADE_STAGE to check-upgrade or run-upgrade.");
  }

  const credential = env.NEXT_UPGRADE_AGENT_CREDENTIAL ?? "";
  delete env.NEXT_UPGRADE_AGENT_CREDENTIAL;
  if (!credential) {
    throw new Error("Set the agent credential secret.");
  }

  const { status } = await runUpgrade({
    root: await realpath(env.NEXT_UPGRADE_ROOT),
    artifactDirectory: env.NEXT_UPGRADE_ARTIFACT_DIR,
    appPath: env.NEXT_UPGRADE_APP_PATH,
    policy: env.NEXT_UPGRADE_POLICY,
    cliPath: await realpath(env.NEXT_UPGRADE_CLI_PATH),
    agent: env.NEXT_UPGRADE_AGENT,
    auth: env.NEXT_UPGRADE_AUTH,
    credential,
    model: env.NEXT_UPGRADE_MODEL || undefined,
    effort: env.NEXT_UPGRADE_EFFORT || undefined,
  });
  return status !== "failed";
}

if (process.argv[1] && (await realpath(process.argv[1])) === fileURLToPath(import.meta.url)) {
  try {
    if (!(await main(process.env))) {
      process.exitCode = 1;
    }
  } catch (error) {
    console.error("The Next.js upgrade failed.", error);
    process.exitCode = 1;
  }
}
