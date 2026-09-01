// Bounded session registry for the hosted HTTP transport. A plain Map grows forever:
// initialize is unauthenticated and DELETE (the only client-driven teardown) is rare, so
// every abandoned session keeps its transport and its McpServer alive. This adds an idle
// TTL plus a hard cap with LRU eviction.
//
// Deliberately free of any SDK import: it only needs { sessionId?, close() }, which keeps
// it unit-testable without mcp/node_modules.

export interface ClosableSession {
  sessionId?: string;
  close(): void | Promise<void>;
}

export interface SessionRegistryOptions {
  ttlMs?: number;
  maxSessions?: number;
  now?: () => number;
}

export const DEFAULT_SESSION_TTL_MS = 600_000;
export const DEFAULT_MAX_SESSIONS = 256;

function envPositiveInt(name: string, fallback: number): number {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : fallback;
}

// close() failures must not abort a sweep or an eviction: the entry is already unlinked,
// the reference is gone either way.
function safeClose(session: ClosableSession): void {
  try {
    void Promise.resolve(session.close()).catch(() => {});
  } catch {
    /* ignore */
  }
}

export class SessionRegistry<T extends ClosableSession> {
  readonly ttlMs: number;
  readonly maxSessions: number;
  private readonly now: () => number;
  // Insertion order is the recency order: get() re-inserts, so the first entry is the LRU.
  private readonly entries = new Map<string, { session: T; lastSeen: number }>();

  constructor(opts: SessionRegistryOptions = {}) {
    this.ttlMs = opts.ttlMs ?? envPositiveInt("MCP_SESSION_TTL_MS", DEFAULT_SESSION_TTL_MS);
    this.maxSessions = opts.maxSessions ?? envPositiveInt("MCP_MAX_SESSIONS", DEFAULT_MAX_SESSIONS);
    this.now = opts.now ?? Date.now;
  }

  get size(): number {
    return this.entries.size;
  }

  set(id: string, session: T): void {
    this.entries.delete(id);
    this.entries.set(id, { session, lastSeen: this.now() });
    while (this.entries.size > this.maxSessions) {
      const lru = this.entries.keys().next();
      if (lru.done) break;
      this.evict(lru.value);
    }
  }

  // Also the touch: any request carrying a live session id refreshes its idle clock.
  get(id: string): T | undefined {
    const entry = this.entries.get(id);
    if (!entry) return undefined;
    entry.lastSeen = this.now();
    this.entries.delete(id);
    this.entries.set(id, entry);
    return entry.session;
  }

  // Unlink only, never close: this is what transport.onclose calls, and it must tolerate
  // being called again for an id an eviction already dropped.
  delete(id: string): boolean {
    return this.entries.delete(id);
  }

  // Returns how many sessions were closed.
  sweep(now: number = this.now()): number {
    let closed = 0;
    for (const [id, entry] of [...this.entries]) {
      if (now - entry.lastSeen >= this.ttlMs && this.evict(id)) closed++;
    }
    return closed;
  }

  closeAll(): void {
    for (const id of [...this.entries.keys()]) this.evict(id);
  }

  // Unlink BEFORE close(): close() re-enters through onclose -> delete().
  private evict(id: string): boolean {
    const entry = this.entries.get(id);
    if (!entry) return false;
    this.entries.delete(id);
    safeClose(entry.session);
    return true;
  }
}
