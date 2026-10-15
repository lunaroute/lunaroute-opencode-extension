import { describe, it, expect, vi } from "vitest";
import { fetchCatalog } from "../src/models.js";

describe("fetchCatalog", () => {
  it("fetches with bearer + attribution, maps entries, reports skips", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }, { id: "m-1" }, null] }) });
    const r = await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: fetchMock as never });
    expect(r).toHaveProperty("models");
    if ("models" in r) {
      expect(r.models.map((m) => m.id)).toEqual(["m-1"]);
      expect(r.skipped).toHaveLength(2);
    }
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://gw/v1/models");
    expect(init.headers["Authorization"]).toBe("Bearer lr_k");
    expect(init.headers["lunaroute-agent"]).toBe("opencode");
    expect(init.headers["x-lunaroute-session"]).toBe("sess-1");
  });
  it("returns error on !ok and on fetch failure", async () => {
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }) as never })).toEqual({ error: "HTTP 401" });
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockRejectedValue(new Error("boom")) as never })).toEqual({ error: "boom" });
  });
  it("non-object body -> error", async () => {
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => "nope" }) as never })).toHaveProperty("error");
  });
});
