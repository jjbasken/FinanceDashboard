/** In-memory failed-login limiter, keyed by username. Fine for a single-process home server. */
export class LoginRateLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly maxFailures = 10,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(key: string, now = Date.now()): boolean {
    return this.recent(key, now).length >= this.maxFailures;
  }

  recordFailure(key: string, now = Date.now()) {
    const list = this.recent(key, now);
    list.push(now);
    this.failures.set(key, list);
  }

  reset(key: string) {
    this.failures.delete(key);
  }

  private recent(key: string, now: number) {
    return (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }
}
