import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, symlink } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import {
  candidateKey,
  candidatePatch,
  copyTree,
  normalizeUpgradePath,
  readHandoff,
} from "../../scripts/upgrade.mjs";
import {
  checkout,
  consume,
  corpus,
  createBase,
  git,
  noChanges,
  tempDirectory,
  unguarded,
  write,
} from "./utils.mjs";

describe("normalizeUpgradePath", () => {
  test("accepts repository-relative paths", () => {
    const cases = [
      [".", "."],
      ["./", "."],
      ["apps/web", "apps/web"],
      ["apps/web/", "apps/web"],
      ["a//b", "a/b"],
      ["./apps/web", "apps/web"],
    ];
    for (const [input, expected] of cases) {
      assert.equal(normalizeUpgradePath(input), expected, JSON.stringify(input));
    }
  });

  test("rejects unsafe paths", () => {
    const cases = [
      undefined,
      null,
      1,
      ["apps"],
      "",
      " apps",
      "apps ",
      "\tapps",
      "/x",
      "..",
      "../x",
      "a/../b",
      "a/..",
      ".git",
      "a/.GIT/b",
      "a\\b",
      "C:apps",
      "a:b",
      "a\u0000b",
      "a\nb",
      "a\u007fb",
    ];
    for (const input of cases) {
      assert.throws(
        () => normalizeUpgradePath(input),
        { message: "Invalid repository-relative upgrade path." },
        JSON.stringify(input),
      );
    }
  });
});

describe("candidateKey", () => {
  test("is a stable 24 character hex key per normalized path and policy", () => {
    const key = candidateKey({ path: "apps/web", policy: "security" });
    assert.match(key, /^[0-9a-f]{24}$/u);
    assert.equal(candidateKey({ path: "apps/web", policy: "security" }), key);
    assert.equal(candidateKey({ path: "apps/web/", policy: "security" }), key);
    assert.equal(candidateKey({ path: "./apps//web", policy: "security" }), key);
    assert.notEqual(candidateKey({ path: "apps/web", policy: "latest" }), key);
    assert.notEqual(candidateKey({ path: "apps/docs", policy: "security" }), key);
    assert.notEqual(candidateKey({ path: ".", policy: "security" }), key);
  });

  test("rejects invalid paths", () => {
    assert.throws(() => candidateKey({ path: "../web", policy: "security" }), {
      message: "Invalid repository-relative upgrade path.",
    });
    assert.throws(() => candidateKey({ path: "", policy: "security" }));
  });
});

describe("readHandoff", () => {
  const unsupported = { message: "Unsupported Next.js upgrade handoff." };

  test("accepts a ready handoff with exact versions and a prompt", () => {
    const value = {
      status: "ready",
      installedVersion: "15.1.0",
      targetVersion: "16.0.1",
      prompt: "Upgrade.",
    };
    assert.deepEqual(readHandoff(JSON.stringify(value)), value);
    assert.deepEqual(
      readHandoff(
        JSON.stringify({ ...value, installedVersion: "16.0.0-canary.1", targetVersion: "16.0.0" }),
      ),
      { ...value, installedVersion: "16.0.0-canary.1", targetVersion: "16.0.0" },
    );
  });

  test("rejects malformed ready handoffs", () => {
    const ready = {
      status: "ready",
      installedVersion: "15.1.0",
      targetVersion: "15.2.0",
      prompt: "Upgrade.",
    };
    const cases = [
      { ...ready, installedVersion: "v15.1.0" },
      { ...ready, installedVersion: "15.1" },
      { ...ready, installedVersion: " 15.1.0" },
      { ...ready, installedVersion: 15 },
      { ...ready, targetVersion: "^15.2.0" },
      { ...ready, targetVersion: "latest" },
      { ...ready, targetVersion: undefined },
      { ...ready, targetVersion: "15.1.0" },
      { ...ready, targetVersion: "15.0.0" },
      { ...ready, prompt: "" },
      { ...ready, prompt: "  \n " },
      { ...ready, prompt: 1 },
      { ...ready, prompt: undefined },
    ];
    for (const value of cases) {
      assert.throws(() => readHandoff(JSON.stringify(value)), unsupported, JSON.stringify(value));
    }
  });

  test("accepts settled statuses with a string reason", () => {
    for (const status of ["unaffected", "blocked", "unknown"]) {
      const value = { status, reason: "Because." };
      assert.deepEqual(readHandoff(JSON.stringify(value)), value);
      assert.deepEqual(readHandoff(JSON.stringify({ status, reason: "" })), { status, reason: "" });
      assert.throws(() => readHandoff(JSON.stringify({ status })), unsupported, status);
      assert.throws(() => readHandoff(JSON.stringify({ status, reason: 1 })), unsupported, status);
      assert.throws(
        () => readHandoff(JSON.stringify({ status, reason: null })),
        unsupported,
        status,
      );
    }
  });

  test("rejects invalid JSON and unsupported shapes", () => {
    assert.throws(() => readHandoff("{"), { message: "Invalid Next.js upgrade handoff JSON." });
    assert.throws(() => readHandoff(""), { message: "Invalid Next.js upgrade handoff JSON." });
    for (const contents of [
      "null",
      "[]",
      '["ready"]',
      "1",
      '"ready"',
      "{}",
      JSON.stringify({ status: "done", reason: "x" }),
      JSON.stringify({ status: "READY", reason: "x" }),
    ]) {
      assert.throws(() => readHandoff(contents), unsupported, contents);
    }
  });
});

describe("candidatePatch", () => {
  const credential = "agent-credential-3b9f17c2";
  const proxyToken = `next-upgrade-${"0123456789abcdef".repeat(3)}`;
  const credentialContents = /The candidate contains the agent credential or proxy token\.$/u;
  const credentialPath = /A candidate file path contains the agent credential or proxy token\.$/u;

  async function produce({ t, base, baseSha, mutate }) {
    const root = await checkout({ t, base });
    await mutate({ directory: root, baseSha });
    return candidatePatch({ root, baseRoot: base, baseSha, credential });
  }

  for (const testCase of corpus) {
    const accepted = testCase.paths !== undefined;

    test(`${accepted ? "accepts" : "rejects"} a candidate that ${testCase.name}`, async (t) => {
      const { base, baseSha } = await createBase(t);
      const producing = produce({ t, base, baseSha, mutate: testCase.mutate });
      if (!accepted) {
        await assert.rejects(producing, testCase.producer);
        return;
      }

      const patch = await producing;
      assert.ok(Buffer.isBuffer(patch));
      const expected = await unguarded({ t, base, baseSha, mutate: testCase.mutate });
      const result = await consume({ t, base, baseSha, patch });
      assert.equal(result.tree, expected.tree);
      assert.deepEqual(result.changes.map((change) => change.path).sort(), testCase.paths);
    });
  }

  const rejections = [
    {
      name: "the credential in file contents",
      mutate: ({ directory }) =>
        write({ directory, file: "src/index.js", contents: `const key = "${credential}";\n` }),
      error: credentialContents,
    },
    {
      name: "the credential in a file path",
      mutate: ({ directory }) =>
        write({ directory, file: `notes-${credential}.txt`, contents: "x\n" }),
      error: credentialPath,
    },
    {
      name: "a proxy token in file contents",
      mutate: ({ directory }) =>
        write({ directory, file: "src/token.js", contents: `export default "${proxyToken}";\n` }),
      error: credentialContents,
    },
    {
      name: "a proxy token in a file path",
      mutate: ({ directory }) =>
        write({ directory, file: `logs/${proxyToken}.log`, contents: "x\n" }),
      error: credentialPath,
    },
    {
      name: "the credential inside binary contents",
      mutate: ({ directory }) =>
        write({
          directory,
          file: "assets/blob.bin",
          contents: Buffer.concat([
            Buffer.from([0, 1, 2, 0xff, 0x80]),
            Buffer.from(credential),
            Buffer.from([0, 0xfe]),
          ]),
        }),
      error: credentialContents,
    },
    {
      name: "a proxy token inside binary contents",
      mutate: ({ directory }) =>
        write({
          directory,
          file: "assets/token.bin",
          contents: Buffer.concat([
            Buffer.from([0, 0xc3, 0x28, 0xff]),
            Buffer.from(proxyToken),
            Buffer.from([0]),
          ]),
        }),
      error: credentialContents,
    },
  ];

  for (const rejection of rejections) {
    test(`rejects ${rejection.name}`, async (t) => {
      const { base, baseSha } = await createBase(t);
      await assert.rejects(
        produce({ t, base, baseSha, mutate: rejection.mutate }),
        rejection.error,
      );
    });
  }

  test("ignores changes under node_modules/ and .next/", async (t) => {
    const { base, baseSha } = await createBase(t);
    await assert.rejects(
      produce({
        t,
        base,
        baseSha,
        mutate: async ({ directory }) => {
          await write({ directory, file: "node_modules/next/index.js", contents: credential });
          await write({ directory, file: "packages/a/node_modules/x/y.js", contents: "y\n" });
          await write({ directory, file: ".next/cache/data", contents: proxyToken });
          await write({ directory, file: "apps/web/.next/server.js", contents: "s\n" });
        },
      }),
      noChanges,
    );
  });

  test("leaves node_modules/ and .next/ out of an otherwise valid patch", async (t) => {
    const { base, baseSha } = await createBase(t);
    const patch = await produce({
      t,
      base,
      baseSha,
      mutate: async ({ directory }) => {
        await write({ directory, file: "node_modules/next/index.js", contents: credential });
        await write({ directory, file: ".next/cache/data", contents: "d\n" });
        await write({ directory, file: "src/index.js", contents: "export const value = 2;\n" });
      },
    });
    const result = await consume({ t, base, baseSha, patch });
    assert.deepEqual(result.changes.map((change) => change.path).sort(), ["src/index.js"]);
  });

  // git add renormalizes line endings, so a file committed before its text attribute shows up as
  // changed even though the agent left its bytes alone.
  test("drops a file that only line-ending normalization changed", async (t) => {
    const { base } = await createBase(t);
    await write({ directory: base, file: "notes.txt", contents: "a\r\nb\r\n" });
    git({ cwd: base, args: ["add", "notes.txt"] });
    git({ cwd: base, args: ["commit", "--quiet", "--no-gpg-sign", "-m", "Notes"] });
    await write({ directory: base, file: ".gitattributes", contents: "*.txt text\n" });
    git({ cwd: base, args: ["add", ".gitattributes"] });
    git({ cwd: base, args: ["commit", "--quiet", "--no-gpg-sign", "-m", "Attributes"] });
    const baseSha = git({ cwd: base, args: ["rev-parse", "HEAD"] })
      .toString()
      .trim();
    await assert.rejects(produce({ t, base, baseSha, mutate: () => Promise.resolve() }), noChanges);

    const patch = await produce({
      t,
      base,
      baseSha,
      mutate: ({ directory }) =>
        write({ directory, file: "src/index.js", contents: "export const value = 3;\n" }),
    });
    assert.doesNotMatch(patch.toString(), /notes\.txt/u);
    const result = await consume({ t, base, baseSha, patch });
    assert.deepEqual(result.changes.map((change) => change.path).sort(), ["src/index.js"]);
  });
});

describe("copyTree", () => {
  async function source(t) {
    const directory = await tempDirectory({ t, prefix: "copy-tree-source-" });
    const destination = await tempDirectory({ t, prefix: "copy-tree-destination-" });
    return { directory, destination };
  }

  test("copies files, mode bits, and symlinks, skipping .git, node_modules, and .next", async (t) => {
    const { directory, destination } = await source(t);
    await write({ directory, file: "a.txt", contents: "a\n" });
    await write({ directory, file: "nested/deep/b.txt", contents: "b\n" });
    await write({ directory, file: "run.sh", contents: "#!/bin/sh\n" });
    await chmod(join(directory, "run.sh"), 0o755);
    await write({ directory, file: "private.txt", contents: "p\n" });
    await chmod(join(directory, "private.txt"), 0o600);
    await symlink("/etc/passwd", join(directory, "absolute-link"));
    await symlink("missing-target", join(directory, "nested/dangling-link"));
    await write({ directory, file: ".git/config", contents: "[core]\n" });
    await write({ directory, file: "nested/.git", contents: "gitdir: elsewhere\n" });
    await write({ directory, file: "node_modules/x/index.js", contents: "x\n" });
    await write({ directory, file: "apps/web/node_modules/y.js", contents: "y\n" });
    await write({ directory, file: ".next/cache", contents: "c\n" });
    await write({ directory, file: "lib/.next", contents: "file named .next\n" });

    await copyTree({ source: directory, destination });

    assert.equal(await readFile(join(destination, "a.txt"), "utf8"), "a\n");
    assert.equal(await readFile(join(destination, "nested/deep/b.txt"), "utf8"), "b\n");
    const umask = process.umask();
    assert.equal((await lstat(join(destination, "run.sh"))).mode & 0o777, 0o755 & ~umask);
    assert.equal((await lstat(join(destination, "private.txt"))).mode & 0o777, 0o600 & ~umask);

    const absolute = await lstat(join(destination, "absolute-link"));
    assert.ok(absolute.isSymbolicLink());
    assert.equal(await readlink(join(destination, "absolute-link")), "/etc/passwd");
    const dangling = await lstat(join(destination, "nested/dangling-link"));
    assert.ok(dangling.isSymbolicLink());
    assert.equal(await readlink(join(destination, "nested/dangling-link")), "missing-target");

    for (const skipped of [
      ".git",
      "nested/.git",
      "node_modules",
      "apps/web/node_modules",
      ".next",
    ]) {
      await assert.rejects(lstat(join(destination, skipped)), { code: "ENOENT" });
    }

    assert.equal(await readFile(join(destination, "lib/.next"), "utf8"), "file named .next\n");
  });

  for (const mode of [0o4755, 0o2755]) {
    test(`rejects a file with mode ${mode.toString(8)}`, async (t) => {
      const { directory, destination } = await source(t);
      await write({ directory, file: "dir/special", contents: "s\n" });
      await chmod(join(directory, "dir/special"), mode);
      assert.notEqual((await lstat(join(directory, "dir/special"))).mode & 0o6000, 0);
      await assert.rejects(
        copyTree({ source: directory, destination }),
        /The candidate contains a file with special permissions\.$/u,
      );
    });
  }

  test("rejects a FIFO", async (t) => {
    const { directory, destination } = await source(t);
    await mkdir(join(directory, "dir"));
    execFileSync("mkfifo", [join(directory, "dir/pipe")]);
    await assert.rejects(
      copyTree({ source: directory, destination }),
      /The candidate contains an unsupported file type\.$/u,
    );
  });
});
