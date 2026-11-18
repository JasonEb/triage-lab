import { z } from "zod";
import { ERROR_TYPES, MAX_ERROR_MESSAGE_CHARS, MAX_STACK_CHARS } from "./errors.js";

/**
 * `<domain>.<entity>.<action>` with an optional 4th segment, lowercase snake_case.
 * Examples: rx.refill.failed, intake.form.submitted, billing.charge.retry_scheduled.
 * The segment cap keeps names from turning into sentences or carrying IDs.
 */
export const EVENT_NAME_PATTERN = /^[a-z][a-z0-9_]*(\.[a-z][a-z0-9_]*){2,3}$/;

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export const ENVIRONMENTS = ["local", "sim", "test", "dev", "staging", "prod"] as const;

export const MAX_MSG_CHARS = 500;
export const MAX_CTX_KEYS = 20;
export const MAX_CTX_STRING_CHARS = 200;

const id = z.string().min(1).max(128);

export const ErrorSchema = z.strictObject({
  type: z.enum(ERROR_TYPES),
  message: z.string().max(MAX_ERROR_MESSAGE_CHARS),
  stack: z.string().max(MAX_STACK_CHARS).optional(),
  code: z
    .string()
    .regex(/^[A-Z][A-Z0-9_]{0,63}$/, "error.code must be UPPER_SNAKE_CASE")
    .optional(),
});

export const CtxSchema = z
  .record(
    z.string().regex(/^[a-z][a-zA-Z0-9]{0,39}$/, "ctx keys must be camelCase"),
    z.union([z.string().max(MAX_CTX_STRING_CHARS), z.number(), z.boolean(), z.null()]),
  )
  .refine((ctx) => Object.keys(ctx).length <= MAX_CTX_KEYS, {
    message: `ctx may have at most ${MAX_CTX_KEYS} keys`,
  });

export const LogLineSchema = z.strictObject({
  ts: z.iso.datetime({ precision: 3 }),
  level: z.enum(LOG_LEVELS),
  service: z.string().regex(/^[a-z][a-z0-9-]{0,31}$/, "service must be a short kebab-case name"),
  env: z.enum(ENVIRONMENTS),
  event: z.string().regex(EVENT_NAME_PATTERN, "event must look like domain.entity.action"),
  msg: z.string().max(MAX_MSG_CHARS),
  requestId: id,
  correlationId: id,
  durationMs: z.number().int().nonnegative().optional(),
  patientIdHash: z
    .string()
    .regex(/^[0-9a-f]{16,64}$/, "patientIdHash must be a hex digest, never a raw id")
    .optional(),
  error: ErrorSchema.optional(),
  ctx: CtxSchema.optional(),
});

export type LogLine = z.infer<typeof LogLineSchema>;
export type LogLevel = (typeof LOG_LEVELS)[number];
export type Environment = (typeof ENVIRONMENTS)[number];
export type Ctx = z.infer<typeof CtxSchema>;
