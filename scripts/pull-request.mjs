import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as core from "@actions/core";
import { getOctokit } from "@actions/github";
import semver from "semver";

import { commandEnv, run, systemCommand, systemPath } from "./process.mjs";
import { candidateKey, normalizeUpgradePath } from "./upgrade.mjs";

function gitAt({ cwd, alternates }) {
  const env = {
    ...commandEnv(),
    PATH: systemPath,
    GIT_TERMINAL_PROMPT: "0",
    GIT_ALLOW_PROTOCOL: "file",
  };
  if (alternates) {
    env.GIT_ALTERNATE_OBJECT_DIRECTORIES = alternates;
  }

  return async ({ args, input }) =>
    (
      await run({
        file: systemCommand("git"),
        args,
        cwd,
        env,
        description: `Git ${args[0]}`,
        input,
      })
    ).stdout;
}

function githubClient({ token, repository }) {
  const octokit = getOctokit(token);
  const [owner, repo] = repository.split("/");
  const call = async ({ label, response }) => {
    try {
      return await response;
    } catch (error) {
      const status = Number.isInteger(error.status) ? ` (HTTP ${error.status})` : "";
      throw new Error(`GitHub ${label} failed${status}`, { cause: error });
    }
  };

  return {
    request: async ({ route, parameters }) =>
      (
        await call({
          label: route.split(" ")[0],
          response: octokit.request(route, { owner, repo, ...parameters }),
        })
      ).data,
    paginate: ({ route, parameters }) =>
      call({
        label: route.split(" ")[0],
        response: octokit.paginate(route, { owner, repo, ...parameters }),
      }),
    graphql: ({ query, variables }) =>
      call({ label: "GraphQL", response: octokit.graphql(query, variables) }),
  };
}

async function entries({ git, tree }) {
  const listing = await git({ args: ["ls-tree", "-rz", tree] });
  const decoded = listing.toString("utf8");
  if (!listing.equals(Buffer.from(decoded))) {
    throw new Error("Non-UTF-8 Git path");
  }

  return new Map(
    decoded
      .split("\0")
      .filter(Boolean)
      .map((line) => {
        const tab = line.indexOf("\t");
        const [mode, , sha] = line.slice(0, tab).split(" ");
        return [line.slice(tab + 1), { mode, sha }];
      }),
  );
}

async function applyPatch({ git, baseSha, patch }) {
  const base = await entries({ git, tree: baseSha });
  await git({ args: ["read-tree", baseSha] });
  await git({ args: ["apply", "--cached", "--binary", "--whitespace=nowarn", "-"], input: patch });
  const tree = (await git({ args: ["write-tree"] })).toString().trim();
  const result = await entries({ git, tree });
  const changes = [];
  for (const file of new Set([...base.keys(), ...result.keys()])) {
    const before = base.get(file);
    const after = result.get(file);
    if (before && after && before.sha === after.sha && before.mode === after.mode) {
      continue;
    }

    if (
      !(
        normalizeUpgradePath(file) === file &&
        !file.split("/").some((part) => /^\.github$|^\.gitmodules$/i.test(part))
      )
    ) {
      throw new Error("Patch changes a protected path");
    }

    if (
      !(
        (!before || before.mode === "100644" || before.mode === "100755") &&
        (!after || after.mode === (before ? before.mode : "100644"))
      )
    ) {
      throw new Error("Patch changes a Git file mode that cannot be published");
    }

    changes.push({ path: file, entry: after });
  }

  if (changes.length === 0) {
    throw new Error("Empty candidate");
  }

  return { tree, changes };
}

async function findOpenPullRequest({ github, repository, baseBranch, target }) {
  const pulls = await github.paginate({
    route: "GET /repos/{owner}/{repo}/pulls",
    parameters: {
      state: "open",
      base: baseBranch,
      per_page: 100,
    },
  });
  const branchPrefix = `next-upgrade/${candidateKey(target)}-`;
  const pull = pulls.find(
    (candidatePull) =>
      candidatePull.head.repo !== null &&
      candidatePull.head.repo.full_name.toLowerCase() === repository.toLowerCase() &&
      candidatePull.head.ref.startsWith(branchPrefix),
  );
  if (!pull) {
    return null;
  }

  return { status: "existing_pull_request", url: pull.html_url };
}

function codeSpan(text) {
  const visible = text.replace(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/gu, "\uFFFD");
  const longest = Math.max(0, ...(visible.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(longest + 1);
  const padded = /^[ `]|[ `]$/u.test(visible) ? ` ${visible} ` : visible;
  return `${fence}${padded}${fence}`;
}

function pullRequestBody({ target, runUrl }) {
  const { path: appPath, policy, fromVersion, targetVersion } = target;
  const lines = [
    `### Next.js ${fromVersion} → ${targetVersion}`,
    "",
    `A scheduled upgrade${appPath === "." ? "" : ` of ${codeSpan(appPath)}`} with the \`${policy}\` policy.`,
    "",
    `- Release notes: https://github.com/vercel/next.js/releases/tag/v${targetVersion}`,
  ];
  const targetMajor = semver.major(targetVersion);
  if (semver.major(fromVersion) !== targetMajor) {
    lines.push(
      `- Upgrade guide: https://nextjs.org/docs/app/guides/upgrading/version-${targetMajor}`,
    );
  }

  lines.push(
    "",
    "### Verification",
    "",
    `The hosted agent followed the Next.js upgrade guides and reported that the app's installation and checks passed. The workflow then checked that package.json requires next ${targetVersion} and the lockfile locks it, and that the change touches no workflow files, submodules, symlinks, or file modes and contains no agent credential.`,
    "",
    "Review the changes and run your own checks before merging.",
    "",
    `Prepared by [this workflow run](${runUrl}).`,
  );

  return lines.join("\n");
}

const signedCommitMutation = `
  mutation CommitNextUpgrade($input: CreateCommitOnBranchInput!) {
    createCommitOnBranch(input: $input) {
      commit {
        oid
        tree { oid }
        signature { isValid state }
      }
    }
  }
`;

async function commitCandidate({
  git,
  github,
  repository,
  branchName,
  baseSha,
  tree,
  headline,
  changes,
}) {
  const additions = [];
  const deletions = [];
  for (const change of changes) {
    if (change.entry) {
      additions.push({
        path: change.path,
        contents: (await git({ args: ["cat-file", "blob", change.entry.sha] })).toString("base64"),
      });
    } else {
      deletions.push({ path: change.path });
    }
  }

  const response = await github.graphql({
    query: signedCommitMutation,
    variables: {
      input: {
        branch: { repositoryNameWithOwner: repository, branchName },
        expectedHeadOid: baseSha,
        message: { headline },
        fileChanges: { additions, deletions },
      },
    },
  });
  const { commit } = response.createCommitOnBranch;
  if (
    !(
      commit !== null &&
      commit.tree.oid === tree &&
      commit.signature !== null &&
      commit.signature.isValid === true &&
      commit.signature.state === "VALID"
    )
  ) {
    throw new Error("GitHub did not confirm the expected signed commit and tree");
  }
}

async function openPullRequestFor({
  git,
  github,
  repository,
  baseBranch,
  baseSha,
  target,
  verified,
  runUrl,
}) {
  const existing = await findOpenPullRequest({ github, repository, baseBranch, target });
  if (existing) {
    return existing;
  }

  const branchName = `next-upgrade/${target.id}-${verified.tree.slice(0, 12)}`;
  const branch = `refs/heads/${branchName}`;
  const headline = `Upgrade Next.js to ${target.targetVersion}`;

  const refs = await github.request({
    route: `GET /repos/{owner}/{repo}/git/matching-refs/${branch.slice("refs/".length)}`,
  });
  const existingRef = refs.find((entry) => entry.ref === branch);
  let head = existingRef ? existingRef.object.sha : null;
  if (!head) {
    await github.request({
      route: "POST /repos/{owner}/{repo}/git/refs",
      parameters: { ref: branch, sha: baseSha },
    });
    head = baseSha;
  }

  if (head === baseSha) {
    await commitCandidate({
      git,
      github,
      repository,
      branchName,
      baseSha,
      tree: verified.tree,
      headline,
      changes: verified.changes,
    });
  } else {
    const commit = await github.request({
      route: "GET /repos/{owner}/{repo}/git/commits/{commit_sha}",
      parameters: {
        commit_sha: head,
      },
    });
    if (
      !(
        commit.tree.sha === verified.tree &&
        commit.parents.length === 1 &&
        commit.parents[0].sha === baseSha &&
        commit.message.trimEnd() === headline &&
        commit.verification.verified === true &&
        commit.verification.reason === "valid"
      )
    ) {
      throw new Error("Unexpected GitHub candidate branch commit");
    }
  }

  const pull = await github.request({
    route: "POST /repos/{owner}/{repo}/pulls",
    parameters: {
      base: baseBranch,
      head: branchName,
      title: headline,
      body: pullRequestBody({ target, runUrl }),
    },
  });
  return { status: "new_pull_request", url: pull.html_url };
}

async function openPullRequest({
  github,
  root,
  artifactDirectory,
  target,
  repository,
  baseBranch,
  runUrl,
}) {
  const index = JSON.parse(readFileSync(path.join(artifactDirectory, "index.json"), "utf8"));
  if (index === null || !["no_upgrade", "blocked", "prepared"].includes(index.status)) {
    throw new Error("Invalid publication index");
  }

  if (index.status !== "prepared") {
    return { status: index.status };
  }

  const consumerGit = gitAt({ cwd: root });
  await consumerGit({ args: ["check-ref-format", `refs/heads/${baseBranch}`] });
  if (!baseBranch || baseBranch.startsWith("next-upgrade/")) {
    throw new Error("Invalid base branch");
  }

  const baseSha = (await consumerGit({ args: ["rev-parse", "--verify", "HEAD^{commit}"] }))
    .toString()
    .trim();
  if (baseSha !== index.baseSha) {
    throw new Error("Unexpected base checkout");
  }

  const { id, fromVersion, targetVersion } = index.candidate ?? {};
  if (
    !(
      id === candidateKey(target) &&
      semver.valid(fromVersion) === fromVersion &&
      semver.valid(targetVersion) === targetVersion &&
      semver.gt(targetVersion, fromVersion)
    )
  ) {
    throw new Error("Unexpected candidate");
  }

  const scratch = mkdtempSync(path.join(tmpdir(), "next-upgrade-pull-request-"));
  try {
    const objects = (
      await consumerGit({
        args: ["rev-parse", "--path-format=absolute", "--git-path", "objects"],
      })
    )
      .toString()
      .trim();
    const git = gitAt({ cwd: scratch, alternates: JSON.stringify(objects) });
    await git({ args: ["init", "--bare", "--template=", "--object-format=sha1"] });
    const verified = await applyPatch({
      git,
      baseSha,
      patch: readFileSync(path.join(artifactDirectory, `${id}.patch`)),
    });
    return await openPullRequestFor({
      git,
      github,
      repository,
      baseBranch,
      baseSha,
      target: { ...target, id, fromVersion, targetVersion },
      verified,
      runUrl,
    });
  } finally {
    rmSync(scratch, { force: true, recursive: true });
  }
}

function html(text) {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

async function writeSummary({ appPath, status, url }) {
  const statusLabels = {
    no_upgrade: "Already up to date",
    blocked: "Blocked",
    existing_pull_request: "Existing pull request",
    new_pull_request: "New pull request",
  };
  const link = url ? ` <a href="${html(url)}">${html(url)}</a>` : "";
  await core.summary
    .addHeading("Next.js upgrade", 2)
    .addList([`${statusLabels[status]} for <code>${html(appPath)}</code>${link}`])
    .write();
}

async function main(env) {
  const appPath = normalizeUpgradePath(env.NEXT_UPGRADE_APP_PATH);
  const target = { path: appPath, policy: env.NEXT_UPGRADE_POLICY };
  const repository = env.GITHUB_REPOSITORY;
  const github = githubClient({ token: env.GH_TOKEN, repository });

  if (env.NEXT_UPGRADE_STAGE === "check-open-pull-request") {
    const { default_branch: baseBranch } = await github.request({
      route: "GET /repos/{owner}/{repo}",
    });
    const existing = await findOpenPullRequest({ github, repository, baseBranch, target });
    if (!existing) {
      const refs = await github.request({
        route: "GET /repos/{owner}/{repo}/git/matching-refs/heads/next-upgrade",
      });
      if (refs.some((entry) => entry.ref === "refs/heads/next-upgrade")) {
        throw new Error(
          "The branch `next-upgrade` blocks the `next-upgrade/` candidate branches; rename or delete it",
        );
      }
    }

    core.setOutput("default-branch", baseBranch);
    core.setOutput("pull-request", existing ? existing.url : "");
    if (existing) {
      console.error(`${appPath}: An upgrade pull request is already open: ${existing.url}`);
      await writeSummary({ appPath, ...existing });
    }

    return;
  }

  if (env.NEXT_UPGRADE_STAGE !== "open-pull-request") {
    throw new Error("Set NEXT_UPGRADE_STAGE to check-open-pull-request or open-pull-request");
  }

  const result = await openPullRequest({
    github,
    root: env.NEXT_UPGRADE_ROOT,
    artifactDirectory: env.NEXT_UPGRADE_ARTIFACT_DIR,
    target,
    repository,
    baseBranch: env.NEXT_UPGRADE_BASE_BRANCH,
    runUrl: `${env.GITHUB_SERVER_URL}/${repository}/actions/runs/${env.GITHUB_RUN_ID}`,
  });
  await writeSummary({ appPath, ...result });
}

try {
  await main(process.env);
} catch (error) {
  console.error(error);
  core.setFailed(`Could not open the Next.js upgrade pull request: ${error.message}.`);
}
