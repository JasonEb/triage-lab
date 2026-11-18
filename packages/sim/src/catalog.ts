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

const FIRST = [
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
const LAST = [
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
    const first = rng.pick(FIRST);
    const last = rng.pick(LAST);
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
