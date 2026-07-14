// Unit test for the recommendation traction shape (FIX 3 / W3 buyer-share).
// The find_best_service recommendation builder is inline; tractionRecFields is the pure,
// exported slice that maps assessment.traction to the five surfaced fields. Not shipped in
// dist (excluded in tsconfig). Run with: npx tsx --test mcp/src/tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tractionRecFields } from "./tools.js";
import type { ServiceTraction } from "./api.js";

const measured: ServiceTraction = {
  status: "measured",
  volume_usd_30d: 1234.5,
  tx_count_30d: 42,
  unique_buyers_30d: 7,
  last_settlement_at: "2026-07-14T00:00:00.000Z",
  top_buyer_share_30d: 0.94,
  trend_7d_vs_30d: 1.1,
  shared_payout: false,
  shared_with: 0,
  measured_networks: ["eip155:8453"],
};

test("emits top_buyer_share_30d alongside the four existing traction fields", () => {
  const f = tractionRecFields(measured);
  assert.deepEqual(Object.keys(f), [
    "traction_status",
    "volume_usd_30d",
    "unique_buyers_30d",
    "shared_payout",
    "top_buyer_share_30d",
  ]);
  assert.equal(f.traction_status, "measured");
  assert.equal(f.volume_usd_30d, 1234.5);
  assert.equal(f.unique_buyers_30d, 7);
  assert.equal(f.shared_payout, false);
  assert.equal(f.top_buyer_share_30d, 0.94);
});

test("a null/absent traction nulls every field (no fake zero)", () => {
  for (const t of [null, undefined]) {
    const f = tractionRecFields(t);
    assert.equal(f.traction_status, null);
    assert.equal(f.volume_usd_30d, null);
    assert.equal(f.unique_buyers_30d, null);
    assert.equal(f.shared_payout, null);
    assert.equal(f.top_buyer_share_30d, null);
  }
});

test("top_buyer_share_30d passes through null when measured but no buyer share", () => {
  const f = tractionRecFields({ ...measured, top_buyer_share_30d: null });
  assert.equal(f.traction_status, "measured");
  assert.equal(f.top_buyer_share_30d, null);
});
