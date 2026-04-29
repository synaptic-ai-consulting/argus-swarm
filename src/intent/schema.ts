import { z } from "zod";

/** Default θ — auto-approve iff validator confidence ≥ reviewThreshold (paper Layer 3). */
export const DEFAULT_REVIEW_THRESHOLD = 0.85;

/** @deprecated Legacy triple from early PoC; autoApprove is read as θ when reviewThreshold is absent. */
const DeprecatedTrustBandsSchema = z
  .object({
    autoApprove: z.number().min(0).max(1).optional(),
    escalate: z.number().min(0).max(1).optional(),
    block: z.number().min(0).max(1).optional(),
  })
  .optional();

export const ConfidenceGateSchema = z.object({
  reviewThreshold: z.number().min(0).max(1),
});

export const IntentSchema = z.object({
  intent: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  /** Paper θ — single gate: confidence ≥ reviewThreshold ⇒ auto_approve. */
  reviewThreshold: z.number().min(0).max(1).optional(),
  /** Nested: `confidenceGate: { reviewThreshold: 0.85 }` */
  confidenceGate: ConfidenceGateSchema.optional(),
  trustThresholds: DeprecatedTrustBandsSchema,
});

export type Intent = z.infer<typeof IntentSchema>;

/** Resolved θ for validation (not trust τ). */
export function resolveReviewThreshold(intent: Intent): number {
  if (intent.reviewThreshold != null) return intent.reviewThreshold;
  const nested = intent.confidenceGate?.reviewThreshold;
  if (nested != null) return nested;
  const legacy = intent.trustThresholds?.autoApprove;
  if (legacy != null) return legacy;
  return DEFAULT_REVIEW_THRESHOLD;
}
