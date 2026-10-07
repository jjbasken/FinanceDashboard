/**
 * In-memory failed-login limiter for a single-process home server. Failures are counted per
 * client and username, so someone guessing at a username from their machine can't lock its real
 * owner out from theirs, and per client across all usernames, so one client can't spray guesses.
 */
export class LoginRateLimiter {
  private failures = new Map<string, number[]>();
  private inFlight = new Map<string, number>();

  constructor(
    private readonly perUser = 10,
    private readonly perClient = 30,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(client: string, username: string, now = Date.now()): boolean {
    return (
      this.used(pairKey(client, username), now) >= this.perUser ||
      this.used(clientKey(client), now) >= this.perClient
    );
  }

  /** Reserve capacity synchronously, before password verification yields to other requests. */
  start(client: string, username: string) {
    if (this.isBlocked(client, username)) return null;
    const keys = [pairKey(client, username), clientKey(client)];
    for (const key of keys) this.inFlight.set(key, (this.inFlight.get(key) ?? 0) + 1);
    let finished = false;
    return (success: boolean | null) => {
      if (finished) return;
      finished = true;
      for (const key of keys) {
        const remaining = (this.inFlight.get(key) ?? 1) - 1;
        if (remaining) this.inFlight.set(key, remaining);
        else this.inFlight.delete(key);
      }
      if (success === true) this.reset(client, username);
      if (success === false) this.recordFailure(client, username);
    };
  }

  private used(key: string, now: number) {
    return this.recent(key, now).length + (this.inFlight.get(key) ?? 0);
  }

  recordFailure(client: string, username: string, now = Date.now()) {
    for (const key of [pairKey(client, username), clientKey(client)]) {
      const list = this.recent(key, now);
      list.push(now);
      this.failures.set(key, list);
    }
    if (this.failures.size > 10_000) this.prune(now);
  }

  /** After a successful sign-in, forget that client's failures for the username. */
  reset(client: string, username: string) {
    this.failures.delete(pairKey(client, username));
  }

  private recent(key: string, now: number) {
    return (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
  }

  private prune(now: number) {
    for (const [key, times] of this.failures) {
      if (!times.some((t) => now - t < this.windowMs)) this.failures.delete(key);
    }
  }
}

const pairKey = (client: string, username: string) => `${client}\n${username}`;
const clientKey = (client: string) => `${client}\n`;
