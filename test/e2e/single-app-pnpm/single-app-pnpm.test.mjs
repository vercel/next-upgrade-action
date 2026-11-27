import assert from "node:assert/strict";
import { readdir } from "node:fs/promises";
import { test } from "node:test";

import { describeE2e, upgradeTestSetup } from "../utils.mjs";

describeE2e({
  name: "single pnpm app",
  suite: () => {
    const { upgrade } = upgradeTestSetup({ files: import.meta.dirname });

    // Scheduled upgrades only support apps locked by npm for now, so a pnpm-lock.yaml app stops before
    // the agent starts or the API key is checked.
    test("is refused without a package-lock.json", { timeout: 120_000 }, async (t) => {
      const run = await upgrade({ t, scenario: "happy" });
      assert.equal(run.code, 1, run.output);
      assert.deepEqual(run.index, { baseSha: run.baseSha, status: "failed" });
      assert.deepEqual(await readdir(run.artifacts), ["index.json"]);
      assert.match(run.stderr, /Failed during setup/u);
      assert.match(run.stderr, /need a committed package-lock\.json/u);
      assert.deepEqual(run.requests, []);
    });
  },
});
