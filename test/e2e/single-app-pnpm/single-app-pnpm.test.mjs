import { test } from "node:test";

import {
  assertFailed,
  assertModelRequests,
  assertPrepared,
  describeE2E,
  upgradeTestSetup,
} from "../utils.mjs";

describeE2E("single pnpm app", () => {
  const { upgrade } = upgradeTestSetup({ files: import.meta.dirname });

  test("prepares the upgrade", { timeout: 60_000 }, async (t) => {
    const run = await upgrade({ t, scenario: "happy" });
    await assertPrepared({ run, lockfile: "pnpm-lock.yaml" });
    assertModelRequests({ run });
  });

  test(
    "refuses a lockfile that still locks the installed version",
    { timeout: 60_000 },
    async (t) => {
      const run = await upgrade({ t, scenario: "stale-lockfile" });
      await assertFailed({
        run,
        error: /The candidate pnpm-lock\.yaml does not lock next to 15\.5\.1/u,
      });
      assertModelRequests({ run });
    },
  );
});
