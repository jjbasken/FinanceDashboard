import { HTTPException } from "hono/http-exception";

const TTL_MS = 60 * 60 * 1000;
const MAX_PREVIEWS = 8;
const MAX_PER_USER = 3;
const MAX_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_PREVIEW_BYTES = 128 * 1024 * 1024;

/** Conservative accounting for retained JS objects, without making another serialized copy. */
export function previewBytes(value: unknown, maxBytes = MAX_PREVIEW_BYTES): number {
  let bytes = 0;
  let nodes = 0;
  const visit = (item: unknown) => {
    if (++nodes > 1_000_000) throw new HTTPException(413, { message: "That import has too many records. Split it into smaller files." });
    if (typeof item === "string") bytes += 64 + item.length * 2;
    else if (Array.isArray(item)) {
      bytes += 64 + item.length * 8;
      for (const child of item) visit(child);
    } else if (item && typeof item === "object") {
      bytes += 128;
      for (const [key, child] of Object.entries(item)) {
        bytes += 32 + key.length * 2;
        visit(child);
      }
    } else bytes += 16;
    if (bytes > maxBytes) throw new HTTPException(413, { message: "That import is too large to preview. Split it into smaller files." });
  };
  visit(value);
  return bytes;
}

/** Per-server preview storage and reservations shared by all three import formats. */
export class ImportPreviews {
  private entries = new Map<string, {
    userId: number; householdId: number; value: unknown; bytes: number; timer: ReturnType<typeof setTimeout>;
  }>();
  private active = new Set<number>();
  private bytes = 0;

  constructor(
    private readonly ttlMs = TTL_MS,
    private readonly maxTotalBytes = MAX_TOTAL_BYTES,
    private readonly maxPreviewBytes = MAX_PREVIEW_BYTES,
  ) {}

  begin(userId: number) {
    if (this.active.has(userId) || this.active.size >= 2) {
      throw new HTTPException(429, { message: "Another file is being uploaded. Wait for it to finish and try again." });
    }
    // Previews are only freed by a commit, so ones abandoned by picking another file or leaving the
    // page pile up. Make room by dropping this user's oldest rather than refusing their next file.
    const mine = [...this.entries].filter(([, entry]) => entry.userId === userId).map(([key]) => key);
    for (const key of mine.slice(0, Math.max(0, mine.length - MAX_PER_USER + 1))) this.delete(key);
    if (this.entries.size + this.active.size >= MAX_PREVIEWS) {
      throw new HTTPException(429, { message: "Too many import previews are open. Finish an import or wait for old previews to expire." });
    }
    this.active.add(userId);
    return () => this.active.delete(userId);
  }

  set(key: string, userId: number, householdId: number, value: unknown) {
    const bytes = previewBytes(value, this.maxPreviewBytes);
    if (this.bytes + bytes > this.maxTotalBytes) {
      throw new HTTPException(429, { message: "Import preview storage is full. Finish an import or try again later." });
    }
    const timer = setTimeout(() => this.delete(key), this.ttlMs);
    timer.unref();
    this.entries.set(key, { userId, householdId, value, bytes, timer });
    this.bytes += bytes;
  }

  get<T>(key: string, householdId: number): T {
    const entry = this.entries.get(key);
    if (!entry || entry.householdId !== householdId) {
      throw new HTTPException(404, { message: "That upload has expired. Upload the file again." });
    }
    return entry.value as T;
  }

  delete(key: string) {
    const entry = this.entries.get(key);
    if (!entry) return;
    clearTimeout(entry.timer);
    this.bytes -= entry.bytes;
    this.entries.delete(key);
  }
}

/** Bound the body while reading, including requests without a Content-Length header. */
export async function readUpload(request: Request, maxBytes: number) {
  const tooLarge = () => new HTTPException(413, { message: `That file is too large (${maxBytes / 1024 / 1024} MB max)` });
  if (Number(request.headers.get("content-length")) > maxBytes) throw tooLarge();
  const reader = request.body?.getReader();
  if (!reader) throw new HTTPException(400, { message: "The file is empty" });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel();
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  if (!size) throw new HTTPException(400, { message: "The file is empty" });
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}
