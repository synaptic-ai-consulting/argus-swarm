import { parse } from "yaml";

const DEFAULT_THETA = 0.85;

export interface ParsedIntentPreview {
  intent: string;
  constraints: string[];
  /** Resolved θ (paper Layer 3 gate). */
  reviewThreshold: number;
  /** If the file still uses the legacy triple, surfaced for reference only. */
  legacyEscalate?: number;
  legacyBlock?: number;
}

/**
 * Parse intent YAML for read-only preview (same resolution order as `resolveReviewThreshold` on the server).
 */
export function parseIntentYamlContent(content: string): ParsedIntentPreview | null {
  try {
    const doc = parse(content) as Record<string, unknown>;
    if (!doc || typeof doc !== "object") return null;
    const intent = typeof doc.intent === "string" ? doc.intent : "";
    const constraints = Array.isArray(doc.constraints)
      ? (doc.constraints as unknown[]).filter((c): c is string => typeof c === "string")
      : [];

    let reviewThreshold = DEFAULT_THETA;
    if (typeof doc.reviewThreshold === "number") reviewThreshold = doc.reviewThreshold;
    else if (typeof doc.review_threshold === "number") reviewThreshold = doc.review_threshold;
    else {
      const cg = doc.confidenceGate ?? doc.confidence_gate;
      if (cg && typeof cg === "object" && !Array.isArray(cg)) {
        const g = cg as Record<string, unknown>;
        const rt = g.reviewThreshold ?? g.review_threshold;
        if (typeof rt === "number") reviewThreshold = rt;
      }
    }
    const th = (doc.trustThresholds ?? doc.trust_thresholds) as Record<string, unknown> | undefined;
    if (typeof th?.autoApprove === "number") {
      if (!doc.reviewThreshold && !doc.review_threshold && !doc.confidenceGate && !doc.confidence_gate) {
        reviewThreshold = th.autoApprove;
      }
    }
    if (typeof th?.auto_approve === "number") {
      if (!doc.reviewThreshold && !doc.review_threshold && !doc.confidenceGate && !doc.confidence_gate) {
        reviewThreshold = th.auto_approve as number;
      }
    }

    let legacyEscalate: number | undefined;
    let legacyBlock: number | undefined;
    if (th) {
      const es = th.escalate;
      const bl = th.block;
      if (typeof es === "number") legacyEscalate = es;
      if (typeof bl === "number") legacyBlock = bl;
    }

    return { intent, constraints, reviewThreshold, legacyEscalate, legacyBlock };
  } catch {
    return null;
  }
}
