import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tui from "../src/tui.js";
import { readSettings } from "../src/settings.js";

type DialogOptions = { options: { value: string }[] };
type Toast = { variant?: string; message: string };
type Command = { id: string; slash: { name: string }; run: () => Promise<void> };

type ListModel = { providerID: string; id?: string };
const DEFAULT_MODELS: ListModel[] = [
  { providerID: "lunaroute", id: "glm-5.3" },
  { providerID: "opencode", id: "beam-free" },
  { providerID: "lunaroute", id: "glm-5.4" },
];

function fakeContext(
  responder: (opts: DialogOptions) => string | undefined,
  models: ListModel[] = DEFAULT_MODELS,
) {
  const commands: Command[] = [];
  const selects: DialogOptions[] = [];
  const toasts: Toast[] = [];
  const reload = vi.fn(async () => {});
  const context = {
    keymap: {
      layer: (factory: () => { commands: Command[] }) => {
        commands.push(...factory().commands);
      },
    },
    ui: {
      dialog: {
        select: async (opts: DialogOptions) => {
          selects.push(opts);
          return responder(opts);
        },
      },
      toast: { show: (toast: Toast) => toasts.push(toast) },
    },
    client: {
      location: { reload },
      model: {
        list: async () => ({ data: models }),
      },
    },
  };
  return { context, commands, selects, toasts, reload };
}

describe("/lunaroute v2 TUI plugin", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "lunaroute-tui-"));
    mkdirSync(join(dir, "opencode"), { recursive: true });
    vi.stubEnv("XDG_DATA_HOME", dir);
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("registers a /lunaroute slash command", async () => {
    const { context, commands } = fakeContext(() => undefined);
    await tui.setup(context as never);

    expect(commands).toHaveLength(1);
    expect(commands[0].slash.name).toBe("lunaroute");
  });

  it("offers the five settings rows plus Refresh models", async () => {
    const { context, commands, selects } = fakeContext(() => undefined);
    await tui.setup(context as never);
    await commands[0].run();

    expect(selects[0].options.map((o) => o.value)).toEqual([
      "mcp",
      "webTools",
      "searchProvider",
      "imageTools",
      "convertTools",
      "__refresh",
    ]);
  });

  it("toggle: writes the settings file first, then reloads and toasts", async () => {
    const { context, commands, toasts, reload } = fakeContext(() => "mcp");
    await tui.setup(context as never);
    await commands[0].run();

    expect(readSettings(process.env, "").mcp).toBe("off");
    expect(reload).toHaveBeenCalledTimes(1);
    expect(toasts.at(-1)).toMatchObject({ variant: "success" });
    expect(String(toasts.at(-1)?.message)).toContain("mcp = off");
  });

  it("write failure: error toast and no reload", async () => {
    const file = join(dir, "not-a-directory");
    writeFileSync(file, "");
    vi.stubEnv("XDG_DATA_HOME", file);

    const { context, commands, toasts, reload } = fakeContext(() => "mcp");
    await tui.setup(context as never);
    await commands[0].run();

    expect(reload).not.toHaveBeenCalled();
    expect(toasts.at(-1)).toMatchObject({ variant: "error" });
  });

  it("refresh: reloads and reports the catalog size", async () => {
    const { context, commands, toasts, reload } = fakeContext(() => "__refresh");
    await tui.setup(context as never);
    await commands[0].run();

    expect(reload).toHaveBeenCalledTimes(1);
    expect(String(toasts.at(-1)?.message)).toBe("Models reloaded — 2 available");
  });

  it("refresh: reports a failure when only the placeholder came back", async () => {
    const { context, commands, toasts } = fakeContext(() => "__refresh", [{ providerID: "lunaroute", id: "login" }]);
    await tui.setup(context as never);
    await commands[0].run();

    expect(toasts.at(-1)).toMatchObject({ variant: "error" });
    expect(String(toasts.at(-1)?.message)).toContain("Couldn't load");
  });

  it("cancelled selection does nothing", async () => {
    const { context, commands, toasts, reload } = fakeContext(() => undefined);
    await tui.setup(context as never);
    await commands[0].run();

    expect(reload).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });
});
