import { describe, it, expect, vi } from "vitest";
import {
  DEFAULT_SETTINGS,
  SEARCH_PROVIDERS,
  applySettingChange,
  applySettingsViaReload,
  convertToolsEnabled,
  imageToolsEnabled,
  mcpEnabled,
  readSettings,
  resolveSearchProvider,
  resolveSettingsPath,
  saveSettingsAndApply,
  webToolsEnabled,
  writeSettings,
  type SettingsApplyClient,
  type SettingsIo,
} from "../src/settings.js";

const HOME = "/fake/home";
const ENV: NodeJS.ProcessEnv = {};

const noWriteIo = { writeFileSync: () => {}, renameSync: () => {}, randomUUID: () => "uuid" };
const ioReturning = (content: string): SettingsIo => ({ ...noWriteIo, readFileSync: () => content });
const ioThrowing = (code = "ENOENT"): SettingsIo => ({
  ...noWriteIo,
  readFileSync: () => {
    throw Object.assign(new Error(code), { code });
  },
});
const ioRecording = () => {
  const writes: { path: string; data: string }[] = [];
  const renames: [string, string][] = [];
  const io: SettingsIo = {
    ...noWriteIo,
    randomUUID: () => "uuid-1",
    readFileSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFileSync: (path, data) => writes.push({ path, data }),
    renameSync: (from, to) => renames.push([from, to]),
  };
  return { io, writes, renames };
};

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

describe("toggle decisions (f2aj)", () => {
  it("image/convert: env hatch only ever disables (off|0|false); garbage env ignored; file is the knob", () => {
    for (const v of ["off", "0", "false"]) {
      expect(imageToolsEnabled({ LUNAROUTE_IMAGE_TOOLS: v }, DEFAULT_SETTINGS)).toBe(false);
      expect(convertToolsEnabled({ LUNAROUTE_CONVERT_TOOLS: v }, DEFAULT_SETTINGS)).toBe(false);
    }
    expect(imageToolsEnabled({ LUNAROUTE_IMAGE_TOOLS: "on" }, DEFAULT_SETTINGS)).toBe(true);
    expect(convertToolsEnabled({ LUNAROUTE_CONVERT_TOOLS: "yes" }, DEFAULT_SETTINGS)).toBe(true);
    expect(imageToolsEnabled({}, { ...DEFAULT_SETTINGS, imageTools: "off" })).toBe(false);
    expect(convertToolsEnabled({}, { ...DEFAULT_SETTINGS, convertTools: "off" })).toBe(false);
  });
  it("mcp: file-only, no env hatch (pi parity)", () => {
    expect(mcpEnabled(DEFAULT_SETTINGS)).toBe(true);
    expect(mcpEnabled({ ...DEFAULT_SETTINGS, mcp: "off" })).toBe(false);
  });
});

describe("readSettings onInvalid (defaults + warn)", () => {
  it("missing file: silent fallback (no onInvalid)", () => {
    const onInvalid = vi.fn();
    expect(readSettings(ENV, HOME, ioThrowing("ENOENT"), onInvalid)).toEqual(DEFAULT_SETTINGS);
    expect(onInvalid).not.toHaveBeenCalled();
  });
  it("unreadable file: defaults + reason", () => {
    const onInvalid = vi.fn();
    expect(readSettings(ENV, HOME, ioThrowing("EACCES"), onInvalid)).toEqual(DEFAULT_SETTINGS);
    expect(onInvalid).toHaveBeenCalledWith("settings file unreadable (EACCES)");
  });
  it("invalid JSON and non-object: defaults + reason", () => {
    const onInvalid = vi.fn();
    readSettings(ENV, HOME, ioReturning("{oops"), onInvalid);
    expect(onInvalid).toHaveBeenCalledWith("settings file is not valid JSON");
    readSettings(ENV, HOME, ioReturning("[1]"), onInvalid);
    expect(onInvalid).toHaveBeenCalledWith("settings file is not a JSON object");
  });
  it("valid file: no onInvalid", () => {
    const onInvalid = vi.fn();
    readSettings(ENV, HOME, ioReturning(JSON.stringify({ webTools: "off" })), onInvalid);
    expect(onInvalid).not.toHaveBeenCalled();
  });
});

describe("writeSettings (atomic, canonical)", () => {
  it("writes tmp + renames; canonical JSON with trailing newline", () => {
    const { io, writes, renames } = ioRecording();
    const settings = { ...DEFAULT_SETTINGS, webTools: "off" as const };
    writeSettings(ENV, HOME, settings, io);
    const target = resolveSettingsPath(ENV, HOME);
    expect(writes).toHaveLength(1);
    expect(writes[0].path).toBe(`${target}.uuid-1.tmp`);
    expect(writes[0].data).toBe(JSON.stringify(settings, null, 2) + "\n");
    expect(renames).toEqual([[`${target}.uuid-1.tmp`, target]]);
  });
});

describe("applySettingsViaReload (live apply — spike-verified mechanism)", () => {
  const client = (getShape: object, wrapped: boolean) => {
    const update = vi.fn(async () => ({}));
    const c = { config: { get: async () => getShape, update } };
    return { client: c as unknown as Parameters<typeof applySettingsViaReload>[0], update, wrapped };
  };
  it("patched: re-writes the CURRENT model (wrapped shape)", async () => {
    const { client: c, update } = client({ data: { model: "lunaroute/m-1" } }, true);
    await expect(applySettingsViaReload(c)).resolves.toBe("patched");
    expect(update).toHaveBeenCalledWith({ config: { model: "lunaroute/m-1" } });
  });
  it("patched: flat shape", async () => {
    const { client: c, update } = client({ model: "anthropic/x" }, false);
    await expect(applySettingsViaReload(c)).resolves.toBe("patched");
    expect(update).toHaveBeenCalledWith({ config: { model: "anthropic/x" } });
  });
  it("skipped-no-model: nothing idempotent to write, no PATCH", async () => {
    const { client: c, update } = client({}, false);
    await expect(applySettingsViaReload(c)).resolves.toBe("skipped-no-model");
    expect(update).not.toHaveBeenCalled();
  });
});

describe("applySettingChange (kata 7pd6)", () => {
  it("flips each toggle and never mutates the input", () => {
    const base = { ...DEFAULT_SETTINGS };
    for (const key of ["mcp", "webTools", "imageTools", "convertTools"] as const) {
      expect(applySettingChange(base, key)).toEqual({ ...base, [key]: "off" });
      expect(applySettingChange({ ...base, [key]: "off" }, key)).toEqual(base);
    }
    expect(base).toEqual(DEFAULT_SETTINGS);
  });
  it("cycles the search provider through the known list and wraps", () => {
    expect(SEARCH_PROVIDERS).toEqual(["server", "brave", "exa", "kagi"]);
    let s = { ...DEFAULT_SETTINGS };
    for (const expected of ["brave", "exa", "kagi", "server"]) {
      s = applySettingChange(s, "searchProvider");
      expect(s.searchProvider).toBe(expected);
    }
  });
});

describe("saveSettingsAndApply (write-first — kata 7pd6)", () => {
  const events: string[] = [];
  const ioWriting = (): SettingsIo => ({
    randomUUID: () => "uuid",
    readFileSync: () => {
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    },
    writeFileSync: () => void events.push("write"),
    renameSync: () => void events.push("rename"),
  });
  const clientRecording = () => {
    const update = vi.fn(async () => {
      events.push("apply");
      return {};
    });
    const c = { config: { get: async () => ({ data: { model: "m" } }), update } };
    return { client: c as unknown as SettingsApplyClient, update };
  };
  it("writes the file, then triggers the reload — in that order", async () => {
    events.length = 0;
    const { client: c, update } = clientRecording();
    const outcome = await saveSettingsAndApply(ENV, HOME, c, { ...DEFAULT_SETTINGS, webTools: "off" }, ioWriting());
    expect(outcome).toBe("patched");
    expect(events).toEqual(["write", "rename", "apply"]);
    expect(update).toHaveBeenCalledWith({ config: { model: "m" } });
  });
  it("a failed write throws and never triggers the reload", async () => {
    events.length = 0;
    const io: SettingsIo = {
      randomUUID: () => "uuid",
      readFileSync: () => {
        throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      },
      writeFileSync: () => {
        throw Object.assign(new Error("EACCES"), { code: "EACCES" });
      },
      renameSync: () => void events.push("rename"),
    };
    const { client: c, update } = clientRecording();
    await expect(saveSettingsAndApply(ENV, HOME, c, DEFAULT_SETTINGS, io)).rejects.toThrow("EACCES");
    expect(update).not.toHaveBeenCalled();
    expect(events).not.toContain("apply");
  });
});
