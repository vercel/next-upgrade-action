import { test } from "node:test";

import { assertModelRequests, assertPrepared, describeE2e, upgradeTestSetup } from "../utils.mjs";

describeE2e({
  name: "single yarn app",
  suite: () => {
    const { upgrade } = upgradeTestSetup({ files: import.meta.dirname });

    // The stage installs Yarn 1 for the app, and the agent's change moves next in package.json
    // and yarn.lock.
    test("prepares the upgrade", { timeout: 300_000 }, async (t) => {
      const run = await upgrade({ t, scenario: "happy" });
      await assertPrepared({ run, lockfile: "yarn.lock" });
      assertModelRequests({ run });
    });
  },
});
