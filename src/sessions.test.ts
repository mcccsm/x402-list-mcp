// Bounds on the hosted-HTTP session registry: idle TTL, hard cap with LRU eviction, and a
// delete() that survives the double hit (eviction closes the transport, the transport's own
// onclose then deletes the same id). No SDK import here, so it runs without mcp/node_modules.
// Run with: npx tsx --test mcp/src/sessions.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  SessionRegistry,
  DEFAULT_SESSION_TTL_MS,
  DEFAULT_MAX_SESSIONS,
  type ClosableSession,
} from "./sessions.js";

// ── harness: a transport stand-in that only implements { sessionId, close() } ─────
class FakeSession {
  closed = 0;
  constructor(readonly sessionId: string) {}
  close(): void {
    this.closed++;
  }
}

// Same, but wired like the real one: close() calls back into the registry's delete().
class SelfDeletingSession {
  closed = 0;
  constructor(
    readonly sessionId: string,
    private readonly registry: SessionRegistry<SelfDeletingSession>,
  ) {}
  close(): void {
    this.closed++;
    this.registry.delete(this.sessionId);
  }
}

function clock(start = 0) {
  const c = { t: start, now: () => c.t };
  return c;
}

test("defaults come from env fallbacks: 600000 ms TTL, 256 sessions", () => {
  assert.equal(DEFAULT_SESSION_TTL_MS, 600_000);
  assert.equal(DEFAULT_MAX_SESSIONS, 256);
  const r = new SessionRegistry<FakeSession>();
  assert.equal(r.ttlMs, DEFAULT_SESSION_TTL_MS);
  assert.equal(r.maxSessions, DEFAULT_MAX_SESSIONS);
});

test("env overrides the defaults; junk and non-positive values fall back", () => {
  const prev = { ttl: process.env.MCP_SESSION_TTL_MS, max: process.env.MCP_MAX_SESSIONS };
  try {
    process.env.MCP_SESSION_TTL_MS = "1234";
    process.env.MCP_MAX_SESSIONS = "7";
    let r = new SessionRegistry<FakeSession>();
    assert.equal(r.ttlMs, 1234);
    assert.equal(r.maxSessions, 7);

    process.env.MCP_SESSION_TTL_MS = "nope";
    process.env.MCP_MAX_SESSIONS = "0";
    r = new SessionRegistry<FakeSession>();
    assert.equal(r.ttlMs, DEFAULT_SESSION_TTL_MS);
    assert.equal(r.maxSessions, DEFAULT_MAX_SESSIONS);
  } finally {
    if (prev.ttl === undefined) delete process.env.MCP_SESSION_TTL_MS;
    else process.env.MCP_SESSION_TTL_MS = prev.ttl;
    if (prev.max === undefined) delete process.env.MCP_MAX_SESSIONS;
    else process.env.MCP_MAX_SESSIONS = prev.max;
  }
});

test("300 initializes against a cap of 256 leave 256 alive and close the 44 oldest", () => {
  const r = new SessionRegistry<FakeSession>({ maxSessions: 256, ttlMs: 600_000 });
  const made: FakeSession[] = [];
  for (let i = 0; i < 300; i++) {
    const s = new FakeSession(`s${i}`);
    made.push(s);
    r.set(s.sessionId, s);
  }

  assert.equal(r.size, 256);
  for (let i = 0; i < 44; i++) {
    assert.equal(made[i].closed, 1, `s${i} evicted and closed exactly once`);
    assert.equal(r.get(`s${i}`), undefined, `s${i} is gone from the registry`);
  }
  for (let i = 44; i < 300; i++) {
    assert.equal(made[i].closed, 0, `s${i} still open`);
    assert.equal(r.get(`s${i}`), made[i], `s${i} still served`);
  }
});

test("eviction is LRU, not FIFO: a session touched by get() outlives older traffic", () => {
  const c = clock();
  const r = new SessionRegistry<FakeSession>({ maxSessions: 3, ttlMs: 600_000, now: c.now });
  const a = new FakeSession("a");
  const b = new FakeSession("b");
  const d = new FakeSession("d");
  r.set("a", a);
  r.set("b", b);
  r.set("d", d);

  c.t = 10;
  assert.equal(r.get("a"), a);

  r.set("e", new FakeSession("e"));

  assert.equal(r.size, 3);
  assert.equal(b.closed, 1, "b was the least recently used");
  assert.equal(a.closed, 0, "a survived because it was touched");
  assert.equal(d.closed, 0);
});

test("sweep closes and drops sessions idle past the TTL, spares the recent ones", () => {
  const c = clock();
  const r = new SessionRegistry<FakeSession>({ maxSessions: 256, ttlMs: 1000, now: c.now });
  const idle = new FakeSession("idle");
  const busy = new FakeSession("busy");
  r.set("idle", idle);
  r.set("busy", busy);

  c.t = 900;
  assert.equal(r.sweep(), 0, "nothing is idle yet");

  r.get("busy");
  c.t = 1500;
  assert.equal(r.sweep(), 1);

  assert.equal(idle.closed, 1);
  assert.equal(r.size, 1);
  assert.equal(r.get("idle"), undefined);
  assert.equal(busy.closed, 0);
  assert.equal(r.get("busy"), busy);
});

test("sweep takes an explicit now", () => {
  const c = clock();
  const r = new SessionRegistry<FakeSession>({ ttlMs: 1000, now: c.now });
  const s = new FakeSession("s");
  r.set("s", s);
  assert.equal(r.sweep(999), 0);
  assert.equal(r.sweep(1000), 1);
  assert.equal(s.closed, 1);
});

test("delete is idempotent and never closes", () => {
  const r = new SessionRegistry<FakeSession>();
  const s = new FakeSession("s");
  r.set("s", s);

  assert.equal(r.delete("s"), true);
  assert.equal(r.delete("s"), false);
  assert.equal(r.delete("never-existed"), false);
  assert.equal(s.closed, 0, "delete() unlinks only; closing is the caller's job");
  assert.equal(r.size, 0);
});

test("close() calling delete() during eviction and sweep is harmless", () => {
  const r = new SessionRegistry<SelfDeletingSession>({ maxSessions: 2, ttlMs: 1000 });
  const a = new SelfDeletingSession("a", r);
  const b = new SelfDeletingSession("b", r);
  const d = new SelfDeletingSession("d", r);
  r.set("a", a);
  r.set("b", b);
  r.set("d", d);

  assert.equal(a.closed, 1);
  assert.equal(r.size, 2, "the re-entrant delete did not take a second victim");

  r.sweep(Date.now() + 10_000);
  assert.equal(b.closed, 1);
  assert.equal(d.closed, 1);
  assert.equal(r.size, 0);
});

test("a rejected close() does not break the sweep nor leak an unhandled rejection", () => {
  const r = new SessionRegistry<ClosableSession>({ ttlMs: 0 });
  let secondClosed = false;
  r.set("bad", { sessionId: "bad", close: () => Promise.reject(new Error("boom")) });
  r.set("throws", {
    sessionId: "throws",
    close: () => {
      throw new Error("boom");
    },
  });
  r.set("ok", {
    sessionId: "ok",
    close: () => {
      secondClosed = true;
    },
  });

  assert.equal(r.sweep(), 3);
  assert.equal(secondClosed, true);
  assert.equal(r.size, 0);
});

test("set on an existing id replaces without closing the old transport", () => {
  const r = new SessionRegistry<FakeSession>({ maxSessions: 2 });
  const first = new FakeSession("s");
  const second = new FakeSession("s");
  r.set("s", first);
  r.set("s", second);
  assert.equal(r.size, 1);
  assert.equal(r.get("s"), second);
  assert.equal(first.closed, 0);
});

test("closeAll drains the registry", () => {
  const r = new SessionRegistry<FakeSession>();
  const a = new FakeSession("a");
  const b = new FakeSession("b");
  r.set("a", a);
  r.set("b", b);
  r.closeAll();
  assert.equal(r.size, 0);
  assert.equal(a.closed, 1);
  assert.equal(b.closed, 1);
});
