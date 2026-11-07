/**
 * The contract between the AI and the code.
 *
 * The model is *never* trusted to call an endpoint directly; it can only return
 * one of these plans. Everything else (auth, URL, permissions, confirmation) is
 * enforced here in code.
 */

import { z } from "zod";

import { getAction } from "@/lib/features/manifest";

export const INTENTS = ["read", "write", "delete", "features", "smalltalk", "out_of_scope"] as const;
export type Intent = (typeof INTENTS)[number];

export const planSchema = z.object({
  intent: z.enum(INTENTS).catch("out_of_scope"),
  actionId: z.string().trim().max(80).nullable().optional().default(null),
  params: z.record(z.string(), z.unknown()).optional().default({}),
  missing: z.array(z.string().trim().max(60)).optional().default([]),
  understood: z.string().trim().max(400).optional().default(""),
  reply: z.string().trim().max(1200).optional().default(""),
  confidence: z.coerce.number().min(0).max(1).optional().default(0.5),
});

export type Plan = z.infer<typeof planSchema>;

export type ValidatedPlan = Plan & {
  /** true when actionId exists in the manifest AND matches the intent's danger */
  actionValid: boolean;
  /** set when the model named an action we do not have */
  invalidActionId: string | null;
  source: "model" | "router" | "merged";
};

/**
 * Cross-checks the model's plan against the manifest.
 * Small free models sometimes return `services.delete` with intent `read`, or a
 * made-up id — both are caught here instead of producing a weird HTTP call.
 */
export function validatePlan(plan: Plan, source: ValidatedPlan["source"] = "model"): ValidatedPlan {
  const actionId = plan.actionId ?? null;

  if (!actionId) {
    return { ...plan, actionValid: false, invalidActionId: null, source };
  }

  const found = getAction(actionId);
  if (!found) {
    return { ...plan, actionValid: false, invalidActionId: actionId, source };
  }

  const dangerMatches =
    (plan.intent === "read" && found.action.danger === "read") ||
    (plan.intent === "write" && found.action.danger === "write") ||
    (plan.intent === "delete" && found.action.danger === "destructive");

  return { ...plan, actionValid: dangerMatches, invalidActionId: null, source };
}

export function emptyPlan(intent: Intent = "out_of_scope"): Plan {
  return { intent, actionId: null, params: {}, missing: [], understood: "", reply: "", confidence: 0 };
}
