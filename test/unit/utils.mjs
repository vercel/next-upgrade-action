import { execFileSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { applyPatch, gitAt } from "../../scripts/pull-request.mjs";

export const scriptsDirectory = fileURLToPath(new URL("../../scripts/", import.meta.url));

export async function tempDirectory({ t, prefix }) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), prefix ?? "next-upgrade-test-")));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

export function git({ cwd, args, input }) {
  return execFileSync("git", args, {
    cwd,
    input,
    env: {
      PATH: process.env.PATH,
      HOME: cwd,
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
}

export async function createRepository({ directory, files }) {
  git({ cwd: directory, args: ["init", "--quiet", "--initial-branch=main"] });
  for (const [file, contents] of Object.entries(files)) {
    const target = join(directory, file);
    execFileSync("mkdir", ["-p", join(target, "..")]);
    await writeFile(target, contents);
  }

  git({ cwd: directory, args: ["add", "--all"] });
  git({ cwd: directory, args: ["commit", "--quiet", "--no-gpg-sign", "-m", "Base"] });
  return git({ cwd: directory, args: ["rev-parse", "HEAD"] })
    .toString()
    .trim();
}

export async function write({ directory, file, contents }) {
  const target = join(directory, file);
  await mkdir(join(target, ".."), { recursive: true });
  await writeFile(target, contents);
}

const baseFiles = {
  "package.json": '{ "name": "app", "dependencies": { "next": "15.0.0" } }\n',
  "package-lock.json": '{ "name": "app", "lockfileVersion": 3, "packages": {} }\n',
  "README.md": "# App\n",
  "src/index.js": "export const value = 1;\n",
  ".github/workflows/ci.yml": "name: ci\n",
};

export async function createBase(t) {
  const base = await tempDirectory({ t, prefix: "patch-guards-base-" });
  await createRepository({ directory: base, files: baseFiles });
  // An existing symlink and gitlink, so the guards' checks on a change's old mode are exercised.
  await symlink("README.md", join(base, "linked.md"));
  git({ cwd: base, args: ["add", "linked.md"] });
  git({
    cwd: base,
    args: ["update-index", "--add", "--cacheinfo", `160000,${"1".repeat(40)},deps/lib`],
  });
  git({ cwd: base, args: ["commit", "--quiet", "--no-gpg-sign", "-m", "Links"] });
  const baseSha = git({ cwd: base, args: ["rev-parse", "HEAD"] })
    .toString()
    .trim();
  return { base, baseSha };
}

export async function checkout({ t, base }) {
  const parent = await tempDirectory({ t, prefix: "patch-guards-candidate-" });
  const directory = join(parent, "candidate");
  git({ cwd: parent, args: ["clone", "--quiet", base, directory] });
  return directory;
}

// What a producer without the guards would emit for the same candidate.
export async function unguarded({ t, base, baseSha, mutate, stage }) {
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

export async function consume({ t, base, baseSha, patch }) {
  const scratch = await tempDirectory({ t, prefix: "patch-guards-scratch-" });
  const consumerGit = gitAt({
    cwd: scratch,
    alternates: JSON.stringify(join(base, ".git", "objects")),
  });
  await consumerGit({ args: ["init", "--bare", "--template=", "--object-format=sha1"] });
  return applyPatch({ git: consumerGit, baseSha, patch });
}

const protectedPath = /The candidate contains a protected path or unsupported file mode\.$/u;
const invalidPath = /Invalid repository-relative upgrade path\.$/u;
export const noChanges = /The agent did not change any files\.$/u;
export const consumerProtectedPath = /Patch changes a protected path$/u;
export const consumerMode = /Patch changes a Git file mode that cannot be published$/u;

// Both the producer and the consumer run every case, so a regression in one guard is caught
// even while the other still refuses the change.
export const corpus = [
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
    name: "deletes an existing symlink",
    mutate: ({ directory }) => rm(join(directory, "linked.md")),
    producer: protectedPath,
    consumer: consumerMode,
  },
  {
    name: "deletes an existing gitlink",
    mutate: ({ directory }) => rm(join(directory, "deps/lib"), { recursive: true, force: true }),
    producer: protectedPath,
    consumer: consumerMode,
  },
  {
    name: "adds a file whose path is not a normalized upgrade path",
    mutate: ({ directory }) => write({ directory, file: "src/a:b.js", contents: "x\n" }),
    producer: invalidPath,
    consumer: invalidPath,
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
    // the "Empty candidate" path is covered separately.
    name: "changes nothing",
    mutate: () => Promise.resolve(),
    producer: noChanges,
    consumer: /Git apply failed\.$/u,
  },
];
