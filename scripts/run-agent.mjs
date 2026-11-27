import { execFile } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { constants } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { request as httpsRequest } from "node:https";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

import { commandEnv, run, showOutput, sudo, systemCommand, systemPath } from "./process.mjs";

const exec = promisify(execFile);

export const providers = {
  codex: {
    origin: "https://api.openai.com",
    name: "OpenAI",
    endpoints: ["POST /v1/responses", "POST /v1/responses/compact", "GET /v1/models"],
    efforts: ["minimal", "low", "medium", "high", "xhigh"],
    authorize({ headers, credential }) {
      headers.authorization = `Bearer ${credential}`;
    },
  },
  claude: {
    origin: "https://api.anthropic.com",
    name: "Anthropic",
    endpoints: ["POST /v1/messages", "POST /v1/messages/count_tokens", "GET /v1/models"],
    efforts: ["low", "medium", "high", "xhigh", "max"],
    authorize({ headers, credential }) {
      headers["x-api-key"] = credential;
      headers["anthropic-version"] ??= "2023-06-01";
    },
  },
};

export const agentUser = "next-upgrade-agent";
export const proxyTokenPattern = /next-upgrade-[0-9a-f]{48}/u;
const reportSchema = {
  type: "object",
  properties: {
    verified: { type: "boolean" },
    summary: { type: "string" },
  },
  required: ["verified", "summary"],
  additionalProperties: false,
};
const replyLimit = 64 * 1024;
const agentTimeout = 90 * 60_000;
const commandTimeout = String(30 * 60_000);

async function checkApiKey({ provider, credential }) {
  const headers = {};
  provider.authorize({ headers, credential });
  const response = await fetch(new URL("/v1/models", provider.origin), { headers }).catch(
    (error) => {
      throw new Error(`Could not reach ${provider.name} to check the API key.`, { cause: error });
    },
  );
  if (response.ok) {
    await response.body.cancel();
    return;
  }

  const body = await response.text();
  if (response.status === 403 && provider.name === "OpenAI" && body.includes("api.model.read")) {
    return;
  }

  if (response.status === 401 || response.status === 403) {
    throw new Error(
      `${provider.name} rejected the API key in NEXT_UPGRADE_AGENT_CREDENTIAL (HTTP ${response.status}).`,
    );
  }

  throw new Error(`${provider.name} did not accept the API key check (HTTP ${response.status}).`);
}

async function readReply(path) {
  let file;
  try {
    file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    const info = await file.stat();
    if (!info.isFile() || info.size > replyLimit) {
      return "";
    }

    return await file.readFile("utf8");
  } catch (error) {
    if (error.code === "ENOENT") {
      return "";
    }

    throw new Error("Could not read the Codex reply.", { cause: error });
  } finally {
    if (file) {
      await file.close();
    }
  }
}

export async function startAgentProxy({ provider, credential }) {
  const allowed = new Set(provider.endpoints);
  const token = `next-upgrade-${randomBytes(24).toString("hex")}`;
  const upstream = new URL(provider.origin);
  const server = createServer((request, response) => {
    const { authorization, "x-api-key": apiKey, ...headers } = request.headers;
    const refuse = ({ status, reason }) => {
      console.error(
        `The agent proxy refused ${request.method} ${request.url} with HTTP ${status}: ${reason}.`,
      );
      request.resume();
      response.writeHead(status).end();
    };

    if (authorization !== `Bearer ${token}` && apiKey !== token) {
      refuse({ status: 403, reason: "the request did not carry the proxy token" });
      return;
    }

    let target;
    try {
      target = new URL(request.url, upstream);
    } catch (error) {
      refuse({ status: 400, reason: `the request target is not a valid URL (${error.message})` });
      return;
    }

    if (target.origin !== upstream.origin) {
      refuse({
        status: 403,
        reason: `the request targets ${target.origin} instead of ${upstream.origin}`,
      });
      return;
    }

    if (!allowed.has(`${request.method} ${target.pathname}`)) {
      refuse({ status: 403, reason: "the endpoint is not on the allowlist" });
      return;
    }

    let agentHungUp = false;
    const reportStreamError = (error) => {
      if (error && !agentHungUp) {
        console.error(
          `The agent proxy stream for ${request.method} ${target.pathname} failed: ${error.message}.`,
        );
      }
    };

    delete headers.host;
    delete headers.connection;
    delete headers["keep-alive"];
    provider.authorize({ headers, credential });
    let forwarded;
    let upstreamReply = null;
    try {
      forwarded = httpsRequest(target, { method: request.method, headers }, (reply) => {
        upstreamReply = reply;
        const { connection, "keep-alive": keepAlive, ...replyHeaders } = reply.headers;
        response.writeHead(reply.statusCode, replyHeaders);
        pipeline(reply, response, reportStreamError);
      });
    } catch (error) {
      refuse({
        status: 502,
        reason: `the upstream request could not be sent (${error.message})`,
      });
      return;
    }

    forwarded.on("error", (error) => {
      if (agentHungUp) {
        return;
      }

      console.error(
        `The agent proxy could not reach ${upstream.origin} for ${request.method} ${target.pathname}: ${error.message}.`,
      );
      if (!response.headersSent) {
        response.writeHead(502);
      }

      response.end();
    });
    response.on("close", () => {
      agentHungUp =
        !response.writableFinished && (upstreamReply === null || !upstreamReply.destroyed);
      forwarded.destroy();
    });
    pipeline(request, forwarded, reportStreamError);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");

  return {
    token,
    origin: `http://127.0.0.1:${server.address().port}`,
    close: async () => {
      server.closeAllConnections();
      server.close();
      await once(server, "close");
    },
  };
}

async function agentProcessesRunning() {
  try {
    await exec(systemCommand("pgrep"), ["-u", agentUser], {
      env: { ...commandEnv(), PATH: systemPath },
    });
    return true;
  } catch (error) {
    if (error.code === 1) {
      return false;
    }

    throw new Error("Checking for agent processes failed.", { cause: error });
  }
}

export async function stopAgent() {
  if (!(await agentProcessesRunning())) {
    return;
  }

  let killError = null;
  try {
    await sudo({
      args: ["-u", agentUser, systemCommand("pkill"), "-KILL", "-u", agentUser],
      description: "Stopping agent processes",
    });
  } catch (error) {
    killError = error;
  }

  for (let attempt = 0; attempt < 40; attempt += 1) {
    if (!(await agentProcessesRunning())) {
      return;
    }

    await sleep(250);
  }

  if (killError) {
    throw new Error("Could not stop the agent processes.", { cause: killError });
  }

  throw new Error("Could not stop the agent processes.");
}

export async function runAgent({
  agent,
  auth,
  credential,
  model,
  effort,
  root,
  guides,
  cwd,
  prompt,
}) {
  if (!Object.hasOwn(providers, agent)) {
    throw new Error("Use codex or claude for the agent.");
  }

  if (auth !== "api-key") {
    throw new Error("Only api-key auth is supported for now.");
  }

  if (effort !== undefined && !providers[agent].efforts.includes(effort)) {
    throw new Error(`Use one of ${providers[agent].efforts.join(", ")} for the ${agent} effort.`);
  }

  if (!/^[\x21-\x7e]+$/.test(credential)) {
    throw new Error(
      "NEXT_UPGRADE_AGENT_CREDENTIAL must be a single token of printable characters.",
    );
  }

  const provider = providers[agent];
  const home = await mkdtemp(join(tmpdir(), "next-upgrade-agent-"));
  const replies = await mkdtemp("/var/tmp/next-upgrade-reply-");
  const reportSchemaPath = join(home, "report-schema.json");
  let proxy;
  const cleanup = async () => {
    if (proxy) {
      await proxy.close();
    }

    await stopAgent();
    for (const path of [home, replies, root, guides]) {
      await sudo({
        args: ["chown", "-R", `${process.getuid()}:${process.getgid()}`, path],
        description: "Reclaiming agent files",
      });
    }

    await rm(home, { recursive: true, force: true });
    await rm(replies, { recursive: true, force: true });
  };

  try {
    await checkApiKey({ provider, credential });
    proxy = await startAgentProxy({ provider, credential });

    const env = {
      ...commandEnv(),
      PATH: `${dirname(process.execPath)}:${systemPath}`,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      GIT_TERMINAL_PROMPT: "0",
    };
    if (agent === "codex") {
      env.CODEX_HOME = join(home, ".codex");
      env.NEXT_UPGRADE_PROXY_TOKEN = proxy.token;
      await mkdir(env.CODEX_HOME);
      await writeFile(reportSchemaPath, JSON.stringify(reportSchema));
      await writeFile(
        join(env.CODEX_HOME, "config.toml"),
        `model_provider = "next_upgrade"
approval_policy = "never"
[model_providers.next_upgrade]
name = "OpenAI"
base_url = "${proxy.origin}/v1"
env_key = "NEXT_UPGRADE_PROXY_TOKEN"
wire_api = "responses"
[sandbox_workspace_write]
network_access = true
[shell_environment_policy]
exclude = ["NEXT_UPGRADE_PROXY_TOKEN"]
`,
      );
    } else {
      env.CLAUDE_CONFIG_DIR = join(home, ".claude");
      env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
      env.ANTHROPIC_BASE_URL = proxy.origin;
      env.ANTHROPIC_API_KEY = proxy.token;
      env.BASH_DEFAULT_TIMEOUT_MS = commandTimeout;
      env.BASH_MAX_TIMEOUT_MS = commandTimeout;
    }

    for (const path of [home, replies, root, guides]) {
      await chmod(path, 0o750);
      await sudo({
        args: ["chown", "-R", `${agentUser}:${process.getgid()}`, path],
        description: "Handing files over to the agent",
      });
    }

    const envArgs = Object.entries(env).map(([name, value]) => `${name}=${value}`);
    const runAsAgentUser = ({ file, args, ...options }) =>
      run({
        ...options,
        file: systemCommand("sudo"),
        args: [
          "-n",
          systemCommand("unshare"),
          "--pid",
          "--fork",
          "--mount-proc",
          systemCommand("setpriv"),
          `--reuid=${agentUser}`,
          `--regid=${agentUser}`,
          "--init-groups",
          "--no-new-privs",
          "--inh-caps=-all",
          "--bounding-set=-all",
          systemCommand("env"),
          "-i",
          ...envArgs,
          file,
          ...args,
        ],
        env: commandEnv(),
      });

    const modelArgs = model === undefined ? [] : ["--model", model];
    if (effort !== undefined) {
      modelArgs.push(
        ...(agent === "codex" ? ["-c", `model_reasoning_effort=${effort}`] : ["--effort", effort]),
      );
    }

    const instructions = `The checkout is ${JSON.stringify(root)}. Run the app commands from ${JSON.stringify(cwd)}.\n\n${prompt}\n\nWhen you finish, report the result. Set verified to true only after every required installation and app check passed. Otherwise set verified to false and explain the failure in summary.`;
    const agentOptions = {
      cwd: home,
      timeout: agentTimeout,
      showOutputOnFailure: true,
      onTimeout: () => stopAgent(),
    };
    const confirmVerified = ({ output, report, label, denials }) => {
      if (report !== null && typeof report === "object" && report.verified === true) {
        return;
      }

      showOutput({ output });
      if (report !== null && typeof report === "object" && typeof report.summary === "string") {
        console.error(`${label} reported: ${report.summary}`);
      }

      if (denials.length > 0) {
        const denied = denials.map(({ tool_name, tool_input }) => ({
          tool: tool_name,
          input: tool_input,
        }));
        console.error(`Auto mode denied: ${JSON.stringify(denied)}`);
      }

      throw new Error(`${label} did not confirm app verification.`);
    };

    if (agent === "codex") {
      const reply = join(replies, "reply.json");
      const output = await runAsAgentUser({
        ...agentOptions,
        file: "codex",
        args: [
          "exec",
          ...modelArgs,
          "--skip-git-repo-check",
          "--sandbox",
          "workspace-write",
          "--add-dir",
          root,
          "--output-schema",
          reportSchemaPath,
          "--output-last-message",
          reply,
          instructions,
        ],
        description: "Codex upgrade and verification",
      });
      await stopAgent();
      const replyText = await readReply(reply);
      let report = null;
      if (replyText) {
        try {
          report = JSON.parse(replyText);
        } catch (error) {
          showOutput({ output });
          throw new Error("Codex did not return a JSON report.", { cause: error });
        }
      }

      confirmVerified({ output, report, label: "Codex", denials: [] });
    } else {
      const output = await runAsAgentUser({
        ...agentOptions,
        file: "claude",
        args: [
          "--print",
          "--bare",
          ...modelArgs,
          "--output-format",
          "json",
          "--json-schema",
          JSON.stringify(reportSchema),
          "--no-session-persistence",
          "--permission-mode",
          "auto",
          "--permission-prompts",
          "none",
          "--setting-sources",
          "",
          "--add-dir",
          root,
          "--add-dir",
          guides,
          "--",
          instructions,
        ],
        description: "Claude upgrade and verification",
      });
      await stopAgent();
      let result;
      try {
        result = JSON.parse(output.stdout.toString("utf8"));
      } catch (error) {
        showOutput({ output });
        throw new Error("Claude did not return JSON output.", { cause: error });
      }

      const succeeded = result !== null && result.is_error === false;
      confirmVerified({
        output,
        report:
          succeeded && result.structured_output !== undefined ? result.structured_output : null,
        label: "Claude",
        denials:
          result !== null && Array.isArray(result.permission_denials)
            ? result.permission_denials
            : [],
      });
    }
  } catch (error) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [error, cleanupError],
        `${error.message} Cleaning up afterwards also failed: ${cleanupError.message}`,
        { cause: cleanupError },
      );
    }

    throw error;
  }

  await cleanup();
}
