import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";

const sha = process.env.WORKFLOW_SHA;
const ref = process.env.WORKFLOW_REF;
const version = process.env.NEXT_VERSION;
const previewSha = process.env.NEXT_PREVIEW_SHA;
const depsOnly = process.env.NEXT_UPGRADE_DEPS_ONLY === "true";

function fail(message) {
  console.error(message);
  process.exit(1);
}

function npm(args) {
  execFileSync("npm", [...args, "--ignore-scripts", "--no-audit", "--no-fund"], {
    stdio: ["ignore", "ignore", "inherit"],
  });
}

if (!/^[0-9a-f]{40}$/.test(sha ?? "") || !ref || ref.slice(ref.lastIndexOf("@") + 1) !== sha) {
  fail("The reusable workflow must be pinned to a full commit SHA.");
}

const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" });
if (head.trim() !== sha) {
  fail("The action scripts do not match the pinned commit.");
}

npm(["ci", "--omit=dev"]);
if (depsOnly) {
  process.exit(0);
}

const { default: semver } = await import("semver");
if (semver.valid(version) !== version) {
  fail("Set next-version to an exact Next.js version.");
}

if (previewSha && !/^[0-9a-f]{40}$/.test(previewSha)) {
  fail("Set next-preview-sha to a full vercel/next.js commit SHA.");
}

npm([
  "install",
  "--no-save",
  "--omit=dev",
  previewSha
    ? `https://vercel-packages.vercel.app/next/commits/${previewSha}/next`
    : `next@${version}`,
]);
const installed = JSON.parse(
  readFileSync(new URL("../node_modules/next/package.json", import.meta.url)),
).version;
const release = `${semver.major(version)}.${semver.minor(version)}.${semver.patch(version)}`;
const preview = new RegExp(`^${release}-preview-[0-9a-f]{7,40}-\\d{8}$`);
if (previewSha ? !preview.test(installed) : installed !== version) {
  fail(`The installed Next.js package ${installed} does not match ${version}.`);
}

console.log(`Using Next.js ${installed}`);
