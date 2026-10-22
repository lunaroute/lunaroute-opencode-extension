import { homedir } from "node:os";
// Type-only import: the v2 definition shape is `{ id, setup }` (Plugin.define
// is the identity), so the TUI plugin needs no runtime import of
// @opencode/plugin/tui — which also keeps its solid-js peers out of the CLI
// process, since this plugin renders no JSX.
import type { Plugin as TuiPlugin } from "@opencode/plugin/tui";
import { applySettingChange, readSettings, writeSettings, type SettingsKey } from "./settings.js";
import { PLACEHOLDER_MODEL_ID } from "./lunaroute.js";

/** The five settings rows, with the only UI-specific text (label/summary). */
const ROWS: readonly { key: SettingsKey; label: string; description: string }[] = [
  { key: "mcp", label: "Hosted MCP", description: "LunaRoute MCP server registration" },
  { key: "webTools", label: "Web tools", description: "web_search / web_fetch" },
  { key: "searchProvider", label: "Search provider", description: "Provider passed to web_search" },
  { key: "imageTools", label: "Image tools", description: "generate_image / edit_image / upload_image" },
  { key: "convertTools", label: "Document tools", description: "convert_document" },
];

const REFRESH = "__refresh";

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `/lunaroute` — the v2 CLI plugin (kata 7pd6 / kata 4qqn).
 *
 * v2 TUI plugins run from the package's `./tui` export (loaded automatically
 * from the same opencode.json `plugins` entry as the server plugin; no
 * tui.json) and register commands through a reactive keymap layer. Live apply
 * uses the native `client.location.reload()`: the settings file is written
 * first, then the location reboots and the server plugin re-reads settings
 * inside its transforms. The v1 config-PATCH reload hack is gone.
 */
const definition = {
  id: "lunaroute-tui",
  setup(context: TuiPlugin.Context) {
    context.keymap.layer(() => ({
      mode: "global",
      priority: 10,
      commands: [
        {
          id: "lunaroute.settings",
          title: "LunaRoute settings",
          description: "View and toggle LunaRoute tools; refresh the model catalog",
          group: "LunaRoute",
          palette: true,
          slash: { name: "lunaroute" },
          run: async () => {
            await open(context);
          },
        },
      ],
      bindings: ["lunaroute.settings"],
    }));
  },
} satisfies TuiPlugin.Definition;

export default definition;

type TuiContext = TuiPlugin.Context;

async function open(context: TuiContext): Promise<void> {
  const env = process.env;
  const home = homedir();
  const settings = readSettings(env, home);
  const options = [
    ...ROWS.map((row) => ({
      title: row.label,
      value: row.key as string,
      description: `${row.description} — ${String(settings[row.key])}`,
    })),
    { title: "Refresh models", value: REFRESH, description: "Re-fetch the LunaRoute catalog" },
  ];
  const choice = await context.ui.dialog.select<string>({ title: "LunaRoute", options });
  if (!choice) return;
  if (choice === REFRESH) {
    await refresh(context);
    return;
  }
  await apply(context, choice as SettingsKey);
}

async function apply(context: TuiContext, key: SettingsKey): Promise<void> {
  const env = process.env;
  const home = homedir();
  const next = applySettingChange(readSettings(env, home), key);
  try {
    writeSettings(env, home, next);
  } catch (err) {
    context.ui.toast.show({ variant: "error", title: "LunaRoute", message: `Not saved: ${messageOf(err)}` });
    return;
  }
  try {
    await context.client.location.reload();
    context.ui.toast.show({
      variant: "success",
      title: "LunaRoute",
      message: `${key} = ${String(next[key])} · applied`,
    });
  } catch (err) {
    context.ui.toast.show({ variant: "error", title: "LunaRoute", message: `Saved, but reload failed: ${messageOf(err)}` });
  }
}

async function refresh(context: TuiContext): Promise<void> {
  try {
    await context.client.location.reload();
    const result = await context.client.model.list();
    const models = result?.data ?? [];
    // The failure placeholder is not a model: counting it would report success for the
    // very state this command exists to fix (kata xn2w).
    const count = models.filter((m) => m.providerID === "lunaroute" && m.id !== PLACEHOLDER_MODEL_ID).length;
    if (count === 0) {
      context.ui.toast.show({
        variant: "error",
        title: "LunaRoute",
        message: "Models reloaded — Couldn't load the LunaRoute catalog",
      });
      return;
    }
    context.ui.toast.show({ variant: "success", title: "LunaRoute", message: `Models reloaded — ${count} available` });
  } catch (err) {
    context.ui.toast.show({ variant: "error", title: "LunaRoute", message: `Model refresh failed: ${messageOf(err)}` });
  }
}
