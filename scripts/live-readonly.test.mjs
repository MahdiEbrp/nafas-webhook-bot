import { test } from "node:test";
import assert from "node:assert/strict";
import { runLiveChecks } from "./live-readonly.mjs";

const env = {
  WEBHOOK_BASE_URL: "https://clinic.example",
  WEBHOOK_USERNAME: "private-user",
  WEBHOOK_PASSWORD: "private-password",
  OPENROUTER_API_KEY: "private-key",
};
const json = (payload, status = 200) => new Response(JSON.stringify(payload), { status });

test("only GETs clinic, one fixed-model completion; no private data logged", async () => {
  const calls = [];
  const logs = [];
  const ok = await runLiveChecks({ env, log: (line) => logs.push(line), fetchImpl: async (url, init) => {
    calls.push({ url: String(url), init });
    if (calls.length === 1) return json({ data: [{ fullName: "PRIVATE RECORD" }] });
    if (calls.length === 2) return json({ data: [] });
    return json({ choices: [{ message: { content: '{"ok":true}' } }] });
  } });
  assert.equal(ok, true);
  assert.equal(calls.length, 3);
  for (const call of calls.slice(0, 2)) {
    assert.equal(call.init.method, "GET");
    assert.equal(call.init.redirect, "error");
    assert.equal(new URL(call.url).pathname, "/api/v1/webhooks/users");
    assert.equal(new URL(call.url).searchParams.get("perPage"), "1");
  }
  const body = JSON.parse(calls[2].init.body);
  assert.equal(body.model, "liquid/lfm-3-1.7b:free");
  assert.equal(body.response_format.type, "json_object");
  for (const secret of [...Object.values(env), "PRIVATE RECORD", '{"ok":true}']) {
    assert.equal(logs.join("\n").includes(secret), false);
  }
});

test("missing secrets and unsafe URLs stop before any request", async () => {
  for (const config of [{}, { ...env, WEBHOOK_BASE_URL: "http://clinic.example" }, { ...env, WEBHOOK_BASE_URL: "https://user:pass@clinic.example" }]) {
    assert.equal(await runLiveChecks({ env: config, log: () => {}, fetchImpl: () => { assert.fail("unexpected request"); } }), false);
  }
});

test("failures have failing result and suppress raw error text", async () => {
  for (const failure of [
    async () => { throw new Error("PRIVATE ERROR private-password"); },
    async () => json({ error: "PRIVATE ERROR" }, 403),
    async () => json({ error: "PRIVATE ERROR" }),
    async () => new Response("PRIVATE ERROR", { status: 200 }),
  ]) {
    const logs = [];
    assert.equal(await runLiveChecks({ env, log: (line) => logs.push(line), fetchImpl: failure }), false);
    assert.equal(logs.join("\n").includes("PRIVATE"), false);
    assert.equal(logs.join("\n").includes(env.WEBHOOK_PASSWORD), false);
  }
});

test("ignored search and malformed model JSON fail", async () => {
  let count = 0;
  const ok = await runLiveChecks({ env, log: () => {}, fetchImpl: async () => {
    count++;
    return count < 3 ? json({ items: [{ id: "hidden" }] }) : json({ choices: [{ message: { content: "not JSON" } }] });
  } });
  assert.equal(ok, false);
});
