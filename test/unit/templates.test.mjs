import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { describe, test } from "node:test";

const repositoryRoot = new URL("../../", import.meta.url);

describe("caller template", () => {
  test("passes declared inputs of the reusable workflow", async () => {
    const [template, workflow] = await Promise.all([
      readFile(new URL("templates/next-upgrade.yml", repositoryRoot), "utf8"),
      readFile(new URL(".github/workflows/next-upgrade.yml", repositoryRoot), "utf8"),
    ]);
    const workflowLines = workflow.split("\n");
    const inputsStart = workflowLines.indexOf("    inputs:");
    assert.notEqual(inputsStart, -1, "workflow_call inputs");
    const inputs = new Map();
    let current = null;
    for (const line of workflowLines.slice(inputsStart + 1)) {
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

    const templateLines = template.split("\n");
    const withStart = templateLines.indexOf("    with:");
    assert.notEqual(withStart, -1, "template with block");
    const passed = new Map();
    for (const line of templateLines.slice(withStart + 1)) {
      const entry = /^ {6}([a-z0-9-]+): (.*)$/u.exec(line);
      if (!entry) {
        break;
      }

      passed.set(entry[1], entry[2]);
    }

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
});
