/**
 * Small seeded PRNG (mulberry32). Every random choice in the simulation goes
 * through one of these, so a seed fully determines the output.
 */
export class Rng {
  private state: number;

  constructor(seed: number) {
    this.state = seed >>> 0;
  }

  /** Uniform in [0, 1). */
  next(): number {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** Integer in [min, max], inclusive. */
  int(min: number, max: number): number {
    return min + Math.floor(this.next() * (max - min + 1));
  }

  chance(p: number): boolean {
    return this.next() < p;
  }

  pick<T>(items: readonly T[]): T {
    return items[Math.floor(this.next() * items.length)]!;
  }

  /** Exponential with the given rate (mean 1/rate). Used for arrival gaps. */
  exponential(rate: number): number {
    return -Math.log(1 - this.next()) / rate;
  }

  /** Log-normal with the given median. Latencies are right-skewed, like real ones. */
  lognormal(median: number, sigma: number): number {
    const u1 = 1 - this.next();
    const u2 = this.next();
    const z = Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2);
    return median * Math.exp(sigma * z);
  }

  hex(length: number): string {
    let s = "";
    while (s.length < length) s += Math.floor(this.next() * 16).toString(16);
    return s;
  }

  /** RFC 4122 v4-shaped UUID, deterministic. */
  uuid(): string {
    const h = this.hex(32).split("");
    h[12] = "4";
    h[16] = "89ab"[Math.floor(this.next() * 4)]!;
    const s = h.join("");
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }
}
