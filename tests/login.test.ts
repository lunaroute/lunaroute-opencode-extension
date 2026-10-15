import { describe, it, expect, vi } from "vitest";
import { createServer } from "node:http";
import { exchangeCode, extractPastedLogin, startLoopbackServer, type LoopbackServer } from "../src/login.js";
import type { ExchangeResponse } from "../src/lunaroute.js";

const goodExchange: ExchangeResponse = { full_key: "lr_new", org_id: "org-1", user_email: "a@b.com" };

describe("loopback server", () => {
  it("serves /callback, resolves once, ignores repeat callbacks", async () => {
    const server = await startLoopbackServer();
    const res1 = await fetch(`http://127.0.0.1:${server.port}/callback?code=c&state=s`);
    expect(res1.status).toBe(200);
    // kata y992: the approval page verifies delivery via cors fetch + res.ok.
    expect(res1.headers.get("access-control-allow-origin")).toBe("*");
    await fetch(`http://127.0.0.1:${server.port}/callback?code=c2&state=s2`); // resolves a settled promise: no-op
    expect(await server.waitForCallback()).toEqual({ code: "c", state: "s" });
    server.close();
  });
  it("404s non-callback paths", async () => {
    const server = await startLoopbackServer();
    const res = await fetch(`http://127.0.0.1:${server.port}/nope`);
    expect(res.status).toBe(404);
    server.close();
  });
});

describe("exchangeCode", () => {
  it("posts code+verifier+label to /v1/auth/exchange and returns the key", async () => {
    const srv = createServer((req, res) => {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        expect(req.method).toBe("POST");
        expect(req.url).toBe("/v1/auth/exchange");
        expect(JSON.parse(body)).toEqual({ code: "c", verifier: "v", label: "h" });
        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify(goodExchange));
      });
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    const r = await exchangeCode(`http://127.0.0.1:${port}`, { code: "c", verifier: "v", label: "h" });
    expect(r.full_key).toBe("lr_new");
    srv.close();
  });
  it("throws a descriptive error on failure", async () => {
    const srv = createServer((req, res) => {
      res.statusCode = 401;
      res.end(JSON.stringify({ error: { code: "INVALID_CODE", message: "bad code" } }));
    });
    await new Promise<void>((r) => srv.listen(0, "127.0.0.1", r));
    const port = (srv.address() as { port: number }).port;
    await expect(
      exchangeCode(`http://127.0.0.1:${port}`, { code: "c", verifier: "v", label: "h" }),
    ).rejects.toThrow(/INVALID_CODE/);
    srv.close();
  });
});

describe("extractPastedLogin (pure paste ladder, kata dw0g)", () => {
  it("accepts curl single/double-quoted and bare URLs", () => {
    expect(extractPastedLogin("curl 'http://127.0.0.1:45117/callback?code=a&state=s'", "s")).toEqual({ ok: true, code: "a" });
    expect(extractPastedLogin('curl "http://127.0.0.1:45117/callback?code=b&state=s"', "s")).toEqual({ ok: true, code: "b" });
    expect(extractPastedLogin("http://127.0.0.1:45117/callback?code=c&state=s", "s")).toEqual({ ok: true, code: "c" });
  });
  it("accepts a bare query string and a bare code (padding allowed)", () => {
    expect(extractPastedLogin("code=d&state=s", "s")).toEqual({ ok: true, code: "d" });
    expect(extractPastedLogin("?code=e&state=s", "s")).toEqual({ ok: true, code: "e" });
    expect(extractPastedLogin("abc=", "s")).toEqual({ ok: true, code: "abc=" });
  });
  it("rejects empty, junk, and state mismatch", () => {
    expect(extractPastedLogin("", "s")).toEqual({ ok: false, reason: "nothing pasted" });
    expect(extractPastedLogin("not a code !!", "s")).toEqual({ ok: false, reason: "no code found in paste" });
    expect(extractPastedLogin("http://x/callback?code=a&state=wrong", "s")).toEqual({ ok: false, reason: "state mismatch" });
  });
});
