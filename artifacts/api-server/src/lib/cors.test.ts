import assert from "node:assert/strict";
import { describe, test } from "node:test";
import { isTrustedOrigin, trustedOrigins } from "./cors";

describe("credentialed CORS origins", () => {
  const environment = {
    CORS_ALLOWED_ORIGINS: "https://relay.example.com",
    REPLIT_DOMAINS: "relay.example.com",
    REPLIT_DEV_DOMAIN: "relay-dev.replit.dev",
  };

  test("accepts configured production and Replit development origins", () => {
    assert.equal(isTrustedOrigin("https://relay.example.com", environment), true);
    assert.equal(isTrustedOrigin("https://relay-dev.replit.dev", environment), true);
  });

  test("rejects origins that are not explicitly configured", () => {
    assert.equal(isTrustedOrigin("https://attacker.example", environment), false);
    assert.equal(isTrustedOrigin("https://relay.example.com.attacker.example", environment), false);
  });

  test("does not turn malformed configuration into a trusted origin", () => {
    assert.deepEqual(
      trustedOrigins({ CORS_ALLOWED_ORIGINS: "not an origin,https://good.example/path" }),
      new Set(),
    );
  });
});