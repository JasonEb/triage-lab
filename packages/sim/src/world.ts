import { PgPool } from "./deps.js";
import type { PharmacyId } from "./catalog.js";

export const SERVICES = ["intake", "rx", "scheduling", "billing", "notifications"] as const;
export type ServiceName = (typeof SERVICES)[number];

export interface Deploy {
  ts: string;
  service: ServiceName;
  version: string;
  commit: string;
  description: string;
}

/**
 * Everything a scenario can change. Defaults describe a healthy platform with
 * a little realistic noise; scenarios override one or two knobs.
 */
export interface World {
  start: number;
  end: number;
  /** Arrival rates (per minute) as functions of virtual time. */
  intakePerMin: (t: number) => number;
  refillPerMin: (t: number) => number;
  /** Probability a pharmacy call returns 503. */
  pharmacy503Rate: (t: number, pharmacy: PharmacyId) => number;
  labTokenExpired: (t: number) => boolean;
  /** Behavior shipped by an rx deploy: the producer writes snake_case keys. */
  rxPayloadSnakeCase: (t: number) => boolean;
  /** SMS provider accepts messages but never delivers them. */
  smsSilentlyDropped: (t: number) => boolean;
  pgPool: PgPool;
  /** DynamoDB per-partition write capacity (scaled down with the traffic). */
  ordersPartition: { ratePerSec: number; burst: number };
  /** Scheduled jobs: EventBridge "Scheduled Event"s at fixed times. */
  scheduledJobs: { at: number; job: string; detail: Record<string, string | number> }[];
  deploys: Deploy[];
}

export function baselineWorld(start: number, end: number): World {
  return {
    start,
    end,
    intakePerMin: () => 2,
    refillPerMin: () => 3,
    pharmacy503Rate: () => 0.004,
    labTokenExpired: () => false,
    rxPayloadSnakeCase: () => false,
    smsSilentlyDropped: () => false,
    pgPool: new PgPool(2, 5000),
    ordersPartition: { ratePerSec: 0.5, burst: 5 },
    scheduledJobs: [],
    deploys: [],
  };
}
