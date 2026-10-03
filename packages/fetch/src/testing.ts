/**
 * Test-only hooks. NOT exported from the package entry point: tests import this module by
 * relative path. Overrides are ignored unless running under vitest or NODE_ENV=test, so a stray
 * call in production can never loosen the policy.
 */
import type { LookupAddress } from "node:dns";

export interface TestOverrides {
  /** Replaces DNS resolution for non-trusted hostnames (results are still fully validated). */
  resolve?: (hostname: string) => Promise<LookupAddress[]>;
  /** hostname → IP for local test servers; these skip the host and address deny rules. */
  trustedHosts?: ReadonlyMap<string, string>;
  /** Extra ports allowed besides 80/443 (local test servers). */
  extraPorts?: readonly number[];
  /** Nameservers ("ip:port") for the real resolver, e.g. a local fake DNS server. */
  dnsServers?: readonly string[];
}

let overrides: TestOverrides | null = null;

function testEnvironment(): boolean {
  return process.env.VITEST === "true" || process.env.NODE_ENV === "test";
}

/** Install overrides for the current test (pass null to clear). */
export function setTestOverrides(o: TestOverrides | null): void {
  if (!testEnvironment()) throw new Error("@edf/fetch test overrides are only available in tests");
  overrides = o;
}

/** Active overrides, or null outside tests. */
export function testOverrides(): TestOverrides | null {
  return overrides !== null && testEnvironment() ? overrides : null;
}
