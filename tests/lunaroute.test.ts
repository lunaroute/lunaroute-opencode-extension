import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  LUNAROUTE_PROVIDER, buildAttributionHeaders, buildDeviceAuthUrl, buildExchangeBody,
  computePkceChallenge, credentialFingerprint, generatePkceVerifier, generateSessionId,
  generateState, isValidCredentialShape, parseCallbackQuery,
} from "../src/lunaroute.js";

describe("env resolvers + defaults", () => {
  it("builds the device-auth URL for opencode", () => {
    expect(buildDeviceAuthUrl("https://app.lunaroute.com", 39999, "st-1", "ch-1"))
      .toBe("https://app.lunaroute.com/device-auth/opencode?port=39999&state=st-1&challenge=ch-1");
  });
});

describe("PKCE", () => {
  it("verifier is 64 hex chars; challenge is hex sha256 of verifier", () => {
    const v = generatePkceVerifier();
    expect(v).toMatch(/^[0-9a-f]{64}$/);
    expect(computePkceChallenge(v)).toBe(createHash("sha256").update(v).digest("hex"));
  });
  it("state is 32 hex chars", () => expect(generateState()).toMatch(/^[0-9a-f]{32}$/));
});

describe("callback parsing", () => {
  it("parses code and state, tolerating a base URL", () => {
    expect(parseCallbackQuery("http://127.0.0.1:1/callback?code=c%2Fx&state=s"))
      .toEqual({ code: "c/x", state: "s" });
    expect(parseCallbackQuery("/callback?code=&state=")).toEqual({ code: "", state: "" });
  });
});

describe("exchange", () => {
  it("serializes code, verifier, and label", () => {
    expect(JSON.parse(buildExchangeBody({ code: "c", verifier: "v", label: "host-1" })))
      .toEqual({ code: "c", verifier: "v", label: "host-1" });
  });
});

describe("attribution", () => {
  it("uses the bare opencode agent plus both session headers", () => {
    expect(buildAttributionHeaders("uuid-1")).toEqual({
      "lunaroute-agent": "opencode",
      "x-lunaroute-session": "uuid-1",
      "lunaroute-session-id": "uuid-1",
    });
  });
  it("generateSessionId falls back when randomUUID throws", () => {
    const id = generateSessionId(() => { throw new Error("no crypto"); }, () => 123, () => 0.5);
    expect(id).toMatch(/^lunaroute-opencode-123-/);
  });
});

describe("credential shape", () => {
  it("accepts printable ASCII up to 512 chars", () => {
    expect(isValidCredentialShape("lr_good")).toBe(true);
    expect(isValidCredentialShape("x".repeat(512))).toBe(true);
  });
  it("rejects empty, oversize, non-string, control chars, unicode", () => {
    expect(isValidCredentialShape("")).toBe(false);
    expect(isValidCredentialShape("x".repeat(513))).toBe(false);
    expect(isValidCredentialShape(42)).toBe(false);
    expect(isValidCredentialShape("bad\nkey")).toBe(false);
    expect(isValidCredentialShape("ключ")).toBe(false);
  });
});

describe("fingerprint", () => {
  it("is hex sha256 of UTF-8 key bytes", () => {
    expect(credentialFingerprint("lr_good"))
      .toBe(createHash("sha256").update("lr_good", "utf8").digest("hex"));
  });
});

describe("provider id", () => {
  it("is lunaroute", () => expect(LUNAROUTE_PROVIDER).toBe("lunaroute"));
});
