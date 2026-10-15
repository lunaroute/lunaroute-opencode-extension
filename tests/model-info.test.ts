import { describe, it, expect } from "vitest";
import { toModelInfo } from "../src/model-info.js";
import type { MappedModel } from "../src/lunaroute.js";

const base: MappedModel = {
  id: "glm-5.3",
  name: "GLM 5.3",
  reasoning: true,
  tool_call: true,
  attachment: false,
  limitContext: 200_000,
  limitOutput: 16_384,
  modalitiesInput: ["text"],
  variants: {
    low: { reasoningEffort: "low" },
    medium: { reasoningEffort: "medium" },
    high: { reasoningEffort: "high" },
  },
};

describe("toModelInfo", () => {
  it("maps catalog fields onto the v2 Model.Info shape", () => {
    const info = toModelInfo(base, "lunaroute");
    expect(info.id).toBe("glm-5.3");
    expect(info.modelID).toBe("glm-5.3");
    expect(info.providerID).toBe("lunaroute");
    expect(info.name).toBe("GLM 5.3");
    expect(info.limit).toEqual({ context: 200_000, output: 16_384 });
    expect(info.capabilities).toEqual({ tools: true, input: ["text"], output: ["text"] });
    expect(info.status).toBe("active");
    expect(info.enabled).toBe(true);
  });

  it("expresses cost as a tier array with zero prices (gateway pricing)", () => {
    const info = toModelInfo(base, "lunaroute");
    expect(info.cost).toEqual([{ input: 0, output: 0, cache: { read: 0, write: 0 } }]);
  });

  it("maps reasoning variants to [{ id, settings }]", () => {
    const info = toModelInfo(base, "lunaroute");
    expect(info.variants).toEqual([
      { id: "low", settings: { reasoningEffort: "low" } },
      { id: "medium", settings: { reasoningEffort: "medium" } },
      { id: "high", settings: { reasoningEffort: "high" } },
    ]);
  });

  it("drops variants for non-reasoning models", () => {
    const info = toModelInfo({ ...base, reasoning: false, variants: {} }, "lunaroute");
    expect(info.variants).toEqual([]);
  });

  it("passes through vision input modalities and tool_call=false", () => {
    const info = toModelInfo(
      { ...base, attachment: true, modalitiesInput: ["text", "image"], tool_call: false },
      "lunaroute",
    );
    expect(info.capabilities).toEqual({ tools: false, input: ["text", "image"], output: ["text"] });
  });

  it("returns an independent object per call (no shared mutable state)", () => {
    const a = toModelInfo(base, "lunaroute");
    const b = toModelInfo(base, "lunaroute");
    expect(a).not.toBe(b);
    expect(a.limit).not.toBe(b.limit);
    expect(a.capabilities).not.toBe(b.capabilities);
    expect(a.variants).not.toBe(b.variants);
    expect(a.cost).not.toBe(b.cost);
  });
});
