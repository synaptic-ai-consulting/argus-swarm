import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse as parseYaml } from "yaml";
import { IntentSchema, type Intent } from "./schema.js";

/** Map common snake_case YAML aliases to the Zod schema (camelCase). */
function normalizeIntentKeys(raw: unknown): unknown {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return raw;
  const o = { ...(raw as Record<string, unknown>) };

  if (o.review_threshold != null && o.reviewThreshold == null) {
    o.reviewThreshold = o.review_threshold;
  }
  if (o.trust_thresholds != null && o.trustThresholds == null) {
    o.trustThresholds = o.trust_thresholds;
  }
  if (o.confidence_gate != null && o.confidenceGate == null) {
    o.confidenceGate = o.confidence_gate;
  }
  if (o.confidenceGate != null && typeof o.confidenceGate === "object" && !Array.isArray(o.confidenceGate)) {
    const cg = { ...(o.confidenceGate as Record<string, unknown>) };
    if (cg.review_threshold != null && cg.reviewThreshold == null) {
      cg.reviewThreshold = cg.review_threshold;
    }
    o.confidenceGate = cg;
  }
  if (o.trustThresholds != null && typeof o.trustThresholds === "object" && !Array.isArray(o.trustThresholds)) {
    const th = { ...(o.trustThresholds as Record<string, unknown>) };
    if (th.auto_approve != null && th.autoApprove == null) th.autoApprove = th.auto_approve;
    o.trustThresholds = th;
  }
  return o;
}

export function loadIntent(path: string): Intent {
  const fullPath = resolve(process.cwd(), path);
  const content = readFileSync(fullPath, "utf-8");
  const raw = parseYaml(content);
  return IntentSchema.parse(normalizeIntentKeys(raw));
}
