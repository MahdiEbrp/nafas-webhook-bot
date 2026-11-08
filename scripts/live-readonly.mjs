import { randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";

const MODEL = "liquid/lfm-3-1.7b:free";

// Deliberately separate from the app clients: never log upstream error text,
// credentials, URLs, completion text, or user records, even on failures.
export async function runLiveChecks({ env = process.env, fetchImpl = fetch, log = console.log } = {}) {
  let failed = false;
  const report = (name, ok, detail) => {
    if (!ok) failed = true;
    log(`${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  const required = ["WEBHOOK_BASE_URL", "WEBHOOK_USERNAME", "WEBHOOK_PASSWORD", "OPENROUTER_API_KEY"];
  if (required.some((key) => !env[key]?.trim())) {
    report("configuration", false, "required secrets missing; see docs/LIVE_TESTS.fa.md");
    return false;
  }
  let base;
  try {
    base = new URL(env.WEBHOOK_BASE_URL);
    if (base.protocol !== "https:" || base.username || base.password || base.search || base.hash || !["", "/"].includes(base.pathname)) throw new Error();
  } catch {
    report("configuration", false, "WEBHOOK_BASE_URL must be an HTTPS origin without credentials, path, query or fragment");
    return false;
  }
  const authorization = `Basic ${Buffer.from(`${env.WEBHOOK_USERNAME}:${env.WEBHOOK_PASSWORD}`).toString("base64")}`;
  async function request(name, url, init, validate) {
    try {
      const response = await fetchImpl(url, {
        ...init,
        redirect: "error", // Never forward credentials to a redirected host.
        signal: AbortSignal.timeout(45_000),
      });
      if (!response.ok) {
        report(name, false, `HTTP ${response.status}`);
        return;
      }
      const payload = await response.json();
      const ok = validate(payload);
      report(name, ok, ok ? `HTTP ${response.status}; response shape verified` : `HTTP ${response.status}; unexpected response shape/content`);
    } catch {
      // Errors can contain URLs, bodies and derived credentials. Do not print them.
      report(name, false, "network, TLS, timeout, redirect or invalid JSON error (details suppressed)");
    }
  }
  const rows = (payload) => {
    // Match the app client: upstream wraps successes in { ok: true, data: ... },
    // and the data itself can be a paginated { items/rows/data: [] } object.
    // Only unwrap known data envelopes, never recursively scan arbitrary fields
    // (an error payload may itself contain unrelated arrays).
    for (let depth = 0; depth < 4; depth++) {
      if (Array.isArray(payload)) return payload;
      if (!payload || typeof payload !== "object" || payload.ok === false || payload.success === false || payload.error) return null;
      for (const key of ["items", "rows"]) {
        if (Array.isArray(payload[key])) return payload[key];
      }
      payload = payload.data;
    }
    return Array.isArray(payload) ? payload : null;
  };
  const listUrl = new URL("/api/v1/webhooks/users", base);
  listUrl.searchParams.set("perPage", "1");
  listUrl.searchParams.set("page", "1");
  const readInit = { method: "GET", headers: { Authorization: authorization, Accept: "application/json" } };
  await request("users list / users.read", listUrl, readInit, (payload) => rows(payload) !== null);

  // Synthetic search only: no staff name is sent to GitHub or OpenRouter.
  // Empty results suggest the filter is honored, but do not prove name matching.
  const searchUrl = new URL(listUrl);
  searchUrl.searchParams.set("search", `nafas-live-probe-${randomUUID()}`);
  await request("synthetic search (expect no match)", searchUrl, readInit, (payload) => rows(payload)?.length === 0);

  await request("Liquid JSON completion", "https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: { Authorization: `Bearer ${env.OPENROUTER_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: MODEL,
      messages: [{ role: "user", content: 'Return only a JSON object with one field: "ok" set to true.' }],
      response_format: { type: "json_object" },
      temperature: 0.1,
      max_tokens: 128,
    }),
  }, (payload) => {
    const text = payload?.choices?.[0]?.message?.content;
    if (typeof text !== "string") return false;
    try { return JSON.parse(text)?.ok === true; } catch { return false; }
  });
  return !failed;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (!(await runLiveChecks())) process.exitCode = 1;
}
