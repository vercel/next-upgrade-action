import { test } from "node:test";

import { assertModelRequests, assertPrepared, describeE2e, upgradeTestSetup } from "../utils.mjs";

describeE2e({
  name: "single pnpm app",
  suite: () => {
    const { upgrade } = upgradeTestSetup({ files: import.meta.dirname });

    // The stage installs pnpm for the app, and the agent's change moves next in package.json
    // and pnpm-lock.yaml.
    test("prepares the upgrade", { timeout: 300_000 }, async (t) => {
      const run = await upgrade({ t, scenario: "happy" });
      await assertPrepared({ run, lockfile: "pnpm-lock.yaml" });
      assertModelRequests({ run });
    });
  },
});
