import { createHmac } from "node:crypto";

/**
 * Default salt for local/sim runs. In a real deployment the salt is a secret
 * (e.g. an SSM SecureString) so hashes can't be reversed by enumerating the
 * small space of patient IDs.
 */
export const DEV_ID_HASH_SALT = "triage-lab-synthetic-salt";

/**
 * Keyed hash (HMAC-SHA256, first 128 bits as hex) of an identifier.
 * Deterministic, so the same patient correlates across services and log lines,
 * but the raw ID never appears in a log.
 */
export function hashId(
  raw: string,
  salt: string = process.env.TRIAGE_ID_HASH_SALT ?? DEV_ID_HASH_SALT,
): string {
  return createHmac("sha256", salt).update(raw).digest("hex").slice(0, 32);
}
