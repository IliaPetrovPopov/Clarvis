import { test } from "node:test";
import assert from "node:assert/strict";
import { decideGuard, normalizeTarget, applyGuardToAxes } from "../src/guard.ts";
import type { Profile } from "../src/types.ts";

function profile(overrides: Partial<Profile["data"]> = {}, url = "http://localhost:8100"): Profile {
  return {
    schemaVersion: 1,
    project: { name: "t", root: "/tmp" },
    boot: { url, verified: true },
    auth: { mode: "none", roles: [] },
    data: {
      disposable: true,
      safeTargets: ["localhost:810*"],
      forbiddenHosts: ["203.0.113.10", "*.internal.example", "localhost:800*"],
      ...overrides,
    },
  };
}

test("allows mutation only on a confirmed disposable safe target", () => {
  const d = decideGuard(profile());
  assert.equal(d.mode, "mutating");
  assert.equal(d.matchedSafeTarget, "localhost:810*");
  assert.deepEqual(d.skippedAxes, []);
});

test("falls back to read-only when disposable is not explicitly true", () => {
  for (const value of [false, undefined, null, 0, "true"] as unknown[]) {
    const p = profile({ disposable: value as boolean });
    assert.equal(decideGuard(p).mode, "read-only", `disposable=${JSON.stringify(value)} must not mutate`);
  }
});

test("falls back to read-only when the target matches no safeTarget", () => {
  const d = decideGuard(profile({}, "http://localhost:3000"));
  assert.equal(d.mode, "read-only");
});

test("aborts on a forbidden host even when safeTargets would allow it", () => {
  // The dev stack shares a REMOTE production-ish database. Belt and braces:
  // even if someone widens safeTargets, the deny-list still wins.
  const p = profile({ safeTargets: ["localhost:*"] }, "http://localhost:8002");
  const d = decideGuard(p);
  assert.equal(d.mode, "aborted");
  assert.match(d.reason, /forbidden host/i);
  assert.equal(d.allowedAxes.length, 0);
});

test("aborts on a forbidden host by bare hostname, on any port", () => {
  const d = decideGuard(profile({ safeTargets: ["*"] }, "https://app.internal.example/admin"));
  assert.equal(d.mode, "aborted");
});

test("aborts on the shared remote database host", () => {
  const d = decideGuard(profile({ safeTargets: ["*"] }, "http://203.0.113.10:8002"));
  assert.equal(d.mode, "aborted");
});

test("an unparseable target does not silently pass the deny-list", () => {
  const d = decideGuard(profile({ safeTargets: ["*"] }, "203.0.113.10"));
  assert.equal(d.mode, "aborted");
});

test("wildcards do not leak across path separators", () => {
  assert.equal(normalizeTarget("http://localhost:8100/admin/users"), "localhost:8100");
  assert.equal(normalizeTarget("https://example.com"), "example.com:443");
  assert.equal(normalizeTarget("http://EXAMPLE.com"), "example.com:80");
});

test("read-only mode drops mutating axes and reports them", () => {
  const d = decideGuard(profile({ disposable: false }));
  const { allowed, skipped } = applyGuardToAxes(d, ["happy-path", "i18n-rtl", "rbac-scope"]);
  assert.deepEqual(allowed, ["i18n-rtl"]);
  assert.deepEqual(
    skipped.map((s) => s.axis),
    ["happy-path", "rbac-scope"],
  );
});
