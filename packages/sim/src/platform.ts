import { withLogging, type LoggedContext } from "@triage/logger";
import { correlationHeaders, eventBridgeDetail } from "@triage/logger";
import { MEDICATIONS, PHARMACIES, type Patient, type PharmacyId } from "./catalog.js";
import { simError, TokenBucket } from "./deps.js";
import type { Recorder } from "./recorder.js";
import type { LambdaHandler, SimRuntime } from "./runtime.js";
import type { World } from "./world.js";

type Ctx = LoggedContext;
const json = (event: unknown): Record<string, unknown> => {
  const body = (event as { body?: string | null }).body;
  return body ? (JSON.parse(body) as Record<string, unknown>) : {};
};
const detailOf = (event: unknown) => (event as { detail: Record<string, unknown> }).detail;
const sqsBody = (event: unknown) =>
  JSON.parse((event as { Records: { body: string }[] }).Records[0]!.body) as Record<
    string,
    unknown
  >;

/**
 * The five fake services, wired to the runtime. Each handler is a plain
 * Lambda-style function wrapped in withLogging; everything they log goes to
 * the Recorder. Business logic is deliberately thin: just enough steps,
 * latency and failure modes to produce realistic incidents.
 */
export function buildPlatform(
  sim: SimRuntime,
  recorder: Recorder,
  world: World,
  patients: Patient[],
) {
  const wrap = (
    service: string,
    fn: (event: unknown, ctx: Ctx) => Promise<unknown>,
  ): LambdaHandler =>
    withLogging<unknown, unknown>(recorder.logger(service), fn, {
      clock: () => sim.now,
      newId: () => sim.rng.uuid(),
    }) as LambdaHandler;

  const rng = sim.rng;
  const lat = (median: number, sigma = 0.4) => rng.lognormal(median, sigma);
  const partitions = new Map<string, TokenBucket>();
  const patientById = new Map(patients.map((p) => [p.id, p]));

  /* ------------------------------ intake ------------------------------ */

  const submitIntake = wrap("intake", async (event, { log, correlationId }) => {
    const body = json(event);
    const patientId = String(body.patientId);
    sim.sleep(lat(30));
    if (body.complete === false) {
      log.warn("intake.form.rejected", "Intake form rejected: required field missing", {
        patientId,
        ctx: {
          field: rng.pick(["allergies", "photos", "currentMedications"]),
          channel: String(body.channel),
        },
      });
      return { statusCode: 400 };
    }
    sim.sleep(lat(45));
    log.info("intake.form.submitted", "Intake form submitted", {
      patientId,
      ctx: { channel: String(body.channel), formVersion: "v3" },
    });
    sim.putEvent(
      "honeydew.intake",
      "IntakeSubmitted",
      eventBridgeDetail({ patientId }, correlationId),
    );
    return { statusCode: 201 };
  });

  /* ---------------------------- scheduling ---------------------------- */

  const bookAppointment = wrap("scheduling", async (event, { log, correlationId }) => {
    const { patientId } = detailOf(event) as { patientId: string };
    const hold = lat(1200, 0.35);
    const pool = world.pgPool;
    const { waitMs, timedOut } = pool.acquire(sim.now, hold);
    if (timedOut) {
      sim.sleep(waitMs);
      const error = simError(
        "timeout",
        `Timed out acquiring a database connection after ${pool.timeoutMs}ms`,
        {
          code: "DB_POOL_TIMEOUT",
          frames: [
            "Pool.connect (node_modules/pg-pool/index.js:45:11)",
            "bookAppointment (scheduling/book.js:22:18)",
          ],
        },
      );
      log.error("scheduling.appointment.failed", "Could not book appointment", {
        patientId,
        error,
        ctx: { poolSize: pool.size, waitMs: Math.round(waitMs) },
      });
      throw error;
    }
    if (waitMs > 1000) {
      log.warn("scheduling.db.pool_wait", "Waited for a database connection", {
        durationMs: waitMs,
        ctx: { poolSize: pool.size },
      });
    }
    sim.sleep(waitMs + hold);
    const visitType = rng.chance(0.6) ? "async" : "video";
    log.info("scheduling.appointment.booked", "Appointment booked", {
      patientId,
      ctx: { visitType },
    });
    sim.putEvent(
      "honeydew.scheduling",
      "AppointmentBooked",
      eventBridgeDetail(
        { patientId, template: "appointment_confirmation", kind: "visit" },
        correlationId,
      ),
    );
  });

  /* ------------------------------- rx -------------------------------- */

  const requestRefill = wrap("rx", async (event, { log, correlationId }) => {
    const body = json(event);
    const patientId = String(body.patientId);
    const pharmacy = String(body.pharmacyId);
    sim.sleep(lat(25));
    if (body.hasActiveRx === false) {
      log.warn("rx.refill.rejected", "Refill request rejected: no active prescription", {
        patientId,
        ctx: { reason: "no_active_rx" },
      });
      return { statusCode: 422 };
    }
    const payload = world.rxPayloadSnakeCase(sim.now)
      ? {
          patient_id: patientId,
          medication_id: body.medicationId,
          pharmacy_id: pharmacy,
          requires_labs: body.requiresLabs,
        }
      : {
          patientId,
          medicationId: body.medicationId,
          pharmacyId: pharmacy,
          requiresLabs: body.requiresLabs,
        };
    sim.sendMessage("refill-requests", { ...payload, source: "patient" }, correlationId);
    log.info("rx.refill.queued", "Refill request queued", {
      patientId,
      ctx: { pharmacy, source: "patient" },
    });
    return { statusCode: 202 };
  });

  const processRefill = wrap("rx", async (event, { log, correlationId }) => {
    const msg = sqsBody(event);
    sim.sleep(lat(8));
    if (typeof msg.medicationId !== "string" || typeof msg.pharmacyId !== "string") {
      const error = simError("data", "Invalid refill message: medicationId is required", {
        code: "PAYLOAD_SCHEMA_MISMATCH",
        frames: ["parseRefillMessage (rx/worker.js:31:15)", "processRefill (rx/worker.js:12:20)"],
      });
      log.error("rx.refill.parse_failed", "Refill message failed validation", {
        error,
        ctx: { keys: Object.keys(msg).sort().join(",").slice(0, 200) },
      });
      throw error;
    }
    const patientId = String(msg.patientId);
    const pharmacy = msg.pharmacyId as PharmacyId;
    const source = String(msg.source);

    if (msg.requiresLabs === true) {
      sim.sleep(lat(220));
      if (world.labTokenExpired(sim.now)) {
        const error = simError("auth", "Lab results API rejected credentials (HTTP 401)", {
          code: "LAB_AUTH_EXPIRED",
          frames: ["LabClient.getResults (rx/labs.js:58:13)", "processRefill (rx/worker.js:19:24)"],
        });
        log.error("rx.labs.check_failed", "Lab results check failed", {
          patientId,
          error,
          ctx: { labPartner: "lab-partner-a", status: 401 },
        });
        throw error;
      }
      log.info("rx.labs.verified", "Required lab results verified", {
        patientId,
        ctx: { labPartner: "lab-partner-a" },
      });
    }

    // DynamoDB write with SDK-style retries on throttling.
    const partitionKey = `pharmacy#${pharmacy}`;
    let bucket = partitions.get(partitionKey);
    if (!bucket) {
      bucket = new TokenBucket(world.ordersPartition.ratePerSec, world.ordersPartition.burst);
      partitions.set(partitionKey, bucket);
    }
    let written = false;
    for (let attempt = 1; attempt <= 3 && !written; attempt++) {
      sim.sleep(lat(12));
      if (bucket.take(sim.now)) {
        written = true;
      } else {
        log.warn("rx.order.write_throttled", "DynamoDB throttled the order write", {
          ctx: { table: "rx-orders", partitionKey, attempt },
        });
        sim.sleep(50 * 2 ** attempt + rng.int(0, 40));
      }
    }
    if (!written) {
      const error = simError(
        "dependency",
        "ProvisionedThroughputExceededException: The level of configured provisioned throughput for the table was exceeded",
        {
          code: "DDB_THROTTLED",
          frames: [
            "DynamoDBClient.send (node_modules/@aws-sdk/client-dynamodb/index.js:1:1)",
            "saveOrder (rx/orders.js:27:9)",
          ],
        },
      );
      log.error("rx.order.write_failed", "Could not save refill order", {
        patientId,
        error,
        ctx: { table: "rx-orders", partitionKey },
      });
      throw error;
    }

    for (let attempt = 1; ; attempt++) {
      sim.sleep(lat(350));
      if (!rng.chance(world.pharmacy503Rate(sim.now, pharmacy))) break;
      if (attempt < 3) {
        log.warn("rx.pharmacy.retrying", "Pharmacy partner call failed, retrying", {
          ctx: { pharmacy, status: 503, attempt },
        });
        sim.sleep(200 * attempt);
        continue;
      }
      const error = simError("dependency", `Pharmacy partner ${pharmacy} returned HTTP 503`, {
        code: "PHARMACY_5XX",
        frames: [
          "PharmacyClient.submit (rx/pharmacy.js:42:11)",
          "processRefill (rx/worker.js:27:22)",
        ],
      });
      log.error("rx.refill.failed", "Pharmacy partner rejected refill", {
        patientId,
        error,
        ctx: { pharmacy, status: 503 },
      });
      throw error;
    }

    log.info("rx.refill.submitted", "Refill submitted to pharmacy", {
      patientId,
      ctx: { pharmacy, source },
    });
    sim.putEvent(
      "honeydew.rx",
      "RefillSubmitted",
      eventBridgeDetail({ patientId, template: "refill_submitted", kind: "copay" }, correlationId),
    );
  });

  const autoRefillBatch = wrap("rx", async (event, { log }) => {
    const { pharmacyId, count, spreadMinutes } = detailOf(event) as {
      pharmacyId: PharmacyId;
      count: number;
      spreadMinutes: number;
    };
    log.info("rx.autorefill.batch_started", "Auto-refill batch started", {
      ctx: { pharmacy: pharmacyId, count },
    });
    for (let i = 0; i < count; i++) {
      const patient = rng.pick(patients);
      const med = rng.pick(MEDICATIONS);
      sim.sendMessage(
        "refill-requests",
        {
          patientId: patient.id,
          medicationId: med.id,
          pharmacyId,
          requiresLabs: med.requiresLabs,
          source: "autorefill",
        },
        rng.uuid(),
        (i / count) * spreadMinutes * 60_000,
      );
    }
  });

  /* ----------------------------- billing ------------------------------ */

  const charge = wrap("billing", async (event, { log }) => {
    const { patientId, kind } = detailOf(event) as { patientId: string; kind: string };
    sim.sleep(lat(180));
    if (rng.chance(0.003)) {
      sim.sleep(10_000);
      const error = simError("timeout", "Payment processor did not respond within 10000ms", {
        code: "PAYMENTS_TIMEOUT",
        frames: ["PaymentsClient.charge (billing/payments.js:33:9)"],
      });
      log.error("billing.charge.failed", "Charge failed", { patientId, error, ctx: { kind } });
      throw error;
    }
    if (rng.chance(0.02)) {
      log.warn("billing.charge.declined", "Card declined", {
        patientId,
        ctx: { kind, reason: rng.pick(["card_declined", "insufficient_funds"]) },
      });
      return;
    }
    log.info("billing.charge.succeeded", "Charge succeeded", {
      patientId,
      ctx: { kind, amountCents: kind === "visit" ? 4900 : 1500 },
    });
  });

  /* -------------------------- notifications --------------------------- */

  const notify = wrap("notifications", async (event, { log, correlationId }) => {
    const { patientId, template } = detailOf(event) as { patientId: string; template: string };
    const patient = patientById.get(patientId);
    const channel = patient?.prefers ?? "sms";
    const provider = channel === "sms" ? "sms-provider-a" : "email-provider-b";
    sim.sleep(lat(120));
    log.info(
      `notifications.${channel}.accepted`,
      `Provider accepted ${channel === "sms" ? "SMS" : "email"}`,
      {
        patientId,
        ctx: { provider, template },
      },
    );
    if (channel === "sms" && world.smsSilentlyDropped(sim.now)) return; // accepted, never delivered
    const sentAt = sim.now;
    const delivered = !rng.chance(0.005);
    sim.apiRequest("notifications", deliveryReceipt, {
      method: "POST",
      path: "/webhooks/delivery",
      headers: correlationHeaders(correlationId),
      body: { patientId, channel, provider, delivered, sentAt },
      at: sim.now + lat(channel === "sms" ? 4000 : 9000, 0.6),
    });
  });

  const deliveryReceipt: LambdaHandler = wrap("notifications", async (event, { log }) => {
    const body = json(event) as {
      patientId: string;
      channel: string;
      provider: string;
      delivered: boolean;
      sentAt: number;
    };
    sim.sleep(lat(15));
    if (body.delivered) {
      log.info(`notifications.${body.channel}.delivered`, "Provider confirmed delivery", {
        patientId: body.patientId,
        ctx: { provider: body.provider, deliveryMs: Math.round(sim.now - body.sentAt) },
      });
    } else {
      log.warn(`notifications.${body.channel}.undelivered`, "Provider reported delivery failure", {
        patientId: body.patientId,
        ctx: { provider: body.provider, reason: "carrier_rejected" },
      });
    }
    return { statusCode: 200 };
  });

  /* ----------------------------- wiring ------------------------------ */

  sim.registerQueue("refill-requests", "rx-worker", processRefill);
  sim.subscribe("IntakeSubmitted", "scheduling-book", bookAppointment);
  sim.subscribe("AppointmentBooked", "billing-charge", charge);
  sim.subscribe("AppointmentBooked", "notifications-send", notify);
  sim.subscribe("RefillSubmitted", "billing-charge", charge);
  sim.subscribe("RefillSubmitted", "notifications-send", notify);
  sim.subscribe("Scheduled Event", "rx-autorefill", autoRefillBatch);

  return { submitIntake, requestRefill };
}

/** Patient-facing traffic: Poisson arrivals at the world's (time-varying) rates. */
export function startTraffic(
  sim: SimRuntime,
  world: World,
  patients: Patient[],
  handlers: ReturnType<typeof buildPlatform>,
): void {
  const rng = sim.rng;
  // About 70% of clients (web) send a correlation ID; the rest get one generated at the edge.
  const headers = (): Record<string, string> =>
    rng.chance(0.7) ? correlationHeaders(rng.uuid()) : {};

  const arrivals = (ratePerMin: (t: number) => number, fire: () => void) => {
    const next = () => {
      const rate = Math.max(ratePerMin(sim.now), 1e-6) / 60_000;
      sim.schedule(sim.now + rng.exponential(rate), () => {
        fire();
        next();
      });
    };
    next();
  };

  arrivals(world.intakePerMin, () => {
    const patient = rng.pick(patients);
    sim.apiRequest("intake", handlers.submitIntake, {
      method: "POST",
      path: "/intake",
      headers: headers(),
      body: {
        patientId: patient.id,
        channel: rng.pick(["web", "ios", "android"]),
        complete: !rng.chance(0.015),
      },
    });
  });

  arrivals(world.refillPerMin, () => {
    const patient = rng.pick(patients);
    const med = rng.pick(MEDICATIONS);
    sim.apiRequest("rx", handlers.requestRefill, {
      method: "POST",
      path: "/refills",
      headers: headers(),
      body: {
        patientId: patient.id,
        medicationId: med.id,
        pharmacyId: rng.chance(0.6) ? PHARMACIES[0] : PHARMACIES[1],
        requiresLabs: med.requiresLabs,
        hasActiveRx: !rng.chance(0.01),
      },
    });
  });

  for (const job of world.scheduledJobs) {
    sim.schedule(job.at, () =>
      sim.putEvent("aws.events", "Scheduled Event", { job: job.job, ...job.detail }),
    );
  }
}
