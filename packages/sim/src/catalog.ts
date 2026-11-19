import type { RedactOptions } from "@triage/logger";
import { Rng } from "./rng.js";

/**
 * Synthetic people and products. Names come from short generic lists, phone
 * numbers from the fictional 555-01xx range, and emails use example.test.
 * None of it describes a real person.
 */
export interface Patient {
  id: string;
  name: string;
  phone: string;
  email: string;
  prefers: "sms" | "email";
}

export const SYNTHETIC_FIRST_NAMES = [
  "Alex",
  "Jordan",
  "Maria",
  "Sam",
  "Priya",
  "Chen",
  "Fatima",
  "Diego",
  "Aisha",
  "Noah",
  "Lena",
  "Omar",
  "Grace",
  "Ravi",
  "Zoe",
  "Mateo",
];
export const SYNTHETIC_LAST_NAMES = [
  "Garcia",
  "Smith",
  "Nguyen",
  "Okafor",
  "Patel",
  "Kim",
  "Rivera",
  "Cohen",
  "Haddad",
  "Silva",
  "Novak",
  "Moreau",
  "Tanaka",
  "Byrne",
];

export function makePatients(count: number, seed = 20261118): Patient[] {
  const rng = new Rng(seed);
  return Array.from({ length: count }, (_, i) => {
    const first = rng.pick(SYNTHETIC_FIRST_NAMES);
    const last = rng.pick(SYNTHETIC_LAST_NAMES);
    return {
      id: `pt_${String(i + 1).padStart(5, "0")}`,
      name: `${first} ${last}`,
      phone: `+1-555-01${String(rng.int(0, 99)).padStart(2, "0")}`,
      email: `${first}.${last}${i + 1}@example.test`.toLowerCase(),
      prefers: rng.chance(0.7) ? "sms" : "email",
    };
  });
}

export interface Medication {
  id: string;
  name: string;
  requiresLabs: boolean;
}

/** Opaque IDs travel in payloads; names only ever appear in legacy logs. */
export const MEDICATIONS: Medication[] = [
  { id: "RX-1043", name: "isotretinoin 40mg", requiresLabs: true },
  { id: "RX-2210", name: "tretinoin 0.05% cream", requiresLabs: false },
  { id: "RX-3302", name: "spironolactone 100mg", requiresLabs: false },
  { id: "RX-4118", name: "doxycycline 100mg", requiresLabs: false },
  { id: "RX-5027", name: "clindamycin 1% gel", requiresLabs: false },
];

export const PHARMACIES = ["pharmacy-a", "pharmacy-b"] as const;
export type PharmacyId = (typeof PHARMACIES)[number];

/**
 * Redaction settings for anything derived from these logs that is shown to a
 * model. Identifier formats and a name dictionary are platform configuration;
 * here they describe the synthetic data. In production the dictionary would
 * come from the patient directory.
 */
export const SYNTHETIC_REDACTION: RedactOptions = {
  idPatterns: [/\bpt_\d{5}\b/],
  names: [...SYNTHETIC_FIRST_NAMES, ...SYNTHETIC_LAST_NAMES],
};
