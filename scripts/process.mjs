import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);

export function commandEnv() {
  const env = {
    CI: "true",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
  for (const name of ["PATH", "HOME", "TMPDIR", "NEXT_TELEMETRY_DISABLED"]) {
    if (process.env[name] !== undefined) {
      env[name] = process.env[name];
    }
  }

  return env;
}

export function showOutput({ output }) {
  const text = `${output.stdout ?? ""}${output.stderr ?? ""}`;
  console.error(text.split("\n").slice(-40).join("\n"));
}

export async function run({
  file,
  args,
  cwd,
  env,
  description,
  timeout,
  showOutputOnFailure,
  input,
  onTimeout,
}) {
  const limit = timeout ?? 600_000;
  const options = {
    cwd,
    env: env ?? commandEnv(),
    encoding: "buffer",
    maxBuffer: 32 * 1024 * 1024,
    timeout: limit,
    killSignal: "SIGKILL",
  };
  const started = Date.now();
  let stopping = null;
  const timer =
    onTimeout &&
    setTimeout(() => {
      stopping = onTimeout().then(
        () => null,
        (error) => error,
      );
    }, limit);
  let output = null;
  let failure = null;
  try {
    const pending = exec(file, args, options);
    pending.child.stdin.end(input);
    output = await pending;
  } catch (error) {
    if (showOutputOnFailure) {
      showOutput({ output: error });
    }

    const timedOut = error.killed || Date.now() - started >= limit;
    failure = new Error(`${description} ${timedOut ? "timed out" : "failed"}.`, { cause: error });
  }

  clearTimeout(timer);
  const stopError = stopping ? await stopping : null;
  if (stopError && failure) {
    throw new AggregateError(
      [failure, stopError],
      `${failure.message} Stopping it also failed: ${stopError.message}`,
      { cause: stopError },
    );
  }

  if (stopError) {
    throw stopError;
  }

  if (failure) {
    throw failure;
  }

  return output;
}

export const systemPath = "/usr/bin:/bin";

export function systemCommand(name) {
  for (const directory of systemPath.split(":")) {
    if (existsSync(join(directory, name))) {
      return join(directory, name);
    }
  }

  throw new Error(`Could not find ${name} in ${systemPath}.`);
}

export function sudo({ args, description }) {
  return run({
    file: systemCommand("sudo"),
    args: ["-n", ...args],
    env: { ...commandEnv(), PATH: systemPath },
    description,
  });
}
