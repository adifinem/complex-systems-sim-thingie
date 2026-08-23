/** Seeded PRNG (sfc32). State is 4 uint32 words, fully serializable. */

export type RngState = [number, number, number, number]

export class Rng {
  private a: number
  private b: number
  private c: number
  private d: number

  constructor(state: RngState) {
    ;[this.a, this.b, this.c, this.d] = state
  }

  static fromSeed(seed: number): Rng {
    // splitmix32 to expand one seed into four words, then warm up.
    let h = seed >>> 0
    const next = () => {
      h = (h + 0x9e3779b9) >>> 0
      let z = h
      z = Math.imul(z ^ (z >>> 16), 0x21f0aaad)
      z = Math.imul(z ^ (z >>> 15), 0x735a2d97)
      return (z ^ (z >>> 15)) >>> 0
    }
    const rng = new Rng([next(), next(), next(), next()])
    for (let i = 0; i < 12; i++) rng.next()
    return rng
  }

  /** Uniform in [0, 1). */
  next(): number {
    this.a >>>= 0
    this.b >>>= 0
    this.c >>>= 0
    this.d >>>= 0
    let t = (this.a + this.b) | 0
    this.a = this.b ^ (this.b >>> 9)
    this.b = (this.c + (this.c << 3)) | 0
    this.c = (this.c << 21) | (this.c >>> 11)
    this.d = (this.d + 1) | 0
    t = (t + this.d) | 0
    this.c = (this.c + t) | 0
    return (t >>> 0) / 4294967296
  }

  normal(mean: number, sd: number): number {
    // Box-Muller; draws exactly two uniforms per call (deterministic draw count).
    const u1 = Math.max(this.next(), 1e-12)
    const u2 = this.next()
    return mean + sd * Math.sqrt(-2 * Math.log(u1)) * Math.cos(2 * Math.PI * u2)
  }

  getState(): RngState {
    return [this.a >>> 0, this.b >>> 0, this.c >>> 0, this.d >>> 0]
  }

  setState(s: RngState): void {
    ;[this.a, this.b, this.c, this.d] = s
  }
}
