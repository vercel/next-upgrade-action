import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { test } from "node:test";
import { promisify } from "node:util";

import { candidateKey } from "../scripts/upgrade.mjs";
import { createRepository, git, scriptsDirectory, tempDirectory } from "./helpers.mjs";

const exec = promisify(execFile);
const repository = "acme/app";
const appPath = ".";
const policy = "latest";
const id = candidateKey({ path: appPath, policy });
const branchPrefix = `next-upgrade/${id}-`;
const failurePrefix = "::error::Could not open the Next.js upgrade pull request";
const baseLock = `${JSON.stringify({ packages: { "node_modules/next": { version: "15.0.0" } } }, null, 2)}\n`;
const upgradedLock = `${JSON.stringify({ packages: { "node_modules/next": { version: "15.0.1" } } }, null, 2)}\n`;

function json({ status, body }) {
  return { status, body };
}

async function fakeGitHub({ t, routes }) {
  const log = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) {
      chunks.push(chunk);
    }

    const text = Buffer.concat(chunks).toString("utf8");
    const url = new URL(request.url, "http://127.0.0.1");
    const entry = {
      method: request.method,
      path: url.pathname,
      query: Object.fromEntries(url.searchParams),
      body: text ? JSON.parse(text) : null,
    };
    log.push(entry);
    const handler = routes[`${request.method} ${url.pathname}`];
    const result = handler ? handler(entry) : json({ status: 404, body: { message: "Not Found" } });
    response.writeHead(result.status, { "content-type": "application/json" });
    response.end(JSON.stringify(result.body));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((resolve) => server.close(resolve)));
  return { url: `http://127.0.0.1:${server.address().port}`, log };
}

async function runStage({ t, apiUrl, env }) {
  const directory = await tempDirectory({ t, prefix: "next-upgrade-pr-env-" });
  const outputFile = join(directory, "output");
  const summaryFile = join(directory, "summary");
  await writeFile(outputFile, "");
  await writeFile(summaryFile, "");
  const result = await exec(process.execPath, [join(scriptsDirectory, "pull-request.mjs")], {
    env: {
      PATH: process.env.PATH,
      HOME: directory,
      TMPDIR: directory,
      GITHUB_API_URL: apiUrl,
      GITHUB_REPOSITORY: repository,
      GH_TOKEN: "test-token",
      GITHUB_SERVER_URL: "https://github.com",
      GITHUB_RUN_ID: "42",
      GITHUB_OUTPUT: outputFile,
      GITHUB_STEP_SUMMARY: summaryFile,
      NEXT_UPGRADE_APP_PATH: appPath,
      NEXT_UPGRADE_POLICY: policy,
      ...env,
    },
  }).then(
    ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
    (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
  );

  return {
    ...result,
    outputs: parseOutputs({ text: await readFile(outputFile, "utf8") }),
    summary: await readFile(summaryFile, "utf8"),
  };
}

function parseOutputs({ text }) {
  const outputs = {};
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^([^<]+)<<(.+)$/u.exec(lines[index]);
    if (!match) {
      continue;
    }

    const end = lines.indexOf(match[2], index + 1);
    outputs[match[1]] = lines.slice(index + 1, end).join("\n");
    index = end;
  }

  return outputs;
}

function writes({ log }) {
  return log.filter((entry) => entry.method !== "GET");
}

function assertFailure({ result, message }) {
  assert.equal(result.code, 1);
  const output = `${result.stdout}${result.stderr}`;
  assert.ok(output.includes(failurePrefix), output);
  assert.ok(output.includes(message), output);
}

function pull({ ref, fullName, url }) {
  return {
    html_url: url,
    head: { ref, repo: fullName === null ? null : { full_name: fullName } },
  };
}

// check-open-pull-request

function checkRoutes({ pulls, refs }) {
  return {
    "GET /repos/acme/app": () => json({ status: 200, body: { default_branch: "main" } }),
    "GET /repos/acme/app/pulls": () => json({ status: 200, body: pulls }),
    "GET /repos/acme/app/git/matching-refs/heads/next-upgrade": () =>
      json({ status: 200, body: refs }),
  };
}

async function checkStage({ t, routes }) {
  const github = await fakeGitHub({ t, routes });
  const result = await runStage({
    t,
    apiUrl: github.url,
    env: { NEXT_UPGRADE_STAGE: "check-open-pull-request" },
  });
  return { result, log: github.log };
}

test("check-open-pull-request: no open pull request", async (t) => {
  const { result, log } = await checkStage({
    t,
    routes: checkRoutes({
      pulls: [],
      refs: [{ ref: "refs/heads/next-upgrade/other-branch", object: { sha: "a".repeat(40) } }],
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.outputs, { "default-branch": "main", "pull-request": "" });
  assert.equal(result.summary, "");
  const pullsRequest = log.find((entry) => entry.path === "/repos/acme/app/pulls");
  assert.equal(pullsRequest.query.state, "open");
  assert.equal(pullsRequest.query.base, "main");
  assert.deepEqual(writes({ log }), []);
});

test("check-open-pull-request: matching open pull request", async (t) => {
  const url = "https://github.com/acme/app/pull/7";
  const { result, log } = await checkStage({
    t,
    routes: checkRoutes({
      pulls: [
        pull({ ref: "next-upgrade/unrelated-abc", fullName: repository, url: "nope" }),
        pull({ ref: `${branchPrefix}0123456789ab`, fullName: "ACME/App", url }),
      ],
      refs: [],
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.outputs, { "default-branch": "main", "pull-request": url });
  assert.ok(result.summary.includes("Existing pull request"), result.summary);
  assert.ok(result.summary.includes(url), result.summary);
  assert.ok(!log.some((entry) => entry.path.includes("matching-refs")));
  assert.deepEqual(writes({ log }), []);
});

test("check-open-pull-request: ignores pull requests from forks", async (t) => {
  const { result } = await checkStage({
    t,
    routes: checkRoutes({
      pulls: [
        pull({ ref: `${branchPrefix}0123456789ab`, fullName: "fork/app", url: "fork" }),
        pull({ ref: `${branchPrefix}0123456789ab`, fullName: null, url: "deleted" }),
      ],
      refs: [],
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(result.outputs, { "default-branch": "main", "pull-request": "" });
  assert.equal(result.summary, "");
});

test("check-open-pull-request: a next-upgrade branch blocks candidates", async (t) => {
  const { result, log } = await checkStage({
    t,
    routes: checkRoutes({
      pulls: [],
      refs: [{ ref: "refs/heads/next-upgrade", object: { sha: "a".repeat(40) } }],
    }),
  });
  assertFailure({
    result,
    message: "The branch `next-upgrade` blocks the `next-upgrade/` candidate branches",
  });
  assert.deepEqual(result.outputs, {});
  assert.deepEqual(writes({ log }), []);
});

test("check-open-pull-request: reports the HTTP status of API failures", async (t) => {
  const { result, log } = await checkStage({
    t,
    routes: {
      "GET /repos/acme/app": () => json({ status: 500, body: { message: "Server Error" } }),
    },
  });
  assertFailure({ result, message: "(HTTP 500)" });
  assert.deepEqual(result.outputs, {});
  assert.deepEqual(writes({ log }), []);
});

// open-pull-request

function gitWithIndex({ cwd, indexFile, args, input }) {
  return execFileSync("git", args, {
    cwd,
    input,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_INDEX_FILE: indexFile,
    },
  });
}

async function prepareCandidate({ t, index, patchFiles }) {
  const root = await tempDirectory({ t, prefix: "next-upgrade-pr-root-" });
  const artifacts = await tempDirectory({ t, prefix: "next-upgrade-pr-artifacts-" });
  const baseSha = await createRepository({
    directory: root,
    files: { "package.json": '{"name":"app"}\n', "package-lock.json": baseLock },
  });
  const changes = patchFiles ?? { "package-lock.json": upgradedLock };
  for (const [file, contents] of Object.entries(changes)) {
    await mkdir(join(root, file, ".."), { recursive: true });
    await writeFile(join(root, file), contents);
  }

  git({ cwd: root, args: ["add", "--all", "--intent-to-add"] });
  const patch = git({ cwd: root, args: ["diff", "--binary"] });
  git({ cwd: root, args: ["reset", "--quiet", "--hard"] });
  git({ cwd: root, args: ["clean", "--quiet", "-fd"] });

  const indexFile = join(artifacts, "scratch-index");
  gitWithIndex({ cwd: root, indexFile, args: ["read-tree", baseSha] });
  gitWithIndex({
    cwd: root,
    indexFile,
    args: ["apply", "--cached", "--binary", "-"],
    input: patch,
  });
  const tree = gitWithIndex({ cwd: root, indexFile, args: ["write-tree"] })
    .toString()
    .trim();

  await writeFile(join(artifacts, `${id}.patch`), patch);
  const contents =
    index === undefined
      ? {
          status: "prepared",
          baseSha,
          candidate: { id, fromVersion: "15.0.0", targetVersion: "15.0.1" },
        }
      : index({ baseSha });
  await writeFile(join(artifacts, "index.json"), JSON.stringify(contents));
  const branchName = `${branchPrefix}${tree.slice(0, 12)}`;
  return { root, artifacts, baseSha, tree, branchName };
}

function openRoutes({ candidate, pulls, refs, graphqlCommit, branchCommit }) {
  const pullUrl = "https://github.com/acme/app/pull/8";
  return {
    "GET /repos/acme/app/pulls": () => json({ status: 200, body: pulls ?? [] }),
    [`GET /repos/acme/app/git/matching-refs/heads/${candidate.branchName}`]: () =>
      json({ status: 200, body: refs ?? [] }),
    "POST /repos/acme/app/git/refs": ({ body }) =>
      json({ status: 201, body: { ref: body.ref, object: { sha: body.sha } } }),
    "POST /graphql": () =>
      json({
        status: 200,
        body: {
          data: {
            createCommitOnBranch: {
              commit:
                graphqlCommit === undefined
                  ? {
                      oid: "c".repeat(40),
                      tree: { oid: candidate.tree },
                      signature: { isValid: true, state: "VALID" },
                    }
                  : graphqlCommit,
            },
          },
        },
      }),
    [`GET /repos/acme/app/git/commits/${"d".repeat(40)}`]: () =>
      json({ status: 200, body: branchCommit }),
    "POST /repos/acme/app/pulls": () => json({ status: 201, body: { html_url: pullUrl } }),
  };
}

async function openStage({ t, candidate, routes, env }) {
  const github = await fakeGitHub({ t, routes: routes ?? openRoutes({ candidate }) });
  const result = await runStage({
    t,
    apiUrl: github.url,
    env: {
      NEXT_UPGRADE_STAGE: "open-pull-request",
      NEXT_UPGRADE_ROOT: candidate.root,
      NEXT_UPGRADE_ARTIFACT_DIR: candidate.artifacts,
      NEXT_UPGRADE_BASE_BRANCH: "main",
      ...env,
    },
  });
  return { result, log: github.log };
}

function validBranchCommit({ candidate }) {
  return {
    sha: "d".repeat(40),
    tree: { sha: candidate.tree },
    parents: [{ sha: candidate.baseSha }],
    message: "Upgrade Next.js to 15.0.1\n",
    verification: { verified: true, reason: "valid" },
  };
}

test("open-pull-request: creates a signed commit and opens the pull request", async (t) => {
  const candidate = await prepareCandidate({ t });
  const { result, log } = await openStage({ t, candidate });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    log.map((entry) => `${entry.method} ${entry.path}`),
    [
      "GET /repos/acme/app/pulls",
      `GET /repos/acme/app/git/matching-refs/heads/${candidate.branchName}`,
      "POST /repos/acme/app/git/refs",
      "POST /graphql",
      "POST /repos/acme/app/pulls",
    ],
  );
  const [, , createRef, graphql, createPull] = log;
  assert.deepEqual(createRef.body, {
    ref: `refs/heads/${candidate.branchName}`,
    sha: candidate.baseSha,
  });
  assert.ok(graphql.body.query.includes("createCommitOnBranch"));
  assert.deepEqual(graphql.body.variables.input, {
    branch: { repositoryNameWithOwner: repository, branchName: candidate.branchName },
    expectedHeadOid: candidate.baseSha,
    message: { headline: "Upgrade Next.js to 15.0.1" },
    fileChanges: {
      additions: [
        { path: "package-lock.json", contents: Buffer.from(upgradedLock).toString("base64") },
      ],
      deletions: [],
    },
  });
  assert.equal(createPull.body.title, "Upgrade Next.js to 15.0.1");
  assert.equal(createPull.body.base, "main");
  assert.equal(createPull.body.head, candidate.branchName);
  assert.ok(createPull.body.body.includes("### Next.js 15.0.0 → 15.0.1"));
  assert.ok(createPull.body.body.includes("https://github.com/acme/app/actions/runs/42"));
  assert.ok(result.summary.includes("New pull request"), result.summary);
  assert.ok(result.summary.includes("https://github.com/acme/app/pull/8"), result.summary);
});

test("open-pull-request: rejects an unsigned commit", async (t) => {
  const candidate = await prepareCandidate({ t });
  const { result, log } = await openStage({
    t,
    candidate,
    routes: openRoutes({
      candidate,
      graphqlCommit: {
        oid: "c".repeat(40),
        tree: { oid: candidate.tree },
        signature: { isValid: false, state: "UNSIGNED" },
      },
    }),
  });
  assertFailure({ result, message: "did not confirm the expected signed commit" });
  assert.ok(!log.some((entry) => entry.method === "POST" && entry.path.endsWith("/pulls")));
  assert.equal(result.summary, "");
});

test("open-pull-request: rejects a commit with an unexpected tree", async (t) => {
  const candidate = await prepareCandidate({ t });
  const { result, log } = await openStage({
    t,
    candidate,
    routes: openRoutes({
      candidate,
      graphqlCommit: {
        oid: "c".repeat(40),
        tree: { oid: "e".repeat(40) },
        signature: { isValid: true, state: "VALID" },
      },
    }),
  });
  assertFailure({ result, message: "did not confirm the expected signed commit" });
  assert.ok(!log.some((entry) => entry.method === "POST" && entry.path.endsWith("/pulls")));
});

test("open-pull-request: reuses a branch that already has the candidate commit", async (t) => {
  const candidate = await prepareCandidate({ t });
  const branch = `refs/heads/${candidate.branchName}`;
  const { result, log } = await openStage({
    t,
    candidate,
    routes: openRoutes({
      candidate,
      refs: [
        { ref: `${branch}-longer`, object: { sha: "f".repeat(40) } },
        { ref: branch, object: { sha: "d".repeat(40) } },
      ],
      branchCommit: validBranchCommit({ candidate }),
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    writes({ log }).map((entry) => `${entry.method} ${entry.path}`),
    ["POST /repos/acme/app/pulls"],
  );
  assert.ok(log.some((entry) => entry.path === `/repos/acme/app/git/commits/${"d".repeat(40)}`));
  assert.ok(result.summary.includes("New pull request"), result.summary);
});

test("open-pull-request: commits onto an existing branch still at the base", async (t) => {
  const candidate = await prepareCandidate({ t });
  const { result, log } = await openStage({
    t,
    candidate,
    routes: openRoutes({
      candidate,
      refs: [{ ref: `refs/heads/${candidate.branchName}`, object: { sha: candidate.baseSha } }],
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    writes({ log }).map((entry) => `${entry.method} ${entry.path}`),
    ["POST /graphql", "POST /repos/acme/app/pulls"],
  );
});

for (const [name, change] of [
  ["tree", { tree: { sha: "e".repeat(40) } }],
  ["parents", { parents: [{ sha: "e".repeat(40) }, { sha: "f".repeat(40) }] }],
  ["message", { message: "Something else" }],
  ["verification", { verification: { verified: false, reason: "unsigned" } }],
]) {
  test(`open-pull-request: rejects a branch commit with an unexpected ${name}`, async (t) => {
    const candidate = await prepareCandidate({ t });
    const { result, log } = await openStage({
      t,
      candidate,
      routes: openRoutes({
        candidate,
        refs: [{ ref: `refs/heads/${candidate.branchName}`, object: { sha: "d".repeat(40) } }],
        branchCommit: { ...validBranchCommit({ candidate }), ...change },
      }),
    });
    assertFailure({ result, message: "Unexpected GitHub candidate branch commit" });
    assert.deepEqual(writes({ log }), []);
  });
}

test("open-pull-request: returns an already open pull request", async (t) => {
  const candidate = await prepareCandidate({ t });
  const url = "https://github.com/acme/app/pull/3";
  const { result, log } = await openStage({
    t,
    candidate,
    routes: openRoutes({
      candidate,
      pulls: [pull({ ref: `${branchPrefix}0123456789ab`, fullName: repository, url })],
    }),
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(
    log.map((entry) => `${entry.method} ${entry.path}`),
    ["GET /repos/acme/app/pulls"],
  );
  assert.ok(result.summary.includes("Existing pull request"), result.summary);
  assert.ok(result.summary.includes(url), result.summary);
});

for (const [status, label] of [
  ["no_upgrade", "Already up to date"],
  ["blocked", "Blocked"],
]) {
  test(`open-pull-request: ${status} index makes no API calls`, async (t) => {
    const candidate = await prepareCandidate({ t, index: () => ({ status }) });
    const { result, log } = await openStage({ t, candidate });
    assert.equal(result.code, 0, result.stderr);
    assert.deepEqual(log, []);
    assert.ok(result.summary.includes(`${label} for <code>.</code>`), result.summary);
  });
}

const rejections = [
  {
    name: "a null index",
    index: () => null,
    message: "Invalid publication index",
  },
  {
    name: "an unknown index status",
    index: () => ({ status: "done" }),
    message: "Invalid publication index",
  },
  {
    name: "a different base checkout",
    index: () => ({
      status: "prepared",
      baseSha: "a".repeat(40),
      candidate: { id, fromVersion: "15.0.0", targetVersion: "15.0.1" },
    }),
    message: "Unexpected base checkout",
  },
  {
    name: "a different candidate id",
    index: ({ baseSha }) => ({
      status: "prepared",
      baseSha,
      candidate: { id: "0".repeat(24), fromVersion: "15.0.0", targetVersion: "15.0.1" },
    }),
    message: "Unexpected candidate",
  },
  {
    name: "a target version that is not newer",
    index: ({ baseSha }) => ({
      status: "prepared",
      baseSha,
      candidate: { id, fromVersion: "15.0.1", targetVersion: "15.0.1" },
    }),
    message: "Unexpected candidate",
  },
  {
    name: "a missing candidate",
    index: ({ baseSha }) => ({ status: "prepared", baseSha }),
    message: "Unexpected candidate",
  },
  {
    name: "a next-upgrade base branch",
    env: { NEXT_UPGRADE_BASE_BRANCH: "next-upgrade/main" },
    message: "Invalid base branch",
  },
  {
    name: "a patch touching .github",
    patchFiles: {
      "package-lock.json": upgradedLock,
      ".github/workflows/evil.yml": "on: push\n",
    },
    message: "protected path",
  },
];

for (const rejection of rejections) {
  test(`open-pull-request: rejects ${rejection.name}`, async (t) => {
    const candidate = await prepareCandidate({
      t,
      index: rejection.index,
      patchFiles: rejection.patchFiles,
    });
    const { result, log } = await openStage({ t, candidate, env: rejection.env });
    assertFailure({ result, message: rejection.message });
    assert.deepEqual(log, []);
    assert.equal(result.summary, "");
  });
}
