export class SeededRandom {
  constructor(public state: number) {
    this.state >>>= 0;
  }

  next(): number {
    this.state = (this.state + 0x6d2b79f5) >>> 0;
    let value = this.state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4294967296;
  }

  between(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  pick<T>(values: readonly T[]): T {
    if (values.length === 0) throw new RangeError("Cannot choose from an empty collection.");
    return values[Math.floor(this.next() * values.length)];
  }
}
