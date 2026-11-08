import { test } from "node:test";
import assert from "node:assert/strict";
import { runUserLifecycle } from "./live-users-lifecycle.mjs";
const env = {
  CONFIRM_TEST_USER_WRITES: "CREATE_UPDATE_DELETE_TEST_USER",
  WEBHOOK_BASE_URL: "https://clinic.example", WEBHOOK_USERNAME: "private-login", WEBHOOK_PASSWORD: "private-secret",
  TEST_USER_EMAIL: "private-test@example.com", TEST_USER_PHONE: "+15555550123", TEST_USER_ROLE_KEY: "test-role",
};
const id = "11111111-1111-4111-8111-111111111111";
const json = (data) => new Response(JSON.stringify({ ok: true, data }));
function mock({ occupied = false, failPatch = false, uncertain = false, failDelete = false, malformed = false } = {}) {
  let record;
  const calls = [];
  return { calls, fetchImpl: async (input, init) => {
    const url = new URL(input);
    calls.push({ url, ...init });
    assert.equal(init.redirect, "error");
    if (init.method === "GET") {
      if (occupied) return json({ items: [{ id: "existing" }] });
      const query = url.searchParams.get("search");
      return json({ items: record && [record.fullName, record.email, record.phone].some((field) => field.includes(query)) ? [record] : [] });
    }
    if (init.method === "POST") {
      record = { ...JSON.parse(init.body), id };
      if (uncertain) throw new Error("private-secret");
      if (malformed) return json({ id: "unsafe-id" });
      return json(record);
    }
    assert.equal(url.pathname, `/api/v1/webhooks/users/${id}`);
    if (init.method === "PATCH") {
      if (failPatch) throw new Error("private-secret");
      record = { ...record, ...JSON.parse(init.body) };
      return json(record);
    }
    assert.equal(init.method, "DELETE");
    if (failDelete) throw new Error("private-secret");
    record = undefined;
    return new Response(null, { status: 204 });
  } };
}

test("full lifecycle targets only the returned UUID and suppresses personal data", async () => {
  const fixture = mock();
  const logs = [];
  assert.equal(await runUserLifecycle({ env, ...fixture, log: (line) => logs.push(line) }), true);
  assert.deepEqual(fixture.calls.filter((call) => call.method !== "GET").map((call) => call.method), ["POST", "PATCH", "DELETE"]);
  for (const secret of [env.TEST_USER_EMAIL, env.TEST_USER_PHONE, env.WEBHOOK_PASSWORD, id]) assert(!logs.join("\n").includes(secret));
});
test("missing consent or secrets cannot issue any request", async () => {
  for (const config of [{ ...env, CONFIRM_TEST_USER_WRITES: "" }, { ...env, TEST_USER_ROLE_KEY: "" }]) {
    assert.equal(await runUserLifecycle({ env: config, log: () => {}, fetchImpl: () => assert.fail("unexpected request") }), false);
  }
});
test("existing contacts prevent all writes", async () => {
  const fixture = mock({ occupied: true });
  assert.equal(await runUserLifecycle({ env, ...fixture, log: () => {} }), false);
  assert(fixture.calls.every((call) => call.method === "GET"));
});
test("patch failure still cleans up the created UUID", async () => {
  const fixture = mock({ failPatch: true });
  assert.equal(await runUserLifecycle({ env, ...fixture, log: () => {} }), false);
  assert.equal(fixture.calls.filter((call) => call.method === "DELETE").length, 1);
});
test("ambiguous create or malformed UUID never leads to patch or delete", async () => {
  for (const option of [{ uncertain: true }, { malformed: true }]) {
    const fixture = mock(option);
    const logs = [];
    assert.equal(await runUserLifecycle({ env, ...fixture, log: (line) => logs.push(line) }), false);
    assert(fixture.calls.every((call) => ["GET", "POST"].includes(call.method)));
    assert(logs.some((line) => line.includes("outcome uncertain")));
  }
});
test("cleanup failure is reported without printing raw errors", async () => {
  const fixture = mock({ failDelete: true });
  const logs = [];
  assert.equal(await runUserLifecycle({ env, ...fixture, log: (line) => logs.push(line) }), false);
  assert(logs.some((line) => line.startsWith("FAIL cleanup")));
  assert(!logs.join("\n").includes(env.WEBHOOK_PASSWORD));
});
