#!/usr/bin/env node
/**
 * Mock of the existing clinic project's /api/v1/webhooks/* API.
 *
 * Why: you can develop and demo the bot without the real backend, and the
 * self-tests can prove "the bot really sends the right HTTP request".
 *
 *   node mock/webhooks-mock.mjs          # http://127.0.0.1:4010
 *
 * It copies the real behaviour: Basic auth, permission checks, the
 * { ok, data } / { ok, error: { code, message } } envelope, x-request-id,
 * zod-ish validation for the fields the bot fills.
 */

import { createServer } from "node:http";
import { randomUUID } from "node:crypto";

const PORT = Number(process.env.MOCK_PORT || 4010);
const USER = process.env.MOCK_USER || "bot@clinic.test";
const PASS = process.env.MOCK_PASS || "MockPass1!";

const PERMISSIONS = [
  "appointments.read", "appointments.write", "appointments.manage",
  "services.read", "services.write", "services.manage",
  "users.read", "users.write", "users.manage",
  "settings.read", "settings.write", "settings.manage",
  "rules.read", "rules.write", "rules.manage",
  "care-guides.read", "care-guides.write", "care-guides.manage",
];

/** @type {Record<string, any[]>} */
const db = {
  bookings: [
    { id: "11111111-1111-4111-8111-111111111111", fullName: "مریم رضایی", phone: "09121234567", status: "paid", notes: null, createdAt: new Date().toISOString() },
    { id: "22222222-2222-4222-8222-222222222222", fullName: "علی محمدی", phone: "09351112233", status: "pending", notes: "حساسیت پوستی", createdAt: new Date().toISOString() },
    { id: "33333333-3333-4333-8333-333333333333", fullName: "سارا کریمی", phone: "09190001122", status: "done", notes: null, createdAt: new Date().toISOString() },
  ],
  "working-hours": [
    { id: "44444444-4444-4444-8444-444444444444", day: "Saturday", opens: "09:00", closes: "18:00", capacity: 4, isActive: true },
    { id: "55555555-5555-4555-8555-555555555555", day: "Monday", opens: "10:00", closes: "16:00", capacity: 2, isActive: true },
  ],
  services: [
    { id: "66666666-6666-4666-8666-666666666666", slug: "laser-hair", price: 2000000, priceType: "fixed", isActive: true, isFeatured: true, translations: { fa: { title: "لیزر مو" } } },
    { id: "77777777-7777-4777-8777-777777777777", slug: "skin-cleaning", price: 850000, priceType: "from", isActive: true, isFeatured: false, translations: { fa: { title: "پاکسازی پوست" } } },
  ],
  "service-categories": [
    { id: "88888888-8888-4888-8888-888888888888", slug: "skin", isActive: true, translations: { fa: { name: "پوست" } } },
  ],
  "service-groups": [
    { id: "99999999-9999-4999-8999-999999999999", slug: "beauty", isActive: true, translations: { fa: { name: "زیبایی" } } },
  ],
  users: [
    // عمداً با فرمت‌های مختلف ذخیره شده‌اند — مثل یک دیتابیس واقعی
    { id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa", fullName: "دکتر نازنین", email: "admin@clinic.test", phone: "09120000001", isActive: true, isBanned: false, roleKey: "admin" },
    { id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb", fullName: "منشی با فرمت +98", email: "reception@clinic.test", phone: "+989120000002", isActive: true, isBanned: false, roleKey: "receptionist" },
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", fullName: "کارمند با فاصله", email: "spaced@clinic.test", phone: "0912 000 0003", isActive: true, isBanned: false, roleKey: "staff" },
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", fullName: "حساب غیرفعال", email: "off@clinic.test", phone: "09120000004", isActive: false, isBanned: false, roleKey: "staff" },
  ],
  settings: [
    { id: "cccccccc-cccc-4ccc-8ccc-cccccccccccc", key: "site_phone", value: "02188889999", type: "string", isActive: true },
  ],
  rules: [
    { id: "dddddddd-dddd-4ddd-8ddd-dddddddddddd", slug: "arrive-early", highlighted: true, isActive: true, translations: { fa: { name: "۱۵ دقیقه قبل بیایید" } } },
  ],
  "care-guides": [
    { id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", slug: "after-laser", isActive: true, translations: { fa: { name: "مراقبت بعد از لیزر" } } },
  ],
  "care-guide-items": [
    { id: "ffffffff-ffff-4fff-8fff-ffffffffffff", guideId: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee", highlighted: false, isActive: true, translations: { fa: { title: "۲۴ ساعت ورزش نکنید" } } },
  ],
};

const RESOURCE_PERMISSION_PREFIX = {
  bookings: "appointments",
  "working-hours": "appointments",
  services: "services",
  "service-categories": "services",
  "service-groups": "services",
  users: "users",
  settings: "settings",
  rules: "rules",
  "care-guides": "care-guides",
  "care-guide-items": "care-guides",
};

function send(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "x-request-id": payload.requestId || randomUUID(),
  });
  res.end(body);
}

const okSend = (res, data, status = 200) => send(res, status, { ok: true, data });
const errSend = (res, status, code, message) => send(res, status, { ok: false, error: { code, message } });

function isAuthorized(req) {
  const header = req.headers.authorization || "";
  if (!header.startsWith("Basic ")) return false;
  const decoded = Buffer.from(header.slice(6), "base64").toString("utf-8");
  const index = decoded.indexOf(":");
  if (index <= 0) return false;
  return decoded.slice(0, index) === USER && decoded.slice(index + 1) === PASS;
}

function paginate(items, url) {
  const page = Math.max(1, Number(url.searchParams.get("page") || 1));
  const perPage = Math.min(100, Math.max(1, Number(url.searchParams.get("perPage") || 20)));
  const search = (url.searchParams.get("search") || "").toLowerCase();
  const status = url.searchParams.get("status") || "all";

  let rows = items;
  if (search) rows = rows.filter((row) => JSON.stringify(row).toLowerCase().includes(search));
  if (status !== "all") rows = rows.filter((row) => row.status === status || (status === "active" && row.isActive));

  return {
    items: rows.slice((page - 1) * perPage, page * perPage),
    total: rows.length,
    page,
    perPage,
  };
}

function validate(resource, body, isCreate) {
  if (!body || typeof body !== "object") return "Request body must be JSON object.";
  if (resource === "bookings" && isCreate) {
    if (!body.fullName || String(body.fullName).trim().length < 2) return "fullName is required (min 2).";
    if (!/^[0-9+][0-9\s()-]{6,19}$/.test(String(body.phone || ""))) return "phone is invalid.";
    if (body.termsAccepted !== true) return "termsAccepted must be true.";
    if (!Array.isArray(body.items) || body.items.length === 0) return "items must have at least one entry.";
    return null;
  }
  if (resource === "working-hours" && isCreate) {
    if (!body.day) return "day is required.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.opens || "")) return "opens must be HH:MM.";
    if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(body.closes || "")) return "closes must be HH:MM.";
    if (body.closes <= body.opens) return "closes must be after opens.";
    return null;
  }
  if (resource === "services" && isCreate) {
    if (!body.categoryId) return "categoryId is required.";
    if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(body.slug || "")) return "slug must be kebab-case.";
    return null;
  }
  if (resource === "users" && isCreate) {
    if (!/^\+?[0-9]{7,15}$/.test(body.phone || "")) return "phone is invalid.";
    if (!body.password || String(body.password).length < 8) return "password must be at least 8 chars.";
    if (!body.roleKey) return "roleKey is required.";
    return null;
  }
  return null;
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);

  if (url.pathname === "/__ping") return okSend(res, { pong: true });

  const match = url.pathname.match(/^\/api\/v1\/webhooks\/([a-z-]+)(?:\/([^/]+))?$/);
  if (!match) return errSend(res, 404, "NOT_FOUND", "Route not found.");

  if (!isAuthorized(req)) {
    return errSend(res, 401, "MISSING_AUTH", "Authorization header with Basic credentials is required.");
  }

  const [, resource, id] = match;
  const collection = db[resource];
  if (!collection) return errSend(res, 404, "NOT_FOUND", `Unknown resource: ${resource}`);

  const prefix = RESOURCE_PERMISSION_PREFIX[resource];
  const permissionFor = (method) => {
    if (method === "GET") return `${prefix}.read`;
    if (method === "DELETE") return `${prefix}.manage`;
    return `${prefix}.write`;
  };
  const permission = permissionFor(req.method);
  if (!PERMISSIONS.includes(permission)) {
    return errSend(res, 403, "FORBIDDEN", `Missing permission: ${permission}`);
  }

  if (req.method === "GET" && !id) return okSend(res, paginate(collection, url));

  if (req.method === "GET" && id) {
    const found = collection.find((row) => row.id === id);
    return found ? okSend(res, found) : errSend(res, 404, "NOT_FOUND", "Record not found.");
  }

  // Read JSON body
  let raw = "";
  for await (const chunk of req) raw += chunk;
  let body = null;
  if (raw) {
    try {
      body = JSON.parse(raw);
    } catch {
      return errSend(res, 400, "INVALID_JSON", "Request body must be valid JSON.");
    }
  }

  if (req.method === "POST") {
    const problem = validate(resource, body, true);
    if (problem) return errSend(res, 400, "VALIDATION_ERROR", problem);
    const row = { id: randomUUID(), createdAt: new Date().toISOString(), ...body };
    if (resource === "bookings") row.groupRef = `NF-${Math.floor(Math.random() * 90000) + 10000}`;
    collection.push(row);
    return okSend(res, row, 201);
  }

  if (req.method === "PATCH") {
    const index = collection.findIndex((row) => row.id === id);
    if (index === -1) return errSend(res, 404, "NOT_FOUND", "Record not found.");
    const problem = validate(resource, body, false);
    if (problem) return errSend(res, 400, "VALIDATION_ERROR", problem);
    collection[index] = { ...collection[index], ...body };
    return okSend(res, collection[index]);
  }

  if (req.method === "DELETE") {
    const index = collection.findIndex((row) => row.id === id);
    if (index === -1) return errSend(res, 404, "NOT_FOUND", "Record not found.");
    const [removed] = collection.splice(index, 1);
    return okSend(res, { deleted: true, id: removed.id });
  }

  return errSend(res, 405, "METHOD_NOT_ALLOWED", "Method not allowed.");
});

server.listen(PORT, "0.0.0.0", () => {
  console.log(`[mock] clinic webhook API on http://127.0.0.1:${PORT}`);
  console.log(`[mock] basic auth → ${USER} : ${PASS}`);
  console.log(`[mock] try: curl -u ${USER}:${PASS} http://127.0.0.1:${PORT}/api/v1/webhooks/bookings`);
});
