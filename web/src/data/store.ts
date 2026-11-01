// Baked months on demand (guidelines §7: lazy per-month loading), a few kept in memory, and
// the index of which city-months have data (bake/pack.py writes data/index.json).

import { loadMonth, type MonthData } from './month';

export interface DataIndex {
  schema: number;
  /** City id → baked months (1–12), ascending. */
  months: Record<string, number[]>;
}

export async function loadIndex(): Promise<DataIndex> {
  const url = `${import.meta.env.BASE_URL}data/index.json`;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: ${r.status}`);
  return (await r.json()) as DataIndex;
}

export class MonthStore {
  private readonly cache = new Map<string, Promise<MonthData>>();

  constructor(private readonly keep = 4) {}

  get(city: string, month: number): Promise<MonthData> {
    const key = `${city}/${month}`;
    const hit = this.cache.get(key);
    if (hit) {
      this.cache.delete(key); // most recently used last
      this.cache.set(key, hit);
      return hit;
    }
    const p = loadMonth(city, month);
    p.catch(() => this.cache.delete(key));
    this.cache.set(key, p);
    while (this.cache.size > this.keep) this.cache.delete(this.cache.keys().next().value!);
    return p;
  }
}
