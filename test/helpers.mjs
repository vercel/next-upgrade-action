import { execFileSync } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const scriptsDirectory = fileURLToPath(new URL("../scripts/", import.meta.url));

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
