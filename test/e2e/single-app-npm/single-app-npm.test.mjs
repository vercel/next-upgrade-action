import { test } from "node:test";

import {
  assertFailed,
  assertModelRequests,
  assertPrepared,
  describeE2E,
  upgradeTestSetup,
} from "../utils.mjs";

const protectedChange = /protected path or unsupported file mode/u;
const scenarios = [
  { name: "happy", status: "prepared" },
  { name: "background", status: "prepared" },
  { name: "node-directory", status: "prepared" },
  { name: "workflow", status: "failed", error: protectedChange },
  { name: "credential", status: "failed", error: /contains the agent credential or proxy token/u },
  { name: "token", status: "failed", error: /contains the agent credential or proxy token/u },
  { name: "symlink", status: "failed", error: protectedChange },
  // The reclaiming chown clears S_ISUID, so the leftover 100755 mode is what gets refused.
  {
    name: "setuid",
    status: "failed",
    error: /special permissions|protected path or unsupported file mode/u,
  },
  // chown and chmod keep S_ISGID on directories, so copyTree refuses it.
  { name: "setgid-directory", status: "failed", error: /special permissions/u },
  {
    name: "wrong-version",
    status: "failed",
    error: /package\.json requires next 15\.5\.0 instead of 15\.5\.1/u,
  },
  {
    name: "stale-lockfile",
    status: "failed",
    error: /The candidate package-lock\.json does not lock next to 15\.5\.1/u,
  },
  { name: "nothing", status: "failed", error: /did not change any files/u },
  { name: "unverified", status: "failed", error: /Claude did not confirm app verification/u },
];

describeE2E("single npm app", () => {
  const { upgrade } = upgradeTestSetup({ files: import.meta.dirname });

  for (const scenario of scenarios) {
    test(`${scenario.name} agent`, { timeout: 60_000 }, async (t) => {
      const run = await upgrade({ t, scenario: scenario.name });
      if (scenario.status === "prepared") {
        await assertPrepared({ run, lockfile: "package-lock.json" });
      } else {
        await assertFailed({ run, error: scenario.error });
      }

      assertModelRequests({ run });
    });
  }
});
