import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { chmod, mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";

import { createRepository, scriptsDirectory, tempDirectory } from "./helpers.mjs";

const script = join(scriptsDirectory, "install-next.mjs");
const pinnedMessage = "The reusable workflow must be pinned to a full commit SHA.";
const mismatchMessage = "The action scripts do not match the pinned commit.";

// Runs install-next.mjs with a PATH holding only git and a fake npm that records
// any call, so a validation gap can never reach the real `npm ci`.
async function runInstall({ t, env }) {
  const directory = await tempDirectory({ t, prefix: "next-upgrade-install-" });
  const repository = join(directory, "repo");
  const bin = join(directory, "bin");
  const npmMarker = join(directory, "npm-called");
  await mkdir(repository);
  await mkdir(bin);
  const sha = await createRepository({ directory: repository, files: { "README.md": "test\n" } });
  const gitPath = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  await symlink(gitPath, join(bin, "git"));
  await writeFile(join(bin, "npm"), `#!/bin/sh\n/usr/bin/touch '${npmMarker}'\nexit 99\n`);
  await chmod(join(bin, "npm"), 0o755);

  const result = spawnSync(process.execPath, [script], {
    cwd: repository,
    encoding: "utf8",
    env: {
      PATH: bin,
      HOME: directory,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      ...env({ sha }),
    },
  });
  return { ...result, sha, npmCalled: existsSync(npmMarker) };
}

const otherSha = "a".repeat(40);

for (const { name, env } of [
  {
    name: "WORKFLOW_SHA is missing",
    env: () => ({ WORKFLOW_REF: `owner/repo/.github/workflows/upgrade.yml@${otherSha}` }),
  },
  {
    name: "WORKFLOW_SHA is short",
    env: () => ({
      WORKFLOW_SHA: "abc1234",
      WORKFLOW_REF: "owner/repo/.github/workflows/upgrade.yml@abc1234",
    }),
  },
  {
    name: "WORKFLOW_SHA is uppercase hex",
    env: () => ({
      WORKFLOW_SHA: "A".repeat(40),
      WORKFLOW_REF: `owner/repo/.github/workflows/upgrade.yml@${"A".repeat(40)}`,
    }),
  },
  {
    name: "WORKFLOW_SHA is 41 characters",
    env: () => ({
      WORKFLOW_SHA: `${otherSha}a`,
      WORKFLOW_REF: `owner/repo/.github/workflows/upgrade.yml@${otherSha}a`,
    }),
  },
  { name: "WORKFLOW_REF is missing", env: ({ sha }) => ({ WORKFLOW_SHA: sha }) },
  { name: "WORKFLOW_REF is empty", env: ({ sha }) => ({ WORKFLOW_SHA: sha, WORKFLOW_REF: "" }) },
  {
    name: "WORKFLOW_REF is pinned to a branch",
    env: ({ sha }) => ({
      WORKFLOW_SHA: sha,
      WORKFLOW_REF: "owner/repo/.github/workflows/upgrade.yml@refs/heads/main",
    }),
  },
  {
    name: "WORKFLOW_REF is pinned to a different sha",
    env: ({ sha }) => ({
      WORKFLOW_SHA: sha,
      WORKFLOW_REF: `owner/repo/.github/workflows/upgrade.yml@${otherSha}`,
    }),
  },
  {
    name: "WORKFLOW_REF has extra text after the sha",
    env: ({ sha }) => ({
      WORKFLOW_SHA: sha,
      WORKFLOW_REF: `owner/repo/.github/workflows/upgrade.yml@${sha}x`,
    }),
  },
  {
    name: "WORKFLOW_REF only has the sha before a later @",
    env: ({ sha }) => ({ WORKFLOW_SHA: sha, WORKFLOW_REF: `owner/repo@${sha}@main` }),
  },
]) {
  test(`fails before npm when ${name}`, async (t) => {
    const result = await runInstall({ t, env });
    assert.equal(result.status, 1, result.stderr);
    assert.match(result.stderr, new RegExp(pinnedMessage.replaceAll(".", "\\."), "u"));
    assert.equal(result.npmCalled, false);
  });
}

test("fails before npm when the checkout is not at the pinned commit", async (t) => {
  const result = await runInstall({
    t,
    env: () => ({
      WORKFLOW_SHA: otherSha,
      WORKFLOW_REF: `owner/repo/.github/workflows/upgrade.yml@${otherSha}`,
    }),
  });
  assert.equal(result.status, 1, result.stderr);
  assert.ok(result.stderr.includes(mismatchMessage), result.stderr);
  assert.ok(!result.stderr.includes(pinnedMessage), result.stderr);
  assert.equal(result.npmCalled, false);
});

test("a ref whose suffix after the last @ is the sha passes the pin check", async (t) => {
  // The checkout matches the pin, so the script goes on to npm; the fake npm stops it.
  const result = await runInstall({
    t,
    env: ({ sha }) => ({
      WORKFLOW_SHA: sha,
      WORKFLOW_REF: `owner/repo/.github/workflows/upgrade.yml@${sha}`,
    }),
  });
  assert.ok(!result.stderr.includes(pinnedMessage), result.stderr);
  assert.ok(!result.stderr.includes(mismatchMessage), result.stderr);
  assert.equal(result.npmCalled, true);
  assert.notEqual(result.status, 0);
});
