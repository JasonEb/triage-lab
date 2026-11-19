import type { Diagnosis } from "@triage/agent";
import type { GroundTruth } from "@triage/sim";
import type { LogStore } from "@triage/store";

/** Each check is 0 or 1, so means over runs read as accuracy. */
export interface Score {
  /** Root-cause category matches the ground-truth error type. */
  category: 0 | 1;
  /** Culprit service matches. */
  service: 0 | 1;
  /** At least one cited line is direct evidence of the fault. */
  evidence: 0 | 1;
}

/**
 * Deterministic rubric (no LLM judge):
 * - category: exact match with groundTruth.category. insufficient_data never matches.
 * - service: exact match with groundTruth.culpritService.
 * - evidence: some cited line (after the agent dropped citations it never saw)
 *   carries one of groundTruth.evidenceEvents (structured logs) or matches one of
 *   groundTruth.evidencePatterns (either style, case-insensitive).
 */
export function scoreDiagnosis(d: Diagnosis, gt: GroundTruth, store: LogStore): Score {
  const patterns = gt.evidencePatterns.map((p) => new RegExp(p, "i"));
  const cited = store.getLines(d.evidence.map((e) => e.lineId));
  const relevant = cited.some(
    (l) =>
      (l.event !== null && gt.evidenceEvents.includes(l.event)) ||
      patterns.some((re) => re.test(l.text)),
  );
  return {
    category: d.suspectedRootCause.category === gt.category ? 1 : 0,
    service: d.suspectedRootCause.service === gt.culpritService ? 1 : 0,
    evidence: relevant ? 1 : 0,
  };
}
