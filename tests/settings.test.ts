import { describe, it, expect } from "vitest";
import {
  DEFAULT_SETTINGS,
  readSettings,
  resolveSearchProvider,
  resolveSettingsPath,
  webToolsEnabled,
  type SettingsIo,
} from "../src/settings.js";

const HOME = "/fake/home";
const ENV: NodeJS.ProcessEnv = {};

const ioReturning = (content: string): SettingsIo => ({ readFileSync: () => content });
const ioThrowing = (code = "ENOENT"): SettingsIo => ({
  readFileSync: () => {
    throw Object.assign(new Error(code), { code });
  },
});

describe("resolveSettingsPath", () => {
  it("defaults to <home>/.local/share/opencode/lunaroute.json (next to the auth store)", () => {
    expect(resolveSettingsPath({}, HOME)).toBe(`${HOME}/.local/share/opencode/lunaroute.json`);
  });
  it("honors XDG_DATA_HOME", () => {
    expect(resolveSettingsPath({ XDG_DATA_HOME: "/xdg" }, HOME)).toBe("/xdg/opencode/lunaroute.json");
  });
});

describe("readSettings", () => {
  it("missing file → defaults (equals pre-settings behavior)", () => {
    expect(readSettings(ENV, HOME, ioThrowing())).toEqual(DEFAULT_SETTINGS);
  });
  it("unreadable file → defaults", () => {
    expect(readSettings(ENV, HOME, ioThrowing("EACCES"))).toEqual(DEFAULT_SETTINGS);
  });
  it("invalid JSON → defaults", () => {
    expect(readSettings(ENV, HOME, ioReturning("{oops"))).toEqual(DEFAULT_SETTINGS);
  });
  it("non-object (array/null) → defaults", () => {
    expect(readSettings(ENV, HOME, ioReturning("[1,2]"))).toEqual(DEFAULT_SETTINGS);
    expect(readSettings(ENV, HOME, ioReturning("null"))).toEqual(DEFAULT_SETTINGS);
  });
  it("invalid values fall back per key; extra keys ignored", () => {
    const s = readSettings(
      ENV,
      HOME,
      ioReturning(JSON.stringify({ webTools: "off", mcp: 42, searchProvider: "yahoo", extra: true })),
    );
    expect(s).toEqual({ ...DEFAULT_SETTINGS, webTools: "off" });
  });
  it("full valid file round-trips", () => {
    const s = readSettings(
      ENV,
      HOME,
      ioReturning(JSON.stringify({ mcp: "off", webTools: "on", searchProvider: "kagi", imageTools: "off", convertTools: "on" })),
    );
    expect(s).toEqual({ mcp: "off", webTools: "on", searchProvider: "kagi", imageTools: "off", convertTools: "on" });
  });
});

describe("webToolsEnabled", () => {
  it("defaults on", () => {
    expect(webToolsEnabled({}, DEFAULT_SETTINGS)).toBe(true);
  });
  it("env escape hatch only ever disables (off|0|false)", () => {
    for (const v of ["off", "0", "false"]) {
      expect(webToolsEnabled({ LUNAROUTE_WEB_TOOLS: v }, DEFAULT_SETTINGS)).toBe(false);
    }
  });
  it("env garbage does not disable; the file is the user knob", () => {
    expect(webToolsEnabled({ LUNAROUTE_WEB_TOOLS: "on" }, DEFAULT_SETTINGS)).toBe(true);
    expect(webToolsEnabled({ LUNAROUTE_WEB_TOOLS: "on" }, { ...DEFAULT_SETTINGS, webTools: "off" })).toBe(false);
    expect(webToolsEnabled({}, { ...DEFAULT_SETTINGS, webTools: "off" })).toBe(false);
  });
});

describe("resolveSearchProvider", () => {
  it("server → undefined (omit the provider key on the wire)", () => {
    expect(resolveSearchProvider(DEFAULT_SETTINGS)).toBeUndefined();
  });
  it("concrete providers pass through", () => {
    expect(resolveSearchProvider({ ...DEFAULT_SETTINGS, searchProvider: "brave" })).toBe("brave");
    expect(resolveSearchProvider({ ...DEFAULT_SETTINGS, searchProvider: "exa" })).toBe("exa");
    expect(resolveSearchProvider({ ...DEFAULT_SETTINGS, searchProvider: "kagi" })).toBe("kagi");
  });
});
