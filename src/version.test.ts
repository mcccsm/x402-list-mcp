// Version-sync guard. SERVER_INFO.version, the api.ts USER_AGENT, package.json and server.json
// (including its per-package entry) must ALL carry the same version. Publish and the reported
// server identity drift silently otherwise; the "keep in sync" comments in server.ts / api.ts are
// the only other guard. Not shipped in dist (excluded in tsconfig).
// Run with: npx tsx --test mcp/src/version.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { SERVER_INFO } from "./server.js";
import { USER_AGENT } from "./api.js";

const here = dirname(fileURLToPath(import.meta.url));
const readJson = (rel: string) => JSON.parse(readFileSync(join(here, rel), "utf8"));

test("version is in sync across package.json, server.json, SERVER_INFO and USER_AGENT", () => {
  const pkg = readJson("../package.json");
  const manifest = readJson("../server.json");
  const v = SERVER_INFO.version;
  assert.equal(pkg.version, v, "package.json version matches SERVER_INFO");
  assert.equal(manifest.version, v, "server.json version matches SERVER_INFO");
  for (const p of manifest.packages ?? []) {
    assert.equal(p.version, v, `server.json packages[].version (${p.identifier}) matches SERVER_INFO`);
  }
  // USER_AGENT format: "x402-list-mcp/<v> (+https://x402-list.com)".
  assert.ok(USER_AGENT.includes(`/${v} `), `USER_AGENT embeds version ${v} (got: ${USER_AGENT})`);
});
