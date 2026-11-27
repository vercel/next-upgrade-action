// Both patch guards against one hostile corpus: the producer (`candidatePatch`)
// must refuse to build these patches, and the consumer (`applyPatch`) must refuse
// to publish them even when an unguarded producer built them anyway.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmod, lstat, mkdir, readFile, readlink, rm, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, test } from "node:test";

import { applyPatch, gitAt } from "../scripts/pull-request.mjs";
import { candidatePatch, copyTree } from "../scripts/upgrade.mjs";
import { createRepository, git, tempDirectory } from "./helpers.mjs";

const credential = "agent-credential-3b9f17c2";
const proxyToken = `next-upgrade-${"0123456789abcdef".repeat(3)}`;
const protectedPath = /The candidate contains a protected path or unsupported file mode\.$/u;
const noChanges = /The agent did not change any files\.$/u;
const credentialContents = /The candidate contains the agent credential or proxy token\.$/u;
const credentialPath = /A candidate file path contains the agent credential or proxy token\.$/u;
const consumerProtectedPath = /Patch changes a protected path$/u;
const consumerMode = /Patch changes a Git file mode that cannot be published$/u;

const baseFiles = {
  "package.json": '{ "name": "app", "dependencies": { "next": "15.0.0" } }\n',
  "package-lock.json": '{ "name": "app", "lockfileVersion": 3, "packages": {} }\n',
  "README.md": "# App\n",
  "src/index.js": "export const value = 1;\n",
  ".github/workflows/ci.yml": "name: ci\n",
};

async function write({ directory, file, contents }) {
  const target = join(directory, file);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents);
}

async function fixture(t) {
  const base = await tempDirectory({ t, prefix: "patch-guards-base-" });
  const baseSha = await createRepository({ directory: base, files: baseFiles });
  return { base, baseSha };
}

async function checkout({ t, base }) {
  const parent = await tempDirectory({ t, prefix: "patch-guards-candidate-" });
  const directory = join(parent, "candidate");
  git({ cwd: parent, args: ["clone", "--quiet", base, directory] });
  return directory;
}

async function produce({ t, base, baseSha, mutate }) {
  const root = await checkout({ t, base });
  await mutate({ directory: root, baseSha });
  return candidatePatch({ root, baseRoot: base, baseSha, credential });
}

// What a producer without the guards would emit for the same candidate.
async function unguarded({ t, base, baseSha, mutate, stage }) {
  const directory = await checkout({ t, base });
  await mutate({ directory, baseSha });
  git({ cwd: directory, args: ["-c", "advice.addEmbeddedRepo=false", "add", "--all"] });
  if (stage) {
    stage({ directory, baseSha });
  }

  return {
    patch: git({
      cwd: directory,
      args: ["diff", "--cached", "--binary", "--no-renames", baseSha],
    }),
    tree: git({ cwd: directory, args: ["write-tree"] })
      .toString()
      .trim(),
  };
}

async function consume({ t, base, baseSha, patch }) {
  const scratch = await tempDirectory({ t, prefix: "patch-guards-scratch-" });
  const consumerGit = gitAt({
    cwd: scratch,
    alternates: JSON.stringify(join(base, ".git", "objects")),
  });
  await consumerGit({ args: ["init", "--bare", "--template=", "--object-format=sha1"] });
  return applyPatch({ git: consumerGit, baseSha, patch });
}

function changedPaths(result) {
  return result.changes.map((change) => change.path).sort();
}

// Leaves the candidate exactly as checked out.
const unchanged = () => Promise.resolve();

const corpus = [
  {
    name: "edits package-lock.json and adds a file",
    mutate: async ({ directory }) => {
      await write({
        directory,
        file: "package-lock.json",
        contents: '{ "name": "app", "lockfileVersion": 3, "packages": { "": {} } }\n',
      });
      await write({ directory, file: "src/new.js", contents: "export const added = true;\n" });
    },
    paths: ["package-lock.json", "src/new.js"],
  },
  {
    name: "deletes a file",
    mutate: ({ directory }) => rm(join(directory, "README.md")),
    paths: ["README.md"],
  },
  {
    name: "edits a workflow under .github/workflows/",
    mutate: ({ directory }) =>
      write({ directory, file: ".github/workflows/ci.yml", contents: "name: pwned\n" }),
    producer: protectedPath,
    consumer: consumerProtectedPath,
  },
  {
    name: "adds a new workflow file",
    mutate: ({ directory }) =>
      write({ directory, file: ".github/workflows/new.yml", contents: "name: new\n" }),
    producer: protectedPath,
    consumer: consumerProtectedPath,
  },
  {
    name: "adds a case variant of .github in a subdirectory",
    mutate: ({ directory }) =>
      write({ directory, file: "docs/.GitHub/workflows/x.yml", contents: "name: x\n" }),
    producer: protectedPath,
    consumer: consumerProtectedPath,
  },
  {
    name: "adds .gitmodules",
    mutate: ({ directory }) =>
      write({
        directory,
        file: ".gitmodules",
        contents: '[submodule "x"]\n\tpath = x\n\turl = https://example.com/x\n',
      }),
    producer: protectedPath,
    consumer: consumerProtectedPath,
  },
  {
    name: "adds a case variant of .gitmodules",
    mutate: ({ directory }) => write({ directory, file: "lib/.GitModules", contents: "x\n" }),
    producer: protectedPath,
    consumer: consumerProtectedPath,
  },
  {
    name: "adds a nested .github directory",
    mutate: ({ directory }) => write({ directory, file: "a/.github/b", contents: "b\n" }),
    producer: protectedPath,
    consumer: consumerProtectedPath,
  },
  {
    name: "adds a new symlink",
    mutate: ({ directory }) => symlink("/etc/passwd", join(directory, "link")),
    producer: protectedPath,
    consumer: consumerMode,
  },
  {
    name: "turns a file into a symlink",
    mutate: async ({ directory }) => {
      await rm(join(directory, "README.md"));
      await symlink("/etc/passwd", join(directory, "README.md"));
    },
    producer: protectedPath,
    consumer: consumerMode,
  },
  {
    name: "adds an embedded repository as a gitlink",
    mutate: async ({ directory }) => {
      await mkdir(join(directory, "vendor"));
      await createRepository({ directory: join(directory, "vendor"), files: { x: "x\n" } });
    },
    producer: protectedPath,
    consumer: consumerMode,
  },
  {
    name: "marks an existing file executable",
    mutate: ({ directory }) => chmod(join(directory, "src/index.js"), 0o755),
    producer: protectedPath,
    consumer: consumerMode,
  },
  {
    name: "adds a new executable file",
    mutate: async ({ directory }) => {
      await write({ directory, file: "run.sh", contents: "#!/bin/sh\necho hi\n" });
      await chmod(join(directory, "run.sh"), 0o755);
    },
    producer: protectedPath,
    consumer: consumerMode,
  },
  {
    // An empty `git apply` input fails before the consumer can inspect the tree;
    // the "Empty candidate" path is covered separately below.
    name: "changes nothing",
    mutate: unchanged,
    producer: noChanges,
    consumer: /Git apply failed\.$/u,
  },
];

describe("hostile candidate corpus", () => {
  for (const testCase of corpus) {
    const accepted = testCase.paths !== undefined;

    test(`producer ${accepted ? "accepts" : "rejects"}: ${testCase.name}`, async (t) => {
      const { base, baseSha } = await fixture(t);
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
      assert.deepEqual(changedPaths(result), testCase.paths);
    });

    test(`consumer ${accepted ? "accepts" : "rejects"}: ${testCase.name}`, async (t) => {
      const { base, baseSha } = await fixture(t);
      const { patch, tree } = await unguarded({ t, base, baseSha, mutate: testCase.mutate });
      const consuming = consume({ t, base, baseSha, patch });
      if (!accepted) {
        await assert.rejects(consuming, testCase.consumer);
        return;
      }

      const result = await consuming;
      assert.equal(result.tree, tree);
      assert.deepEqual(changedPaths(result), testCase.paths);
    });
  }

  test("consumer accepts a deletion with no resulting entry", async (t) => {
    const { base, baseSha } = await fixture(t);
    const { patch } = await unguarded({
      t,
      base,
      baseSha,
      mutate: ({ directory }) => rm(join(directory, "README.md")),
    });
    const result = await consume({ t, base, baseSha, patch });
    assert.deepEqual(result.changes, [{ path: "README.md", entry: undefined }]);
  });

  test("consumer rejects a gitlink staged directly in the index", async (t) => {
    const { base, baseSha } = await fixture(t);
    const { patch } = await unguarded({
      t,
      base,
      baseSha,
      mutate: unchanged,
      stage: ({ directory, baseSha: sha }) =>
        git({
          cwd: directory,
          args: ["update-index", "--add", "--cacheinfo", `160000,${sha},sub`],
        }),
    });
    await assert.rejects(consume({ t, base, baseSha, patch }), consumerMode);
  });

  test("consumer rejects a top-level .GitHub path staged directly in the index", async (t) => {
    const { base, baseSha } = await fixture(t);
    const { patch } = await unguarded({
      t,
      base,
      baseSha,
      mutate: unchanged,
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

  test("consumer rejects a patch whose net effect is empty", async (t) => {
    const { base, baseSha } = await fixture(t);
    const directory = await checkout({ t, base });
    await write({ directory, file: "README.md", contents: "# Changed\n" });
    git({ cwd: directory, args: ["add", "--all"] });
    const diff = (extra) =>
      git({ cwd: directory, args: ["diff", "--cached", "--binary", ...extra, baseSha] });
    // Apply the change, then its exact reverse: the patch applies but changes nothing.
    const patch = Buffer.concat([diff([]), diff(["-R"])]);
    await assert.rejects(consume({ t, base, baseSha, patch }), /Empty candidate$/u);
  });
});

describe("producer credential and noise guards", () => {
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
      const { base, baseSha } = await fixture(t);
      await assert.rejects(
        produce({ t, base, baseSha, mutate: rejection.mutate }),
        rejection.error,
      );
    });
  }

  test("ignores changes under node_modules/ and .next/", async (t) => {
    const { base, baseSha } = await fixture(t);
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
    const { base, baseSha } = await fixture(t);
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
    assert.deepEqual(changedPaths(result), ["src/index.js"]);
  });

  test("drops a file rewritten with identical bytes", async (t) => {
    const { base, baseSha } = await fixture(t);
    const rewrite = ({ directory }) =>
      write({ directory, file: "README.md", contents: baseFiles["README.md"] });
    await assert.rejects(produce({ t, base, baseSha, mutate: rewrite }), noChanges);

    const patch = await produce({
      t,
      base,
      baseSha,
      mutate: async ({ directory }) => {
        await rewrite({ directory });
        await write({ directory, file: "src/index.js", contents: "export const value = 3;\n" });
      },
    });
    assert.doesNotMatch(patch.toString(), /README\.md/u);
    const result = await consume({ t, base, baseSha, patch });
    assert.deepEqual(changedPaths(result), ["src/index.js"]);
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
