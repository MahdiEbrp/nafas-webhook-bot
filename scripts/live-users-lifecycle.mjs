import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function unwrap(value) {
  for (let n = 0; n < 4; n++) {
    if (!value || typeof value !== "object" || value.ok === false || value.success === false || value.error) throw new Error();
    if (Array.isArray(value) || !("data" in value)) return value;
    value = value.data;
  }
  throw new Error();
}
function rows(value) {
  value = unwrap(value);
  if (Array.isArray(value)) return value;
  for (const key of ["items", "rows"]) if (Array.isArray(value[key])) return value[key];
  throw new Error();
}

// Never print input, records, raw errors, response bodies or generated passwords.
export async function runUserLifecycle({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  const required = ["WEBHOOK_BASE_URL", "WEBHOOK_USERNAME", "WEBHOOK_PASSWORD", "TEST_USER_EMAIL", "TEST_USER_PHONE", "TEST_USER_ROLE_KEY"];
  if (env.CONFIRM_TEST_USER_WRITES !== "CREATE_UPDATE_DELETE_TEST_USER" || required.some((key) => !env[key]?.trim())) {
    log("FAIL configuration: explicit write consent and all test-user secrets are required");
    return false;
  }
  let base;
  try {
    base = new URL(env.WEBHOOK_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || base.pathname !== "/") throw new Error();
    if (!/^\+?[0-9]{7,15}$/.test(env.TEST_USER_PHONE) || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(env.TEST_USER_EMAIL)) throw new Error();
  } catch {
    log("FAIL configuration: invalid HTTPS origin or test contact format");
    return false;
  }
  const marker = randomUUID();
  const name = `آزمایش نفس ${marker}`;
  const updatedName = `آزمایش ویرایش نفس ${marker}`;
  const email = env.TEST_USER_EMAIL;
  const phone = env.TEST_USER_PHONE;
  const auth = `Basic ${Buffer.from(`${env.WEBHOOK_USERNAME}:${env.WEBHOOK_PASSWORD}`).toString("base64")}`;
  let ownedId;
  let createAttempted = false;
  let ok = true;
  async function request(method, searchOrId, body) {
    const url = new URL(`/api/v1/webhooks/users${method === "PATCH" || method === "DELETE" ? `/${searchOrId}` : ""}`, base);
    if (method === "GET") {
      url.searchParams.set("search", searchOrId);
      url.searchParams.set("page", "1");
      url.searchParams.set("perPage", "100");
    }
    const response = await fetchImpl(url, {
      method, redirect: "error", signal: AbortSignal.timeout(30_000),
      headers: { Authorization: auth, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    if (!response.ok) throw new Error();
    if (method === "DELETE" && response.status === 204) return null;
    const payload = await response.json();
    // Even HTTP 200 can contain an application-level error.
    unwrap(payload);
    return payload;
  }
  async function search(query) { return rows(await request("GET", query)); }
  const check = (condition) => { if (!condition) throw new Error(); };
  try {
    // Fail closed: no existing contacts, and search must return valid lists.
    check((await search(email)).length === 0);
    check((await search(phone)).length === 0);
    log("PASS preflight: test contacts have no search matches");
    createAttempted = true;
    const created = unwrap(await request("POST", undefined, {
      fullName: name, email, phone, roleKey: env.TEST_USER_ROLE_KEY,
      password: `Aa1!${randomUUID()}${randomUUID()}`,
    }));
    // Never discover a deletion target from search results or user-supplied IDs.
    check(typeof created.id === "string" && uuid.test(created.id));
    ownedId = created.id;
    log("PASS create: dedicated test user returned a valid ID");
    const exact = await search(name);
    const record = exact.find((row) => row.id === ownedId);
    check(record?.fullName === name && record?.email === email && record?.phone === phone);
    log("PASS exact Persian name search and created fields");
    check((await search(marker)).some((row) => row.id === ownedId));
    log("PASS partial name search for unique test marker");
    check((await search(`absent-${randomUUID()}`)).length === 0);
    log("PASS nonexistent name search");
    await request("PATCH", ownedId, { fullName: updatedName, isActive: false });
    const updated = (await search(updatedName)).find((row) => row.id === ownedId);
    check(updated?.fullName === updatedName && updated?.isActive === false);
    log("PASS update: changed name and inactive status verified");
  } catch {
    ok = false;
    log("FAIL lifecycle: request, response validation or assertion failed; private details suppressed");
  } finally {
    if (ownedId) {
      try {
        await request("DELETE", ownedId);
        check(!(await search(email)).some((row) => row.id === ownedId));
        check(!(await search(marker)).some((row) => row.id === ownedId));
        log("PASS cleanup: created ID deleted and absent from search");
      } catch {
        ok = false;
        log("FAIL cleanup: manual review of dedicated TEST_USER_EMAIL required; never delete unrelated users");
      }
    } else if (createAttempted) {
      ok = false;
      log("WARN create outcome uncertain: review dedicated TEST_USER_EMAIL manually; no ID was safe to delete");
    }
  }
  return ok;
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!(await runUserLifecycle())) process.exitCode = 1;
}
