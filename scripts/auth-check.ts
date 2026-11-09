import { randomUUID } from "node:crypto";
import { loadEnvConfig } from "@next/env";

import { EncryptedAuthSessionStore } from "@/lib/auth/session-store";
import { EncryptedOtpLoginFlowStore } from "@/lib/auth/login-flow-store";
import { dbConfigured, getRunner } from "@/lib/db/client";
import { ensureSchema, resetSchemaCache } from "@/lib/db/schema";

// Load .env.local like Next.js, so this script also works after `vercel env pull`.
loadEnvConfig(process.cwd());

function hasValidEncryptionKey(value: string | undefined): boolean {
  const key = value?.trim();
  if (!key) return false;
  if (/^[0-9a-f]{64}$/iu.test(key)) return true;
  return Buffer.from(key, "base64").length === 32;
}

function report(label: string, ok: boolean): void {
  console.log(`${ok ? "✅" : "❌"} ${label}`);
  if (!ok) process.exitCode = 1;
}

async function main(): Promise<void> {
  console.log("\n🔐 OTP auth storage diagnostics (secret values are never printed)\n");

  const databasePresent = dbConfigured();
  const keyValid = hasValidEncryptionKey(process.env.AUTH_SESSION_ENCRYPTION_KEY);
  report("DATABASE_URL is configured", databasePresent);
  report("AUTH_SESSION_ENCRYPTION_KEY is a valid 32-byte key", keyValid);
  if (!databasePresent || !keyValid) return;

  const run = getRunner();
  if (!run) {
    report("Postgres runner was created", false);
    return;
  }

  try {
    await run("select 1 as ok");
    report("Database connection succeeded", true);
  } catch {
    report("Database connection succeeded", false);
    return;
  }

  resetSchemaCache();
  const schemaReady = await ensureSchema(run);
  report("Required database schema can be created", schemaReady);
  if (!schemaReady) return;

  const diagnosticId = `auth-check-${randomUUID()}`;
  const actorId = `diagnostic-actor-${randomUUID()}`;
  const now = Date.now();
  const sessions = new EncryptedAuthSessionStore({ maxAgeMs: 30_000 });
  let sessionSaved = false;
  try {
    sessionSaved = await sessions.save({
      actorId,
      lookupId: diagnosticId,
      sessionCookie: "diagnostic-cookie-not-valid-upstream",
      csrfToken: "diagnostic-csrf-not-valid-upstream",
      expiresAt: now + 30_000,
    });
    const restored = sessionSaved ? await sessions.get(diagnosticId) : null;
    report(
      "Encrypted auth session can be written and read back",
      Boolean(restored?.actorId === actorId
        && restored.sessionCookie === "diagnostic-cookie-not-valid-upstream"
        && restored.csrfToken === "diagnostic-csrf-not-valid-upstream"),
    );
  } catch {
    report("Encrypted auth session can be written and read back", false);
  } finally {
    if (sessionSaved) await sessions.delete(diagnosticId);
  }

  const flowId = `auth-check-flow-${randomUUID()}`;
  const flows = new EncryptedOtpLoginFlowStore({ maxAgeMs: 30_000 });
  let flowSaved = false;
  try {
    flowSaved = await flows.save(flowId, {
      step: "code",
      phone: "+10000000000",
      expiresAt: now + 30_000,
    });
    const restored = flowSaved ? await flows.get(flowId) : null;
    report(
      "Encrypted pending-login flow can be written and read back",
      restored?.step === "code" && restored.phone === "+10000000000",
    );
  } catch {
    report("Encrypted pending-login flow can be written and read back", false);
  } finally {
    if (flowSaved) await flows.delete(flowId);
  }

  if (process.exitCode) {
    console.log("\nOne or more checks failed. This script intentionally does not print credentials or raw database errors.");
  } else {
    console.log("\n🎉 Encrypted OTP persistence checks passed; temporary test rows were deleted.");
  }
}

main().catch(() => {
  console.error("\n❌ Auth storage diagnostic failed unexpectedly (details omitted to avoid leaking secrets).");
  process.exitCode = 1;
});
