import { HTTPException } from "hono/http-exception";

/** Bound password work across all HTTP endpoints, even when clients rotate names or addresses. */
export class PasswordWorkLimiter {
  private active = 0;
  private starts: number[] = [];

  constructor(
    private readonly maxConcurrent = 4,
    private readonly maxStarts = 60,
    private readonly windowMs = 60_000,
  ) {}

  async run<T>(work: () => Promise<T>): Promise<T> {
    const now = Date.now();
    this.starts = this.starts.filter((time) => now - time < this.windowMs);
    if (this.active >= this.maxConcurrent || this.starts.length >= this.maxStarts) {
      throw new HTTPException(429, { message: "Too many password requests. Try again in a minute." });
    }
    this.starts.push(now);
    this.active++;
    try {
      return await work();
    } finally {
      this.active--;
    }
  }
}
