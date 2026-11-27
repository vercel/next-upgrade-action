import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { once } from "node:events";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import { describe, test } from "node:test";
import { promisify } from "node:util";

import { codeSpan, html, pullRequestBody } from "../../scripts/pull-request.mjs";
import { candidateKey } from "../../scripts/upgrade.mjs";
import {
  checkout,
  consume,
  consumerMode,
  consumerProtectedPath,
  corpus,
  createBase,
  createRepository,
  git,
  scriptsDirectory,
  tempDirectory,
  unguarded,
  write,
} from "./utils.mjs";

describe("codeSpan", () => {
  test("uses a fence longer than the longest backtick run", () => {
    assert.equal(codeSpan("apps/web"), "`apps/web`");
    assert.equal(codeSpan("a`b"), "``a`b``");
    assert.equal(codeSpan("a```b`c"), "````a```b`c````");
  });

  test("pads text that starts or ends with a space or backtick", () => {
    assert.equal(codeSpan("`a"), "`` `a ``");
    assert.equal(codeSpan("a`"), "`` a` ``");
    assert.equal(codeSpan(" a"), "`  a `");
    assert.equal(codeSpan("a "), "` a  `");
    assert.equal(codeSpan("a b"), "`a b`");
  });

  test("replaces control, format, and line separator characters", () => {
    assert.equal(codeSpan("a\nb"), "`a\uFFFDb`");
    assert.equal(codeSpan("a\r\nb"), "`a\uFFFD\uFFFDb`");
    assert.equal(codeSpan("a\u0000b"), "`a\uFFFDb`");
    assert.equal(codeSpan("a\u202Eb"), "`a\uFFFDb`");
    assert.equal(codeSpan("a\u200Bb"), "`a\uFFFDb`");
    assert.equal(codeSpan("a\u2028b\u2029c"), "`a\uFFFDb\uFFFDc`");
  });
});

describe("html", () => {
  test("escapes markup characters", () => {
    assert.equal(html('a & <b c="d">'), "a &amp; &lt;b c=&quot;d&quot;&gt;");
    assert.equal(html("&lt;"), "&amp;lt;");
    assert.equal(html("plain 'text'"), "plain 'text'");
  });
});

describe("pullRequestBody", () => {
  const runUrl = "https://github.com/owner/repo/actions/runs/1";

  test("describes a root app minor upgrade", () => {
    const body = pullRequestBody({
      target: { path: ".", policy: "security", fromVersion: "15.1.0", targetVersion: "15.1.9" },
      runUrl,
    });
    const lines = body.split("\n");
    assert.equal(lines[0], "### Next.js 15.1.0 → 15.1.9");
    assert.ok(lines.includes("A scheduled upgrade with the `security` policy."));
    assert.doesNotMatch(body, / of /u);
    assert.ok(
      lines.includes("- Release notes: https://github.com/vercel/next.js/releases/tag/v15.1.9"),
    );
    assert.doesNotMatch(body, /Upgrade guide/u);
    assert.match(body, /package\.json requires next 15\.1\.9 and the lockfile locks it/u);
    assert.equal(lines.at(-1), `Prepared by [this workflow run](${runUrl}).`);
  });

  test("shows a nested path and the upgrade guide for a major upgrade", () => {
    const body = pullRequestBody({
      target: {
        path: "apps/web",
        policy: "latest",
        fromVersion: "15.5.0",
        targetVersion: "16.0.1",
      },
      runUrl,
    });
    const lines = body.split("\n");
    assert.equal(lines[0], "### Next.js 15.5.0 → 16.0.1");
    assert.ok(lines.includes("A scheduled upgrade of `apps/web` with the `latest` policy."));
    assert.ok(
      lines.includes("- Release notes: https://github.com/vercel/next.js/releases/tag/v16.0.1"),
    );
    assert.ok(
      lines.includes("- Upgrade guide: https://nextjs.org/docs/app/guides/upgrading/version-16"),
    );
    assert.ok(body.includes(`[this workflow run](${runUrl})`));
  });

  test("fences a path containing backticks", () => {
    const body = pullRequestBody({
      target: { path: "a`b", policy: "latest", fromVersion: "15.0.0", targetVersion: "15.0.1" },
      runUrl,
    });
    assert.ok(body.includes("A scheduled upgrade of ``a`b`` with the `latest` policy."));
  });
});

describe("applyPatch", () => {
  for (const testCase of corpus) {
    const accepted = testCase.paths !== undefined;

    test(`${accepted ? "accepts" : "rejects"} a patch that ${testCase.name}`, async (t) => {
      const { base, baseSha } = await createBase(t);
      const { patch, tree } = await unguarded({ t, base, baseSha, mutate: testCase.mutate });
      const consuming = consume({ t, base, baseSha, patch });
      if (!accepted) {
        await assert.rejects(consuming, testCase.consumer);
        return;
      }

      const result = await consuming;
      assert.equal(result.tree, tree);
      assert.deepEqual(result.changes.map((change) => change.path).sort(), testCase.paths);
    });
  }

  test("accepts a deletion with no resulting entry", async (t) => {
    const { base, baseSha } = await createBase(t);
    const { patch } = await unguarded({
      t,
      base,
      baseSha,
      mutate: ({ directory }) => rm(join(directory, "README.md")),
    });
    const result = await consume({ t, base, baseSha, patch });
    assert.deepEqual(result.changes, [{ path: "README.md", entry: undefined }]);
  });

  test("rejects a gitlink staged directly in the index", async (t) => {
    const { base, baseSha } = await createBase(t);
    const { patch } = await unguarded({
      t,
      base,
      baseSha,
      mutate: () => Promise.resolve(),
      stage: ({ directory, baseSha: sha }) =>
        git({
          cwd: directory,
          args: ["update-index", "--add", "--cacheinfo", `160000,${sha},sub`],
        }),
    });
    await assert.rejects(consume({ t, base, baseSha, patch }), consumerMode);
  });

  test("rejects a top-level .GitHub path staged directly in the index", async (t) => {
    const { base, baseSha } = await createBase(t);
    const { patch } = await unguarded({
      t,
      base,
      baseSha,
      mutate: () => Promise.resolve(),
      stage: ({ directory }) => {
        const blob = git({
          cwd: directory,
          args: ["hash-object", "-w", "--stdin"],
          input: "x\n",
        })
          .toString()
          .trim();
        git({
          cwd: directory,
          args: ["update-index", "--add", "--cacheinfo", `100644,${blob},.GitHub/x`],
        });
      },
    });
    await assert.rejects(consume({ t, base, baseSha, patch }), consumerProtectedPath);
  });

  test("rejects a patch whose net effect is empty", async (t) => {
    const { base, baseSha } = await createBase(t);
    const directory = await checkout({ t, base });
    await write({ directory, file: "README.md", contents: "# Changed\n" });
    git({ cwd: directory, args: ["add", "--all"] });
    // git apply rejects an empty patch, so a change and its reverse reach "Empty candidate".
    const patch = Buffer.concat([
      git({ cwd: directory, args: ["diff", "--cached", "--binary", baseSha] }),
      git({ cwd: directory, args: ["diff", "--cached", "--binary", "-R", baseSha] }),
    ]);
    await assert.rejects(consume({ t, base, baseSha, patch }), /Empty candidate$/u);
  });
});

describe("pull request stages", () => {
  const repository = "acme/app";
  const appPath = ".";
  const policy = "latest";
  const id = candidateKey({ path: appPath, policy });
  const branchPrefix = `next-upgrade/${id}-`;
  const failurePrefix = "::error::Could not open the Next.js upgrade pull request";

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
      const result = handler ? handler(entry) : { status: 404, body: { message: "Not Found" } };
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
    const result = await promisify(execFile)(
      process.execPath,
      [join(scriptsDirectory, "pull-request.mjs")],
      {
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
      },
    ).then(
      ({ stdout, stderr }) => ({ code: 0, stdout, stderr }),
      (error) => ({ code: error.code, stdout: error.stdout, stderr: error.stderr }),
    );

    const outputs = {};
    const lines = (await readFile(outputFile, "utf8")).split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const match = /^([^<]+)<<(.+)$/u.exec(lines[index]);
      if (!match) {
        continue;
      }

      const end = lines.indexOf(match[2], index + 1);
      outputs[match[1]] = lines.slice(index + 1, end).join("\n");
      index = end;
    }

    return { ...result, outputs, summary: await readFile(summaryFile, "utf8") };
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

  describe("check-open-pull-request stage", () => {
    function checkRoutes({ pulls, refs }) {
      return {
        "GET /repos/acme/app": () => ({ status: 200, body: { default_branch: "main" } }),
        "GET /repos/acme/app/pulls": () => ({ status: 200, body: pulls }),
        "GET /repos/acme/app/git/matching-refs/heads/next-upgrade": () => ({
          status: 200,
          body: refs,
        }),
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

    test("no open pull request", async (t) => {
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
      assert.deepEqual(
        log.filter((entry) => entry.method !== "GET"),
        [],
      );
    });

    test("matching open pull request", async (t) => {
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
      assert.deepEqual(
        log.filter((entry) => entry.method !== "GET"),
        [],
      );
    });

    test("ignores pull requests from forks", async (t) => {
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

    test("a next-upgrade branch blocks candidates", async (t) => {
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
      assert.deepEqual(
        log.filter((entry) => entry.method !== "GET"),
        [],
      );
    });

    test("reports the HTTP status of API failures", async (t) => {
      const { result, log } = await checkStage({
        t,
        routes: {
          "GET /repos/acme/app": () => ({ status: 500, body: { message: "Server Error" } }),
        },
      });
      assertFailure({ result, message: "(HTTP 500)" });
      assert.deepEqual(result.outputs, {});
      assert.deepEqual(
        log.filter((entry) => entry.method !== "GET"),
        [],
      );
    });
  });

  describe("open-pull-request stage", () => {
    const baseLock = `${JSON.stringify({ packages: { "node_modules/next": { version: "15.0.0" } } }, null, 2)}\n`;
    const upgradedLock = `${JSON.stringify({ packages: { "node_modules/next": { version: "15.0.1" } } }, null, 2)}\n`;

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

      const scratchIndex = {
        cwd: root,
        env: {
          PATH: process.env.PATH,
          HOME: root,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_CONFIG_GLOBAL: "/dev/null",
          GIT_INDEX_FILE: join(artifacts, "scratch-index"),
        },
      };
      execFileSync("git", ["read-tree", baseSha], scratchIndex);
      execFileSync("git", ["apply", "--cached", "--binary", "-"], {
        ...scratchIndex,
        input: patch,
      });
      const tree = execFileSync("git", ["write-tree"], scratchIndex).toString().trim();

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
      return {
        "GET /repos/acme/app/pulls": () => ({ status: 200, body: pulls ?? [] }),
        [`GET /repos/acme/app/git/matching-refs/heads/${candidate.branchName}`]: () => ({
          status: 200,
          body: refs ?? [],
        }),
        "POST /repos/acme/app/git/refs": ({ body }) => ({
          status: 201,
          body: { ref: body.ref, object: { sha: body.sha } },
        }),
        "POST /graphql": () => ({
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
        [`GET /repos/acme/app/git/commits/${"d".repeat(40)}`]: () => ({
          status: 200,
          body: branchCommit,
        }),
        "POST /repos/acme/app/pulls": () => ({
          status: 201,
          body: { html_url: "https://github.com/acme/app/pull/8" },
        }),
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

    test("creates a signed commit and opens the pull request", async (t) => {
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

    test("rejects an unsigned commit", async (t) => {
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

    test("rejects a commit with an unexpected tree", async (t) => {
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

    test("reuses a branch that already has the candidate commit", async (t) => {
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
        log
          .filter((entry) => entry.method !== "GET")
          .map((entry) => `${entry.method} ${entry.path}`),
        ["POST /repos/acme/app/pulls"],
      );
      assert.ok(
        log.some((entry) => entry.path === `/repos/acme/app/git/commits/${"d".repeat(40)}`),
      );
      assert.ok(result.summary.includes("New pull request"), result.summary);
    });

    test("commits onto an existing branch still at the base", async (t) => {
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
        log
          .filter((entry) => entry.method !== "GET")
          .map((entry) => `${entry.method} ${entry.path}`),
        ["POST /graphql", "POST /repos/acme/app/pulls"],
      );
    });

    for (const [name, change] of [
      ["tree", () => ({ tree: { sha: "e".repeat(40) } })],
      ["parent", () => ({ parents: [{ sha: "e".repeat(40) }] })],
      [
        "second parent",
        ({ candidate }) => ({ parents: [{ sha: candidate.baseSha }, { sha: "f".repeat(40) }] }),
      ],
      ["message", () => ({ message: "Something else" })],
      ["verification", () => ({ verification: { verified: false, reason: "unsigned" } })],
    ]) {
      test(`rejects a branch commit with an unexpected ${name}`, async (t) => {
        const candidate = await prepareCandidate({ t });
        const { result, log } = await openStage({
          t,
          candidate,
          routes: openRoutes({
            candidate,
            refs: [{ ref: `refs/heads/${candidate.branchName}`, object: { sha: "d".repeat(40) } }],
            branchCommit: { ...validBranchCommit({ candidate }), ...change({ candidate }) },
          }),
        });
        assertFailure({ result, message: "Unexpected GitHub candidate branch commit" });
        assert.deepEqual(
          log.filter((entry) => entry.method !== "GET"),
          [],
        );
      });
    }

    test("returns an already open pull request", async (t) => {
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
      test(`${status} index makes no API calls`, async (t) => {
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
      test(`rejects ${rejection.name}`, async (t) => {
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
  });
});
