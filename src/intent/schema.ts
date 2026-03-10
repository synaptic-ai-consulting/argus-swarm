import { z } from "zod";

export const TrustThresholdsSchema = z.object({
  autoApprove: z.number().min(0).max(1).default(0.85),
  escalate: z.number().min(0).max(1).default(0.6),
  block: z.number().min(0).max(1).default(0.4),
});

export const IntentSchema = z.object({
  intent: z.string().min(1),
  constraints: z.array(z.string()).default([]),
  trustThresholds: TrustThresholdsSchema.optional().default({
    autoApprove: 0.85,
    escalate: 0.6,
    block: 0.4,
  }),
});

export type Intent = z.infer<typeof IntentSchema>;
export type TrustThresholds = z.infer<typeof TrustThresholdsSchema>;
