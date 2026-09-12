import { describe, it, expect } from "vitest";
import type { TuiPluginApi, TuiPluginMeta } from "@opencode-ai/plugin/tui";
import tuiModule from "../src/tui.js";

/** Minimal TuiPluginApi: capture registered commands and the props the command
 * renders into the dialog stack. Nothing here touches the real filesystem —
 * the command's open() only reads settings (ENOENT → defaults under the temp
 * XDG_DATA_HOME set below). */
const fakeApi = () => {
  const commands: { title: string; value: string; slash: { name: string }; onSelect?: () => void }[] = [];
  let rendered: { title: string; options: { value: string; description?: string }[] } | undefined;
  const api = {
    command: {
      register: (cb: () => typeof commands) => {
        commands.push(...cb());
        return () => {};
      },
    },
    ui: {
      DialogSelect: (props: typeof rendered) => props,
      dialog: {
        replace: (render: () => typeof rendered) => {
          rendered = render();
        },
      },
      toast: () => {},
    },
    client: { config: { get: async () => ({ data: { model: "m" } }), update: async () => ({}) } },
  };
  return { api: api as unknown as TuiPluginApi, commands, rendered: () => rendered };
};

describe("/lunaroute TUI plugin module (kata 7pd6)", () => {
  it("default export is the { id, tui } object form the loader requires", () => {
    expect(tuiModule.id).toBe("lunaroute-tui");
    expect(typeof tuiModule.tui).toBe("function");
    expect("server" in tuiModule).toBe(false);
  });

  it("registers a /lunaroute slash command that opens the settings list", async () => {
    process.env.XDG_DATA_HOME = "/nonexistent-lunaroute-test";
    const { api, commands, rendered } = fakeApi();
    await tuiModule.tui(api, undefined, {} as TuiPluginMeta);

    expect(commands).toHaveLength(1);
    const [command] = commands;
    expect(command!.slash.name).toBe("lunaroute");
    expect(command!.value).toBe("lunaroute.settings");

    command!.onSelect!();
    const props = rendered()!;
    expect(props.title).toBe("LunaRoute settings");
    expect(props.options.map((o) => o.value)).toEqual(["mcp", "webTools", "searchProvider", "imageTools", "convertTools"]);
  });
});
