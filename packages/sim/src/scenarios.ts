import type { ErrorType } from "@triage/logger";
import { PgPool } from "./deps.js";
import type { Rng } from "./rng.js";
import type { Deploy, ServiceName, World } from "./world.js";

export const SIM_START = Date.parse("2026-11-18T13:00:00.000Z");
export const SIM_MINUTES = 120;
export const FAULT_AT = SIM_START + 60 * 60_000; // 14:00 UTC

const min = (m: number) => SIM_START + m * 60_000;
const after = (t0: number) => (t: number) => t >= t0;

/** What actually happened. Never shown to the agent; used to score it. */
export interface GroundTruth {
  category: ErrorType;
  culpritService: ServiceName;
  /** What changed: a deploy, load, an external dependency, or config/credentials. */
  trigger: "deploy" | "traffic" | "external" | "config";
  rootCause: string;
  faultStart: string;
  /** Structured event names that are direct evidence. */
  evidenceEvents: string[];
  /** Regexes (source strings) matching evidence in either log style. */
  evidencePatterns: string[];
  /** Version string of the deploy that caused it, if any. */
  culpritDeploy?: string;
}

export interface Scenario {
  id: number;
  slug: string;
  title: string;
  /** The symptom as on-call would hear it: the question the agent is asked. */
  question: string;
  groundTruth: GroundTruth;
  apply(world: World, rng: Rng): void;
}

/** Benign deploys present in every scenario, so "blame the deploy" isn't free. */
export function backgroundDeploys(rng: Rng): Deploy[] {
  const at = (m: number) => new Date(min(m) + rng.int(0, 59) * 1000).toISOString();
  return [
    {
      ts: at(12),
      service: "scheduling",
      version: "v3.2.1",
      commit: rng.hex(7),
      description: "Update provider availability copy",
    },
    {
      ts: at(47),
      service: "billing",
      version: "v1.8.3",
      commit: rng.hex(7),
      description: "Bump payments SDK patch version",
    },
    {
      ts: at(81),
      service: "notifications",
      version: "v2.9.0",
      commit: rng.hex(7),
      description: "Add refill reminder template",
    },
  ];
}

export const SCENARIOS: Scenario[] = [
  {
    id: 1,
    slug: "pharmacy-5xx",
    title: "Pharmacy partner API returns 5xx",
    question: "Rx refills are failing since around 14:00 UTC. What's going on?",
    groundTruth: {
      category: "dependency",
      culpritService: "rx",
      trigger: "external",
      rootCause:
        "Pharmacy partner pharmacy-a started returning HTTP 503 for most requests at 14:00; refills routed to pharmacy-a fail after retries while pharmacy-b is healthy.",
      faultStart: new Date(FAULT_AT).toISOString(),
      evidenceEvents: ["rx.refill.failed", "rx.pharmacy.retrying"],
      evidencePatterns: ["pharmacy-a.*503|503.*pharmacy-a", "PHARMACY_5XX"],
    },
    apply(world) {
      world.pharmacy503Rate = (t, pharmacy) =>
        pharmacy === "pharmacy-a" && t >= FAULT_AT ? 0.9 : 0.004;
    },
  },
  {
    id: 2,
    slug: "db-pool-exhaustion",
    title: "DB connection pool exhaustion after a traffic spike",
    question:
      "Patients say appointment booking is broken since about 14:00 UTC. Can you find out why?",
    groundTruth: {
      category: "timeout",
      culpritService: "scheduling",
      trigger: "traffic",
      rootCause:
        "A marketing email at 14:00 drove a ~75x spike in intake submissions; the scheduling service's Postgres pool (2 connections, ~1.2s held per booking) was exhausted and bookings timed out acquiring connections. EventBridge retries added more load.",
      faultStart: new Date(FAULT_AT).toISOString(),
      evidenceEvents: [
        "scheduling.appointment.failed",
        "scheduling.db.pool_wait",
        "intake.form.submitted",
      ],
      evidencePatterns: [
        "DB_POOL_TIMEOUT",
        "acquiring a database connection",
        "waited for a database connection",
      ],
    },
    apply(world) {
      world.intakePerMin = (t) => (t >= FAULT_AT && t < FAULT_AT + 8 * 60_000 ? 150 : 2);
      world.pgPool = new PgPool(2, 5000);
    },
  },
  {
    id: 3,
    slug: "bad-deploy-payload",
    title: "Bad deploy renames refill payload fields",
    question: "Refills stopped going through to pharmacies around 14:00 UTC. What happened?",
    groundTruth: {
      category: "data",
      culpritService: "rx",
      trigger: "deploy",
      rootCause:
        "rx v2.4.0, deployed at 14:00, changed the refill request producer to snake_case keys (medication_id, pharmacy_id); the unchanged rx worker rejects every new message as missing medicationId, and messages end up dead-lettered.",
      faultStart: new Date(FAULT_AT).toISOString(),
      evidenceEvents: ["rx.refill.parse_failed"],
      evidencePatterns: ["PAYLOAD_SCHEMA_MISMATCH", "medicationId is required", "v2\\.4\\.0"],
      culpritDeploy: "v2.4.0",
    },
    apply(world, rng) {
      world.rxPayloadSnakeCase = after(FAULT_AT);
      world.deploys.push({
        ts: new Date(FAULT_AT).toISOString(),
        service: "rx",
        version: "v2.4.0",
        commit: rng.hex(7),
        description: "Refactor refill request payload to snake_case",
      });
    },
  },
  {
    id: 4,
    slug: "lab-token-expired",
    title: "Expired auth token for the lab-results integration",
    question: "Some refills, but not all, have been failing since about 14:00 UTC. Why?",
    groundTruth: {
      category: "auth",
      culpritService: "rx",
      trigger: "config",
      rootCause:
        "The rx service's credential for the lab-results partner (lab-partner-a) expired at 14:00; every refill that requires lab verification (isotretinoin) fails with HTTP 401, while refills that don't need labs succeed.",
      faultStart: new Date(FAULT_AT).toISOString(),
      evidenceEvents: ["rx.labs.check_failed"],
      evidencePatterns: ["LAB_AUTH_EXPIRED", "401", "rejected credentials"],
    },
    apply(world) {
      world.labTokenExpired = after(FAULT_AT);
    },
  },
  {
    id: 5,
    slug: "dynamodb-hot-partition",
    title: "DynamoDB throttling on a hot partition",
    question:
      "Refill processing got slow and some refills are failing since about 14:00 UTC. What's wrong?",
    groundTruth: {
      category: "dependency",
      culpritService: "rx",
      trigger: "traffic",
      rootCause:
        "An auto-refill batch for pharmacy-a at 14:00 enqueued 400 refills over 12 minutes; all of them write to the same rx-orders partition (pharmacy#pharmacy-a), which exceeds that partition's throughput. Writes are throttled, retried, and some fail.",
      faultStart: new Date(FAULT_AT).toISOString(),
      evidenceEvents: [
        "rx.order.write_throttled",
        "rx.order.write_failed",
        "rx.autorefill.batch_started",
      ],
      evidencePatterns: [
        "ProvisionedThroughputExceeded",
        "DDB_THROTTLED",
        "throttled",
        "pharmacy#pharmacy-a",
      ],
    },
    apply(world) {
      world.scheduledJobs.push({
        at: FAULT_AT,
        job: "autorefill",
        detail: { pharmacyId: "pharmacy-a", count: 400, spreadMinutes: 12 },
      });
    },
  },
  {
    id: 6,
    slug: "sms-silent-drop",
    title: "Notification provider silently dropping messages",
    question:
      "Several patients say they stopped getting text messages from us this afternoon. Is something broken?",
    groundTruth: {
      category: "dependency",
      culpritService: "notifications",
      trigger: "external",
      rootCause:
        "Since 14:00, sms-provider-a accepts SMS requests but never delivers them: no errors are logged, but delivery confirmations for SMS stop entirely while email deliveries continue.",
      faultStart: new Date(FAULT_AT).toISOString(),
      evidenceEvents: ["notifications.sms.accepted", "notifications.sms.delivered"],
      evidencePatterns: ["sms-provider-a", "accepted sms", "confirmed delivery"],
    },
    apply(world) {
      world.smsSilentlyDropped = after(FAULT_AT);
    },
  },
];

export function getScenario(id: number): Scenario {
  const s = SCENARIOS.find((x) => x.id === id);
  if (!s)
    throw new Error(`Unknown scenario ${id}. Valid: ${SCENARIOS.map((x) => x.id).join(", ")}`);
  return s;
}
