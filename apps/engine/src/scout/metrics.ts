/**
 * In-process counters and gauges for the Scout. Kept dependency-free so the engine can export
 * them through whatever metrics endpoint it exposes.
 */
export class ScoutMetrics {
  private readonly counters = new Map<string, number>();
  private readonly gauges = new Map<string, number>();

  inc(name: string, by = 1): void {
    this.counters.set(name, (this.counters.get(name) ?? 0) + by);
  }

  set(name: string, value: number): void {
    this.gauges.set(name, value);
  }

  counter(name: string): number {
    return this.counters.get(name) ?? 0;
  }

  gauge(name: string): number | undefined {
    return this.gauges.get(name);
  }

  snapshot(): { counters: Record<string, number>; gauges: Record<string, number> } {
    return { counters: Object.fromEntries(this.counters), gauges: Object.fromEntries(this.gauges) };
  }
}
