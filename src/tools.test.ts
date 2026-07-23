// Unit test for the recommendation traction shape (FIX 3 / W3 buyer-share).
// The find_best_service recommendation builder is inline; tractionRecFields is the pure,
// exported slice that maps assessment.traction to the five surfaced fields. Not shipped in
// dist (excluded in tsconfig). Run with: npx tsx --test mcp/src/tools.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { tractionRecFields, complianceScore, tractionScore } from "./tools.js";
import type { ServiceTraction, ServiceListItem, AssessmentSummary } from "./api.js";

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
  // TRENO A additive fields (mirror the API serializer).
  first_settlement_at: "2026-05-01T00:00:00.000Z",
  volume_usd_all_time: 9876.5,
  tx_count_all_time: 321,
  median_settlement_usd_30d: 2.5,
  max_settlement_usd_30d: 50,
  settled_via: ["facilitator-a"],
  shared_with_services: [],
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

// ── D-b3 compliance ratio (fixture / gate replacement) ────────────────────────
// The old gate "sd(complianceScore) > 0 across the online pool" is unsatisfiable while every
// live service grades A on the same real checks (dropping mimetype leaves the pool uniform). It
// is replaced by a robustness fixture: a synthetic service that fails a REAL check must score
// STRICTLY below an otherwise-identical conformant twin. That is exactly what the continuous
// pass ratio buys - and since the four measured family weights include a positive
// qWeights.compliance and the twins are identical in every other family, a strictly higher
// complianceScore propagates to a strictly higher base/quality, i.e. it ranks above.

function assessmentWith(passed: number | null, total: number | null, failed: string[]): AssessmentSummary {
  return {
    compliance_grade: total && passed === total ? "A" : "B",
    compliance_passed: passed,
    compliance_total: total,
    compliance_failed_checks: failed,
    reliability_uptime_30d: null,
    response_p95_ms: null,
    price_usd: null,
    category_percentile: null,
    price_stability: null,
    price_max_usd: null,
    category_percentile_max: null,
    endpoint_count: null,
    distinct_price_count: null,
    risk_level: null,
    capability_tags: null,
    summary: null,
    traction: null,
    updated_at: null,
  };
}

function serviceWith(assessment: AssessmentSummary | null, verified = true): ServiceListItem {
  return {
    slug: "svc",
    name: "Svc",
    description: "",
    base_url: "https://svc.example.com",
    website_url: null,
    category: "data",
    status: "online",
    verified,
    endpoint_count: 1,
    min_price_usd: null,
    networks: [],
    networks_caip2: [],
    uptime_24h: null,
    avg_response_time_ms: null,
    last_checked_at: null,
    created_at: null,
    assessment,
  };
}

test("complianceScore: a real-check failure scores STRICTLY below a conformant twin", () => {
  const conformant = serviceWith(assessmentWith(11, 11, []));
  const malformed = serviceWith(assessmentWith(10, 11, ["transport_https"]));
  assert.equal(complianceScore(conformant), 1); // 11/11
  assert.ok(Math.abs(complianceScore(malformed) - 10 / 11) < 1e-12);
  assert.ok(
    complianceScore(conformant) > complianceScore(malformed),
    "conformant twin must score strictly above the malformed one",
  );
});

test("complianceScore: any distinct real failure discriminates (continuous, not a band bucket)", () => {
  // Both would still grade 'A' under the old 5-band bucket (>=0.90); the ratio separates them.
  const oneFail = serviceWith(assessmentWith(11, 12, ["price_present"]));
  const twoFail = serviceWith(assessmentWith(10, 12, ["price_present", "payto_shape"]));
  assert.ok(complianceScore(oneFail) > complianceScore(twoFail));
});

test("complianceScore: no gradeable compliance falls back to verified weight", () => {
  assert.equal(complianceScore(serviceWith(assessmentWith(0, 0, []), true)), 0.6);
  assert.equal(complianceScore(serviceWith(assessmentWith(0, 0, []), false)), 0.4);
  assert.equal(complianceScore(serviceWith(null, true)), 0.6);
  assert.equal(complianceScore(serviceWith(null, false)), 0.4);
  // A fully conformant service outranks a merely-verified, ungraded one.
  assert.ok(complianceScore(serviceWith(assessmentWith(11, 11, []))) > complianceScore(serviceWith(null, true)));
});

// ── D-b4 traction: variant A = gate(vol30>0) * (0.65*volume[sat 1000] + 0.35*buyers[sat 100]) ────
function traction(overrides: Partial<ServiceTraction>): ServiceTraction {
  return { ...measured, ...overrides };
}

test("tractionScore: full volume + full buyers saturate to 1.0", () => {
  // volScore = log10(1001)/log10(1001) = 1; buyersScore = log10(101)/log10(101) = 1.
  assert.ok(Math.abs(tractionScore(traction({ volume_usd_30d: 1000, unique_buyers_30d: 100 })) - 1) < 1e-9);
});

test("tractionScore: weights are 0.65 volume / 0.35 buyers", () => {
  // Saturated volume, zero buyers => exactly the volume weight.
  assert.ok(Math.abs(tractionScore(traction({ volume_usd_30d: 1000, unique_buyers_30d: 0 })) - 0.65) < 1e-9);
});

test("tractionScore: the 30d gate zeros a service with no recent volume", () => {
  // vol30 = 0 => gate 0 => whole term 0, even with many buyers (buyers cannot buy a gated-out score).
  assert.equal(tractionScore(traction({ volume_usd_30d: 0, unique_buyers_30d: 100 })), 0);
  assert.equal(tractionScore(traction({ volume_usd_30d: null, unique_buyers_30d: 100 })), 0);
  // Any positive volume opens the gate.
  assert.ok(tractionScore(traction({ volume_usd_30d: 0.01, unique_buyers_30d: 100 })) > 0);
});

test("tractionScore: buyers saturate at 100, not 20 (D-b4 raised the anchor)", () => {
  const at100 = tractionScore(traction({ volume_usd_30d: 1000, unique_buyers_30d: 100 }));
  const at20 = tractionScore(traction({ volume_usd_30d: 1000, unique_buyers_30d: 20 }));
  assert.ok(at100 > at20, "20 buyers no longer saturates the buyer sub-score");
  assert.ok(Math.abs(at100 - 1) < 1e-9);
});

test("tractionScore: recency is a gate, not a score (last_settlement_at does not change the value)", () => {
  const fresh = traction({ volume_usd_30d: 500, unique_buyers_30d: 50, last_settlement_at: new Date().toISOString() });
  const old = traction({ volume_usd_30d: 500, unique_buyers_30d: 50, last_settlement_at: "2020-01-01T00:00:00.000Z" });
  assert.equal(tractionScore(fresh), tractionScore(old));
});

test("tractionScore: monotonic in volume (a diluted pro-quota number scores lower)", () => {
  // Pro-quota division happens upstream; here the smaller (diluted) volume simply scores lower.
  const whole = tractionScore(traction({ volume_usd_30d: 1000, unique_buyers_30d: 40 }));
  const diluted = tractionScore(traction({ volume_usd_30d: 250, unique_buyers_30d: 10 }));
  assert.ok(whole > diluted);
});
