/**
 * In-memory failed-login limiter for a single-process home server. Failures are counted per
 * client and username, so someone guessing at a username from their machine can't lock its real
 * owner out from theirs, and per client across all usernames, so one client can't spray guesses.
 */
export class LoginRateLimiter {
  private failures = new Map<string, number[]>();

  constructor(
    private readonly perUser = 10,
    private readonly perClient = 30,
    private readonly windowMs = 15 * 60 * 1000,
  ) {}

  isBlocked(client: string, username: string, now = Date.now()): boolean {
    return (
      this.recent(pairKey(client, username), now).length >= this.perUser ||
      this.recent(clientKey(client), now).length >= this.perClient
    );
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
