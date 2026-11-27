import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { test } from "node:test";

import { codeSpan, html, pullRequestBody } from "../scripts/pull-request.mjs";
import { candidateKey, normalizeUpgradePath, readHandoff } from "../scripts/upgrade.mjs";

const repositoryRoot = new URL("../", import.meta.url);

test("normalizeUpgradePath accepts repository-relative paths", () => {
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

test("normalizeUpgradePath rejects unsafe paths", () => {
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

test("candidateKey is a stable 24 character hex key per normalized path and policy", () => {
  const key = candidateKey({ path: "apps/web", policy: "security" });
  assert.match(key, /^[0-9a-f]{24}$/u);
  assert.equal(candidateKey({ path: "apps/web", policy: "security" }), key);
  assert.equal(candidateKey({ path: "apps/web/", policy: "security" }), key);
  assert.equal(candidateKey({ path: "./apps//web", policy: "security" }), key);
  assert.notEqual(candidateKey({ path: "apps/web", policy: "latest" }), key);
  assert.notEqual(candidateKey({ path: "apps/docs", policy: "security" }), key);
  assert.notEqual(candidateKey({ path: ".", policy: "security" }), key);
});

test("candidateKey rejects invalid paths", () => {
  assert.throws(() => candidateKey({ path: "../web", policy: "security" }), {
    message: "Invalid repository-relative upgrade path.",
  });
  assert.throws(() => candidateKey({ path: "", policy: "security" }));
});

const unsupported = { message: "Unsupported Next.js upgrade handoff." };

function handoff(value) {
  return JSON.stringify(value);
}

test("readHandoff accepts a ready handoff with exact versions and a prompt", () => {
  const value = {
    status: "ready",
    installedVersion: "15.1.0",
    targetVersion: "16.0.1",
    prompt: "Upgrade.",
  };
  assert.deepEqual(readHandoff(handoff(value)), value);
  assert.deepEqual(
    readHandoff(
      handoff({ ...value, installedVersion: "16.0.0-canary.1", targetVersion: "16.0.0" }),
    ),
    { ...value, installedVersion: "16.0.0-canary.1", targetVersion: "16.0.0" },
  );
});

test("readHandoff rejects malformed ready handoffs", () => {
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
    assert.throws(() => readHandoff(handoff(value)), unsupported, JSON.stringify(value));
  }
});

test("readHandoff accepts settled statuses with a string reason", () => {
  for (const status of ["unaffected", "blocked", "unknown"]) {
    const value = { status, reason: "Because." };
    assert.deepEqual(readHandoff(handoff(value)), value);
    assert.deepEqual(readHandoff(handoff({ status, reason: "" })), { status, reason: "" });
    assert.throws(() => readHandoff(handoff({ status })), unsupported, status);
    assert.throws(() => readHandoff(handoff({ status, reason: 1 })), unsupported, status);
    assert.throws(() => readHandoff(handoff({ status, reason: null })), unsupported, status);
  }
});

test("readHandoff rejects invalid JSON and unsupported shapes", () => {
  assert.throws(() => readHandoff("{"), { message: "Invalid Next.js upgrade handoff JSON." });
  assert.throws(() => readHandoff(""), { message: "Invalid Next.js upgrade handoff JSON." });
  for (const contents of [
    "null",
    "[]",
    '["ready"]',
    "1",
    '"ready"',
    "{}",
    handoff({ status: "done", reason: "x" }),
    handoff({ status: "READY", reason: "x" }),
  ]) {
    assert.throws(() => readHandoff(contents), unsupported, contents);
  }
});

test("codeSpan uses a fence longer than the longest backtick run", () => {
  assert.equal(codeSpan("apps/web"), "`apps/web`");
  assert.equal(codeSpan("a`b"), "``a`b``");
  assert.equal(codeSpan("a```b`c"), "````a```b`c````");
});

test("codeSpan pads text that starts or ends with a space or backtick", () => {
  assert.equal(codeSpan("`a"), "`` `a ``");
  assert.equal(codeSpan("a`"), "`` a` ``");
  assert.equal(codeSpan(" a"), "`  a `");
  assert.equal(codeSpan("a "), "` a  `");
  assert.equal(codeSpan("a b"), "`a b`");
});

test("codeSpan replaces control, format, and line separator characters", () => {
  assert.equal(codeSpan("a\nb"), "`a\uFFFDb`");
  assert.equal(codeSpan("a\r\nb"), "`a\uFFFD\uFFFDb`");
  assert.equal(codeSpan("a\u0000b"), "`a\uFFFDb`");
  assert.equal(codeSpan("a\u202Eb"), "`a\uFFFDb`");
  assert.equal(codeSpan("a\u200Bb"), "`a\uFFFDb`");
  assert.equal(codeSpan("a\u2028b\u2029c"), "`a\uFFFDb\uFFFDc`");
});

test("html escapes markup characters", () => {
  assert.equal(html('a & <b c="d">'), "a &amp; &lt;b c=&quot;d&quot;&gt;");
  assert.equal(html("&lt;"), "&amp;lt;");
  assert.equal(html("plain 'text'"), "plain 'text'");
});

const runUrl = "https://github.com/owner/repo/actions/runs/1";

test("pullRequestBody describes a root app minor upgrade", () => {
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
  assert.match(body, /package-lock\.json locks next to 15\.1\.9/u);
  assert.equal(lines.at(-1), `Prepared by [this workflow run](${runUrl}).`);
});

test("pullRequestBody shows a nested path and the upgrade guide for a major upgrade", () => {
  const body = pullRequestBody({
    target: { path: "apps/web", policy: "latest", fromVersion: "15.5.0", targetVersion: "16.0.1" },
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

test("pullRequestBody fences a path containing backticks", () => {
  const body = pullRequestBody({
    target: { path: "a`b", policy: "latest", fromVersion: "15.0.0", targetVersion: "15.0.1" },
    runUrl,
  });
  assert.ok(body.includes("A scheduled upgrade of ``a`b`` with the `latest` policy."));
});

function workflowInputs(contents) {
  const lines = contents.split("\n");
  const start = lines.indexOf("    inputs:");
  assert.notEqual(start, -1, "workflow_call inputs");
  const inputs = new Map();
  let current = null;
  for (const line of lines.slice(start + 1)) {
    if (!line.startsWith("      ") && line.trim() !== "") {
      break;
    }

    const name = /^ {6}([a-z0-9-]+):$/u.exec(line);
    if (name) {
      current = { required: false };
      inputs.set(name[1], current);
    } else if (current && /^ {8}required: true$/u.test(line)) {
      current.required = true;
    }
  }

  return inputs;
}

function templateWith(contents) {
  const lines = contents.split("\n");
  const start = lines.indexOf("    with:");
  assert.notEqual(start, -1, "template with block");
  const entries = new Map();
  for (const line of lines.slice(start + 1)) {
    const entry = /^ {6}([a-z0-9-]+): (.*)$/u.exec(line);
    if (!entry) {
      break;
    }

    entries.set(entry[1], entry[2]);
  }

  return entries;
}

test("the caller template passes declared inputs of the reusable workflow", async () => {
  const [template, workflow] = await Promise.all([
    readFile(new URL("templates/next-upgrade.yml", repositoryRoot), "utf8"),
    readFile(new URL(".github/workflows/next-upgrade.yml", repositoryRoot), "utf8"),
  ]);
  const inputs = workflowInputs(workflow);
  const passed = templateWith(template);
  assert.ok(inputs.size > 0);
  assert.ok(passed.size > 0);

  for (const [key, value] of passed) {
    const placeholder = /^__NEXT_UPGRADE_([A-Z0-9_]+)__$/u.exec(value);
    assert.ok(placeholder, `${key} uses a placeholder`);
    assert.equal(placeholder[1].toLowerCase().replaceAll("_", "-"), key);
    assert.ok(inputs.has(key), `${key} is a declared input`);
  }

  for (const [key, { required }] of inputs) {
    if (required) {
      assert.ok(passed.has(key), `required input ${key} is passed`);
    }
  }

  const placeholders = [...template.matchAll(/__NEXT_UPGRADE_([A-Z0-9_]+)__/gu)].map(
    (match) => match[1],
  );
  for (const name of placeholders) {
    if (name !== "WORKFLOW_SHA") {
      assert.ok(passed.has(name.toLowerCase().replaceAll("_", "-")), name);
    }
  }

  assert.match(
    template,
    /uses: vercel\/next-upgrade-action\/\.github\/workflows\/next-upgrade\.yml@__NEXT_UPGRADE_WORKFLOW_SHA__$/mu,
  );
});
