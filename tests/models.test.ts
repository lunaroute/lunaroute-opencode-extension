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
    const sleep = vi.fn(async (_ms: number) => {});
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", {
      fetch: vi.fn().mockResolvedValue({ ok: false, status: 401 }) as never, sleep,
    })).toEqual({ error: "HTTP 401" });
    const flaky = vi.fn().mockRejectedValue(new Error("boom"));
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: flaky as never, sleep }))
      .toEqual({ error: "boom" });
    expect(flaky).toHaveBeenCalledTimes(2);
  });
  it("non-object body -> error", async () => {
    expect(await fetchCatalog("http://gw/v1", "lr_k", "sess-1", { fetch: vi.fn().mockResolvedValue({ ok: true, json: async () => "nope" }) as never })).toHaveProperty("error");
  });
});

describe("fetchCatalog retry", () => {
  it("retries once after a transport failure, then returns the catalog", async () => {
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new Error("ECONNREFUSED"))
      .mockResolvedValue({ ok: true, json: async () => ({ data: [{ id: "m-1" }] }) });
    const sleep = vi.fn(async (_ms: number) => {});
    const r = await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: fetchMock as never, sleep });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(sleep).toHaveBeenCalledTimes(1);
    expect(sleep).toHaveBeenCalledWith(1000);
    expect("models" in r && r.models.map((m) => m.id)).toEqual(["m-1"]);
  });

  it("retries 5xx and 429, then gives up with the last status", async () => {
    const sleep = vi.fn(async () => {});
    const s503 = vi.fn().mockResolvedValue({ ok: false, status: 503 });
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: s503 as never, sleep }))
      .toEqual({ error: "HTTP 503" });
    expect(s503).toHaveBeenCalledTimes(2);
    const s429 = vi.fn().mockResolvedValue({ ok: false, status: 429 });
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: s429 as never, sleep }))
      .toEqual({ error: "HTTP 429" });
    expect(s429).toHaveBeenCalledTimes(2);
  });

  it("does not retry 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: false, status: 401 });
    const sleep = vi.fn(async () => {});
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: fetchMock as never, sleep }))
      .toEqual({ error: "HTTP 401" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });

  it("does not retry a body that fails to parse", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => { throw new SyntaxError("Unexpected token <"); },
    });
    const sleep = vi.fn(async () => {});
    expect(await fetchCatalog("http://gw/v1", "lr_k", "s1", { fetch: fetchMock as never, sleep }))
      .toEqual({ error: "malformed catalog body" });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(sleep).not.toHaveBeenCalled();
  });
});
