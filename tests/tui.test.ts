import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import tui from "../src/tui.js";
import { readSettings } from "../src/settings.js";

type DialogOptions = { options: { value: string; description?: string }[] };
type Toast = { variant?: string; message: string };
type Command = { id: string; slash: { name: string }; run: (input?: string) => Promise<void> };
type PromptOptions = { title: string; description?: string; placeholder?: string; value?: string };

type ListModel = { providerID: string; id?: string };
const DEFAULT_MODELS: ListModel[] = [
  { providerID: "lunaroute", id: "glm-5.3" },
  { providerID: "opencode", id: "beam-free" },
  { providerID: "lunaroute", id: "glm-5.4" },
];

function fakeContext(
  responder: (opts: DialogOptions) => string | undefined,
  models: ListModel[] = DEFAULT_MODELS,
  over: { prompt?: (opts: PromptOptions) => string | undefined; location?: { directory: string } } = {},
) {
  const commands: Command[] = [];
  const selects: DialogOptions[] = [];
  const prompts: PromptOptions[] = [];
  const toasts: Toast[] = [];
  const reload = vi.fn(async () => {});
  const context = {
    location: over.location,
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
        prompt: async (opts: PromptOptions) => {
          prompts.push(opts);
          return over.prompt?.(opts);
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
  return { context, commands, selects, prompts, toasts, reload };
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
      "__project",
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

  describe("project attribution (kata zarw)", () => {
    let repo: string;
    const file = () => join(repo, ".lunaroute.json");
    const at = (
      responder: (opts: DialogOptions) => string | undefined,
      over: { prompt?: (opts: PromptOptions) => string | undefined } = {},
    ) => fakeContext(responder, DEFAULT_MODELS, { location: { directory: repo }, ...over });

    beforeEach(() => {
      repo = join(dir, "repo");
      mkdirSync(join(repo, ".git"), { recursive: true });
    });

    it("writes the name from the slash argument, then reloads", async () => {
      const { context, commands, toasts, reload } = at(() => undefined);
      await tui.setup(context as never);
      await commands[0].run("project lunaroute-web");

      expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ project: "lunaroute-web" });
      expect(reload).toHaveBeenCalledTimes(1);
      expect(toasts.at(-1)).toMatchObject({ variant: "success" });
      expect(String(toasts.at(-1)?.message)).toContain(file());
    });

    it("pre-fills the current value on a bare project", async () => {
      writeFileSync(file(), '{"project":"lunaroute-web"}\n');
      const { context, commands, prompts, reload } = at(() => undefined, { prompt: () => "lunaroute-api" });
      await tui.setup(context as never);
      await commands[0].run("project");

      expect(prompts[0].value).toBe("lunaroute-web");
      expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({ project: "lunaroute-api" });
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("pre-fills the folder name when nothing is set", async () => {
      const { context, commands, prompts } = at(() => undefined, { prompt: () => undefined });
      await tui.setup(context as never);
      await commands[0].run("project");

      expect(prompts[0].value).toBe("repo");
    });

    it("writes nothing when the prompt is cancelled", async () => {
      const { context, commands, reload } = at(() => undefined, { prompt: () => undefined });
      await tui.setup(context as never);
      await commands[0].run("project");

      expect(existsSync(file())).toBe(false);
      expect(reload).not.toHaveBeenCalled();
    });

    it("clear empties an existing file", async () => {
      writeFileSync(file(), '{"project":"lunaroute-web"}\n');
      const { context, commands, reload } = at(() => undefined);
      await tui.setup(context as never);
      await commands[0].run("project clear");

      expect(JSON.parse(readFileSync(file(), "utf8"))).toEqual({});
      expect(reload).toHaveBeenCalledTimes(1);
    });

    it("clear with no file touches nothing", async () => {
      const { context, commands, toasts, reload } = at(() => undefined);
      await tui.setup(context as never);
      await commands[0].run("project off");

      expect(existsSync(file())).toBe(false);
      expect(reload).not.toHaveBeenCalled();
      expect(String(toasts.at(-1)?.message)).toContain("No LunaRoute project set");
    });

    it("refuses an invalid name with the reason and writes nothing", async () => {
      const { context, commands, toasts } = at(() => undefined);
      await tui.setup(context as never);
      await commands[0].run("project {x}");
      await commands[0].run(`project ${"a".repeat(129)}`);

      expect(existsSync(file())).toBe(false);
      const errors = toasts.filter((t) => t.variant === "error");
      expect(errors).toHaveLength(2);
      expect(String(errors[0].message)).toContain("{");
    });

    it("toasts instead of guessing without a workspace location", async () => {
      const { context, commands, toasts } = fakeContext(() => undefined);
      await tui.setup(context as never);
      await commands[0].run("project lunaroute-web");

      expect(toasts.at(-1)).toMatchObject({ variant: "error" });
      expect(String(toasts.at(-1)?.message)).toContain("Cannot determine");
    });

    it("menu row reports the effective value", async () => {
      writeFileSync(file(), '{"project":"lunaroute-web"}\n');
      const { context, commands, selects } = at(() => undefined);
      await tui.setup(context as never);
      await commands[0].run();

      expect(String(selects[0].options[0].description)).toContain("lunaroute-web");
    });

    it("menu row reports none after a clear, not a corrupt file", async () => {
      writeFileSync(file(), '{"project":"lunaroute-web"}\n');
      const { context, commands, selects } = at(() => undefined);
      await tui.setup(context as never);
      await commands[0].run("project clear");
      selects.length = 0;
      await commands[0].run();

      expect(String(selects[0].options[0].description)).toContain("(none)");
      expect(String(selects[0].options[0].description)).not.toContain("invalid");
    });

    it("menu row reports an unreadable file distinctly from none", async () => {
      writeFileSync(file(), "{oops");
      const { context, commands, selects } = at(() => undefined);
      await tui.setup(context as never);
      await commands[0].run();

      expect(String(selects[0].options[0].description)).toContain(`(invalid file at ${file()})`);
    });

    it("bare /lunaroute still opens the settings dialog", async () => {
      const { context, commands, prompts, selects } = at(() => undefined);
      await tui.setup(context as never);
      await commands[0].run(undefined);

      expect(selects).toHaveLength(1);
      expect(prompts).toEqual([]);
    });
  });

  it("cancelled selection does nothing", async () => {
    const { context, commands, toasts, reload } = fakeContext(() => undefined);
    await tui.setup(context as never);
    await commands[0].run();

    expect(reload).not.toHaveBeenCalled();
    expect(toasts).toEqual([]);
  });
});
