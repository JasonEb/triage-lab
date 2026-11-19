import { ERROR_TYPES } from "@triage/logger";
import { z } from "zod";

export const ROOT_CAUSE_CATEGORIES = [...ERROR_TYPES, "insufficient_data"] as const;

/**
 * Where a diagnosis can place the fault: one of our services, or "" if unknown.
 * A bounded value (like an event name) so answers can be compared and scored;
 * external partners and dependencies are named in the free-text description.
 */
export const PLATFORM_SERVICES = [
  "intake",
  "rx",
  "scheduling",
  "billing",
  "notifications",
] as const;

/** The agent's final answer. Submitted through the submit_diagnosis tool. */
export const DiagnosisSchema = z.strictObject({
  summary: z.string().min(1),
  suspectedRootCause: z.strictObject({
    category: z.enum(ROOT_CAUSE_CATEGORIES),
    /** Our service where the fault originates or surfaces, or "" if unknown. */
    service: z.enum([...PLATFORM_SERVICES, ""]),
    description: z.string(),
  }),
  evidence: z.array(z.strictObject({ lineId: z.number().int(), reason: z.string() })),
  confidence: z.enum(["low", "medium", "high"]),
  suggestedNextSteps: z.array(z.string()),
  /** Runbook topic that applies, or "" if none. */
  runbook: z.string(),
});

export type Diagnosis = z.infer<typeof DiagnosisSchema>;

/** JSON Schema for the strict submit_diagnosis tool (mirrors DiagnosisSchema). */
export const DIAGNOSIS_JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: [
    "summary",
    "suspectedRootCause",
    "evidence",
    "confidence",
    "suggestedNextSteps",
    "runbook",
  ],
  properties: {
    summary: { type: "string", description: "Two to four sentences for the on-call engineer." },
    suspectedRootCause: {
      type: "object",
      additionalProperties: false,
      required: ["category", "service", "description"],
      properties: {
        category: {
          type: "string",
          enum: [...ROOT_CAUSE_CATEGORIES],
          description: "Error taxonomy type of the root cause, or insufficient_data.",
        },
        service: {
          type: "string",
          enum: [...PLATFORM_SERVICES, ""],
          description:
            'Our service where the fault originates or first surfaces, or "" if unknown. Name an external partner or dependency in description, not here.',
        },
        description: { type: "string", description: "What broke, where, since when, and why." },
      },
    },
    evidence: {
      type: "array",
      description:
        "Log lines that support the diagnosis. Cite only line IDs returned by your tools.",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["lineId", "reason"],
        properties: {
          lineId: { type: "integer" },
          reason: { type: "string", description: "What this line shows." },
        },
      },
    },
    confidence: { type: "string", enum: ["low", "medium", "high"] },
    suggestedNextSteps: { type: "array", items: { type: "string" } },
    runbook: { type: "string", description: 'Runbook topic that applies, or "".' },
  },
} as const;

/** What the agent returns when it could not reach a diagnosis. */
export function insufficientData(reason: string): Diagnosis {
  return {
    summary: `No diagnosis: ${reason}`,
    suspectedRootCause: { category: "insufficient_data", service: "", description: reason },
    evidence: [],
    confidence: "low",
    suggestedNextSteps: ["Investigate manually; the agent did not reach a conclusion."],
    runbook: "",
  };
}
