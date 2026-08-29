import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import {
  LUNAROUTE_PROVIDER, buildAttributionHeaders, buildDeviceAuthUrl, buildExchangeBody,
  computePkceChallenge, credentialFingerprint, generatePkceVerifier, generateSessionId,
  generateState, isValidCredentialShape, parseCallbackQuery,
  mapCatalog, mapCatalogEntry, defaultModelId, type MappedModel,
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

describe("catalog mapping", () => {
  it("maps a full reasoning+vision model", () => {
    const r = mapCatalogEntry({ id: "m-1", display_name: "M One", context_window: 200000, max_output_tokens: 32768, capabilities: { reasoning: true, vision: true, tools: false } });
    expect(r).toEqual({ ok: true, model: {
      id: "m-1", name: "M One", reasoning: true, tool_call: false, attachment: true,
      limitContext: 200000, limitOutput: 32768, modalitiesInput: ["text", "image"],
      variants: { low: { reasoningEffort: "low" }, medium: { reasoningEffort: "medium" }, high: { reasoningEffort: "high" } },
    }});
  });
  it("maps defaults: missing name -> id, missing limits -> 128k/4096, tools default true, non-reasoning -> no variants", () => {
    const r = mapCatalogEntry({ id: "m-2" });
    if (!r.ok) throw new Error("expected ok");
    expect(r.model.name).toBe("m-2");
    expect(r.model.tool_call).toBe(true);
    expect(r.model.limitContext).toBe(128000);
    expect(r.model.limitOutput).toBe(4096);
    expect(r.model.variants).toEqual({});
    expect(r.model.modalitiesInput).toEqual(["text"]);
  });
  it("falls back on fractional, negative, zero, string, and beyond-bound limits", () => {
    for (const cw of [1.5, -1, 0, "64", 100_000_001]) {
      const r = mapCatalogEntry({ id: "x", context_window: cw });
      if (!r.ok) throw new Error("expected ok");
      expect(r.model.limitContext).toBe(128000);
    }
    const big = mapCatalogEntry({ id: "x", max_output_tokens: 10_000_001 });
    if (big.ok) expect(big.model.limitOutput).toBe(4096);
  });
  it("accepts large-but-plausible limits as-is", () => {
    const r = mapCatalogEntry({ id: "x", context_window: 100_000_000, max_output_tokens: 10_000_000 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.model.limitContext).toBe(100_000_000);
    expect(r.model.limitOutput).toBe(10_000_000);
  });
  it("rejects non-objects, missing/empty/non-string ids, and non-string display names fall back", () => {
    expect(mapCatalogEntry(null)).toEqual({ ok: false, reason: "not an object" });
    expect(mapCatalogEntry("x")).toEqual({ ok: false, reason: "not an object" });
    expect(mapCatalogEntry({})).toEqual({ ok: false, reason: "missing or invalid id" });
    expect(mapCatalogEntry({ id: 5 })).toEqual({ ok: false, reason: "missing or invalid id" });
    expect(mapCatalogEntry({ id: "" })).toEqual({ ok: false, reason: "missing or invalid id" });
    const r = mapCatalogEntry({ id: "x", display_name: 7 });
    if (!r.ok) throw new Error("expected ok");
    expect(r.model.name).toBe("x");
  });
});

describe("mapCatalog", () => {
  it("first id wins on duplicates; skipped entries recorded with ids and reasons", () => {
    const { models, skipped } = mapCatalog([
      { id: "dup", display_name: "First" }, { id: "dup" }, null,
    ]);
    expect(models).toHaveLength(1);
    expect(models[0].name).toBe("First");
    expect(skipped).toEqual([
      { id: "dup", reason: "duplicate id" },
      { id: "(unidentifiable entry)", reason: "not an object" },
    ]);
  });
});

describe("defaultModelId", () => {
  it("picks the lexicographically smallest mapped id, order-independent", () => {
    const mk = (id: string): MappedModel => ({ id, name: id, reasoning: false, tool_call: true, attachment: false, limitContext: 1, limitOutput: 1, modalitiesInput: ["text"], variants: {} });
    expect(defaultModelId([mk("b"), mk("a"), mk("c")])).toBe("a");
    expect(defaultModelId([mk("b"), mk("a"), mk("a2")])).toBe("a");
  });
  it("returns undefined when empty", () => expect(defaultModelId([])).toBeUndefined());
});
