import { describe, it, expect } from "vitest";
import { PACKAGE_COMPLETIONS, PACKAGE_RESPONSES, resolveWire } from "../src/wire.js";

describe("resolveWire", () => {
  it("defaults to the Responses protocol", () => {
    expect(resolveWire({})).toEqual({ package: PACKAGE_RESPONSES });
    expect(resolveWire({ LUNAROUTE_API: "" })).toEqual({ package: PACKAGE_RESPONSES });
    expect(resolveWire({ LUNAROUTE_API: "   " })).toEqual({ package: PACKAGE_RESPONSES });
  });

  it("accepts responses and completions case-insensitively, trimmed", () => {
    expect(resolveWire({ LUNAROUTE_API: "responses" })).toEqual({ package: PACKAGE_RESPONSES });
    expect(resolveWire({ LUNAROUTE_API: "  RESPONSES  " })).toEqual({ package: PACKAGE_RESPONSES });
    expect(resolveWire({ LUNAROUTE_API: "completions" })).toEqual({ package: PACKAGE_COMPLETIONS });
    expect(resolveWire({ LUNAROUTE_API: "Completions" })).toEqual({ package: PACKAGE_COMPLETIONS });
  });

  it("fails toward completions with a warning on an unrecognized value", () => {
    const r = resolveWire({ LUNAROUTE_API: "chat" });
    expect(r.package).toBe(PACKAGE_COMPLETIONS);
    expect(r.warning).toContain("LUNAROUTE_API");
    expect(r.warning).toContain("chat");
  });
});
