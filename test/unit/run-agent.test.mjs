import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { once } from "node:events";
import { readFile } from "node:fs/promises";
import { request as httpRequest } from "node:http";
import { createServer as createHttpsServer, globalAgent } from "node:https";
import { connect } from "node:net";
import { join } from "node:path";
import { describe, test } from "node:test";

import { providers, proxyTokenPattern, startAgentProxy } from "../../scripts/run-agent.mjs";
import { tempDirectory } from "./utils.mjs";

const unreachableOrigin = "https://127.0.0.1:1";

async function startProxy({ t, agent, auth, origin }) {
  const proxy = await startAgentProxy({
    provider: {
      ...providers[auth ?? "api-key"][agent],
      origin: origin === undefined ? unreachableOrigin : origin,
    },
    credential: "real-credential",
  });
  t.after(() => proxy.close());
  return proxy;
}

function send({ proxy, method, path, headers, body }) {
  return new Promise((resolve, reject) => {
    const request = httpRequest(
      new URL(path, proxy.origin),
      { method, headers: { connection: "close", ...headers } },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () =>
          resolve({ status: response.statusCode, body: Buffer.concat(chunks).toString("utf8") }),
        );
      },
    );
    request.on("error", reject);
    request.end(body);
  });
}

async function sendRaw({ proxy, requestLine, headers }) {
  const { port } = new URL(proxy.origin);
  const socket = connect({ port: Number(port), host: "127.0.0.1" });
  const lines = [requestLine, "Host: 127.0.0.1", "Connection: close", ...headers, "", ""];
  socket.write(lines.join("\r\n"));
  let data = "";
  socket.on("data", (chunk) => {
    data += chunk;
  });
  await once(socket, "close");
  const status = /^HTTP\/1\.1 (\d{3})/u.exec(data);
  assert.ok(status, `unexpected raw response: ${JSON.stringify(data)}`);
  return Number(status[1]);
}

function hasOpenssl() {
  try {
    execFileSync("openssl", ["version"], { stdio: "ignore" });
    return true;
  } catch (error) {
    if (error.code === "ENOENT") {
      return false;
    }

    throw error;
  }
}

async function startUpstream({ t }) {
  const directory = await tempDirectory({ t, prefix: "next-upgrade-proxy-cert-" });
  const key = join(directory, "key.pem");
  const cert = join(directory, "cert.pem");
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      key,
      "-out",
      cert,
      "-days",
      "1",
      "-subj",
      "/CN=127.0.0.1",
      "-addext",
      "subjectAltName=IP:127.0.0.1",
    ],
    { stdio: "ignore" },
  );
  const certificate = await readFile(cert);
  const seen = [];
  const server = createHttpsServer(
    { key: await readFile(key), cert: certificate },
    (request, response) => {
      const chunks = [];
      request.on("data", (chunk) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({
          method: request.method,
          url: request.url,
          headers: request.headers,
          body: Buffer.concat(chunks).toString("utf8"),
        });
        response
          .writeHead(201, { "x-upstream": "yes", connection: "keep-alive" })
          .end("upstream body");
      });
    },
  );
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  // The proxy forwards with the default https agent, so trust the test certificate there.
  const previousCa = globalAgent.options.ca;
  globalAgent.options.ca = certificate;
  t.after(() => {
    globalAgent.options.ca = previousCa;
  });
  return { origin: `https://127.0.0.1:${server.address().port}`, seen };
}

describe("startAgentProxy", () => {
  test("the proxy token matches proxyTokenPattern and is unique per proxy", async (t) => {
    const first = await startProxy({ t, agent: "codex" });
    const second = await startProxy({ t, agent: "claude" });
    assert.match(first.token, proxyTokenPattern);
    assert.match(second.token, proxyTokenPattern);
    assert.match(first.token, /^next-upgrade-[0-9a-f]{48}$/u);
    assert.notEqual(first.token, second.token);
    assert.match(first.origin, /^http:\/\/127\.0\.0\.1:\d+$/u);
  });

  test("a request without the proxy token is refused", async (t) => {
    const proxy = await startProxy({ t, agent: "codex" });
    const response = await send({ proxy, method: "GET", path: "/v1/models" });
    assert.equal(response.status, 403);
  });

  test("a request with the wrong bearer token is refused", async (t) => {
    const proxy = await startProxy({ t, agent: "codex" });
    for (const authorization of [
      "Bearer wrong",
      `Bearer ${proxy.token}x`,
      proxy.token,
      `bearer ${proxy.token}`,
    ]) {
      const response = await send({
        proxy,
        method: "GET",
        path: "/v1/models",
        headers: { authorization },
      });
      assert.equal(response.status, 403, authorization);
    }
  });

  test("a wrong x-api-key is refused", async (t) => {
    const proxy = await startProxy({ t, agent: "claude" });
    const response = await send({
      proxy,
      method: "GET",
      path: "/v1/models",
      headers: { "x-api-key": "wrong" },
    });
    assert.equal(response.status, 403);
  });

  test("the proxy token in x-api-key passes the token check but not the allowlist", async (t) => {
    const proxy = await startProxy({ t, agent: "claude" });
    // The 502 means the token check passed and the request went to the unreachable upstream.
    const allowed = await send({
      proxy,
      method: "GET",
      path: "/v1/models",
      headers: { "x-api-key": proxy.token },
    });
    assert.equal(allowed.status, 502);
    for (const [method, path] of [
      ["POST", "/v1/files"],
      ["GET", "/v1/messages"],
      ["DELETE", "/v1/models"],
    ]) {
      const response = await send({ proxy, method, path, headers: { "x-api-key": proxy.token } });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  });

  test("endpoints off the allowlist are refused", async (t) => {
    const proxy = await startProxy({ t, agent: "codex" });
    const headers = { authorization: `Bearer ${proxy.token}` };
    for (const [method, path] of [
      ["POST", "/v1/files"],
      ["GET", "/v1/responses"],
      ["POST", "/v1/models"],
      ["GET", "/v1/models/"],
      ["GET", "/V1/models"],
      ["POST", "/v1/messages"],
      ["GET", "/"],
    ]) {
      const response = await send({ proxy, method, path, headers });
      assert.equal(response.status, 403, `${method} ${path}`);
    }
  });

  test("dot segments are normalized before the allowlist check", async (t) => {
    const proxy = await startProxy({ t, agent: "codex" });
    const headers = [`Authorization: Bearer ${proxy.token}`];
    // The 502 means the normalized path was allowed and forwarded to the unreachable upstream.
    assert.equal(new URL("/v1/../v1/models", unreachableOrigin).pathname, "/v1/models");
    assert.equal(
      await sendRaw({ proxy, requestLine: "GET /v1/../v1/models HTTP/1.1", headers }),
      502,
    );
    assert.equal(
      await sendRaw({ proxy, requestLine: "GET /v1/%2e%2e/v1/models HTTP/1.1", headers }),
      502,
    );
    assert.equal(
      await sendRaw({ proxy, requestLine: "GET /v1/models/../files HTTP/1.1", headers }),
      403,
    );
    assert.equal(
      await sendRaw({
        proxy,
        requestLine: "POST /v1/responses/../files HTTP/1.1",
        headers: [...headers, "Content-Length: 0"],
      }),
      403,
    );
  });

  test("absolute-form and scheme-relative targets to another origin are refused", async (t) => {
    const proxy = await startProxy({ t, agent: "codex" });
    const headers = [`Authorization: Bearer ${proxy.token}`];
    for (const target of [
      "http://evil.example/v1/models",
      "https://evil.example/v1/models",
      "http://127.0.0.1:1/v1/models",
      "//evil.example/v1/models",
    ]) {
      assert.equal(
        await sendRaw({ proxy, requestLine: `GET ${target} HTTP/1.1`, headers }),
        403,
        target,
      );
    }
  });

  test("a malformed absolute target is rejected with 400", async (t) => {
    const proxy = await startProxy({ t, agent: "codex" });
    const headers = [`Authorization: Bearer ${proxy.token}`];
    for (const target of ["http://[::1", "http://exa%mple/v1/models", "http://[zz]/v1/models"]) {
      assert.equal(
        await sendRaw({ proxy, requestLine: `GET ${target} HTTP/1.1`, headers }),
        400,
        target,
      );
    }
  });

  test("allowed requests are forwarded and yield 502 when the upstream is unreachable", async (t) => {
    const codex = await startProxy({ t, agent: "codex" });
    const claude = await startProxy({ t, agent: "claude" });
    const cases = [
      {
        proxy: codex,
        method: "GET",
        path: "/v1/models",
        headers: { authorization: `Bearer ${codex.token}` },
      },
      {
        proxy: codex,
        method: "POST",
        path: "/v1/responses",
        headers: { authorization: `Bearer ${codex.token}` },
        body: "{}",
      },
      {
        proxy: codex,
        method: "POST",
        path: "/v1/responses/compact?x=1",
        headers: { authorization: `Bearer ${codex.token}` },
        body: "{}",
      },
      {
        proxy: claude,
        method: "POST",
        path: "/v1/messages",
        headers: { "x-api-key": claude.token },
        body: "{}",
      },
      {
        proxy: claude,
        method: "POST",
        path: "/v1/messages/count_tokens",
        headers: { authorization: `Bearer ${claude.token}` },
        body: "{}",
      },
    ];
    for (const { proxy, method, path, headers, body } of cases) {
      const response = await send({ proxy, method, path, headers, body });
      assert.equal(response.status, 502, `${method} ${path}`);
    }
  });

  test("close resolves and stops accepting connections", async () => {
    const proxy = await startAgentProxy({
      provider: { ...providers["api-key"].codex, origin: unreachableOrigin },
      credential: "real-credential",
    });
    assert.equal(await proxy.close(), undefined);
    await assert.rejects(send({ proxy, method: "GET", path: "/v1/models" }), {
      code: "ECONNREFUSED",
    });
  });

  test(
    "forwarded requests carry the real credential instead of the proxy token",
    { skip: hasOpenssl() ? false : "openssl is not installed" },
    async (t) => {
      const upstream = await startUpstream({ t });
      const codex = await startProxy({ t, agent: "codex", origin: upstream.origin });
      const claude = await startProxy({ t, agent: "claude", origin: upstream.origin });

      const codexResponse = await send({
        proxy: codex,
        method: "POST",
        path: "/v1/responses?stream=true",
        headers: {
          authorization: `Bearer ${codex.token}`,
          "x-api-key": codex.token,
          "content-type": "application/json",
        },
        body: '{"input":"hi"}',
      });
      assert.equal(codexResponse.status, 201);
      assert.equal(codexResponse.body, "upstream body");

      const claudeResponse = await send({
        proxy: claude,
        method: "POST",
        path: "/v1/messages",
        headers: { "x-api-key": claude.token, authorization: `Bearer ${claude.token}` },
        body: "{}",
      });
      assert.equal(claudeResponse.status, 201);

      assert.equal(upstream.seen.length, 2);
      const [codexSeen, claudeSeen] = upstream.seen;
      const upstreamHost = new URL(upstream.origin).host;

      assert.equal(codexSeen.method, "POST");
      assert.equal(codexSeen.url, "/v1/responses?stream=true");
      assert.equal(codexSeen.body, '{"input":"hi"}');
      assert.equal(codexSeen.headers.authorization, "Bearer real-credential");
      assert.equal(codexSeen.headers["x-api-key"], undefined);
      assert.equal(codexSeen.headers["content-type"], "application/json");
      assert.equal(codexSeen.headers.host, upstreamHost);

      assert.equal(claudeSeen.url, "/v1/messages");
      assert.equal(claudeSeen.headers["x-api-key"], "real-credential");
      assert.equal(claudeSeen.headers.authorization, undefined);
      assert.equal(claudeSeen.headers["anthropic-version"], "2023-06-01");
      assert.equal(claudeSeen.headers.host, upstreamHost);

      for (const seen of upstream.seen) {
        assert.ok(!JSON.stringify(seen.headers).includes(codex.token));
        assert.ok(!JSON.stringify(seen.headers).includes(claude.token));
        assert.ok(!JSON.stringify(seen.headers).includes(new URL(codex.origin).host));
        assert.ok(!JSON.stringify(seen.headers).includes(new URL(claude.origin).host));
      }
    },
  );

  test(
    "AI Gateway requests stay on the agent's compatibility path and carry the key as a bearer token",
    { skip: hasOpenssl() ? false : "openssl is not installed" },
    async (t) => {
      const upstream = await startUpstream({ t });
      const codex = await startProxy({
        t,
        agent: "codex",
        auth: "ai-gateway",
        origin: upstream.origin,
      });
      const claude = await startProxy({
        t,
        agent: "claude",
        auth: "ai-gateway",
        origin: upstream.origin,
      });
      const cases = [
        { proxy: codex, method: "POST", path: "/codex/v1/responses", status: 201 },
        { proxy: codex, method: "GET", path: "/codex/v1/models", status: 201 },
        { proxy: codex, method: "POST", path: "/v1/responses", status: 403 },
        { proxy: claude, method: "POST", path: "/claude-code/v1/messages", status: 201 },
        {
          proxy: claude,
          method: "POST",
          path: "/claude-code/v1/messages/count_tokens",
          status: 201,
        },
        { proxy: claude, method: "POST", path: "/v1/messages", status: 403 },
        { proxy: claude, method: "GET", path: "/v1/credits", status: 403 },
      ];
      for (const { proxy, method, path, status } of cases) {
        const response = await send({
          proxy,
          method,
          path,
          headers: { authorization: `Bearer ${proxy.token}` },
          body: method === "POST" ? "{}" : undefined,
        });
        assert.equal(response.status, status, `${method} ${path}`);
      }

      assert.deepEqual(
        upstream.seen.map(({ url }) => url),
        [
          "/codex/v1/responses",
          "/codex/v1/models",
          "/claude-code/v1/messages",
          "/claude-code/v1/messages/count_tokens",
        ],
      );
      for (const seen of upstream.seen) {
        assert.equal(seen.headers.authorization, "Bearer real-credential");
        assert.equal(seen.headers["x-api-key"], undefined);
      }
    },
  );

  test(
    "the agent's anthropic-version header is kept",
    { skip: hasOpenssl() ? false : "openssl is not installed" },
    async (t) => {
      const upstream = await startUpstream({ t });
      const claude = await startProxy({ t, agent: "claude", origin: upstream.origin });
      const response = await send({
        proxy: claude,
        method: "GET",
        path: "/v1/models",
        headers: { "x-api-key": claude.token, "anthropic-version": "2099-01-01" },
      });
      assert.equal(response.status, 201);
      assert.equal(upstream.seen[0].headers["anthropic-version"], "2099-01-01");
    },
  );
});
