import { homedir } from "node:os";
import type { TuiDialogSelectOption, TuiPlugin, TuiPluginModule } from "@opencode-ai/plugin/tui";
import {
  applySettingChange,
  readSettings,
  saveSettingsAndApply,
  type SettingsApplyClient,
  type SettingsApplyOutcome,
  type SettingsKey,
} from "./settings.js";

/** The five settings rows, with the only UI-specific text (label/summary). */
const ROWS: readonly { key: SettingsKey; label: string; description: string }[] = [
  { key: "mcp", label: "Hosted MCP", description: "LunaRoute MCP server registration" },
  { key: "webTools", label: "Web tools", description: "web_search / web_fetch" },
  { key: "searchProvider", label: "Search provider", description: "Provider passed to web_search" },
  { key: "imageTools", label: "Image tools", description: "generate_image / edit_image / upload_image" },
  { key: "convertTools", label: "Document tools", description: "convert_document" },
];

const messageOf = (err: unknown): string => (err instanceof Error ? err.message : String(err));

/**
 * `/lunaroute` — the TUI settings command (kata 7pd6, pi bjy9 parity).
 *
 * Runs in the TUI process, outside the prompt loop (a server-plugin slash
 * command is a prompt command and would spend a model turn). Write-first: a
 * toggle persists the file, then triggers the instance reload
 * (phase 1, spike-verified — docs/settings-live-apply-spike.md). A failed
 * write never triggers a reload and surfaces an error toast.
 *
 * Loading/packaging: a TUI plugin is declared in `tui.json` (`plugin` array)
 * and a package exposes it via `exports["./tui"]` with a default export
 * `{ id, tui }` — see docs/tui-plugin-loading-spike.md.
 */
const tui: TuiPlugin = async (api) => {
  const env = process.env;
  const home = homedir();
  const client = api.client as unknown as SettingsApplyClient;

  const open = () => {
    const settings = readSettings(env, home);
    const options: TuiDialogSelectOption<SettingsKey>[] = ROWS.map((row) => ({
      title: row.label,
      value: row.key,
      description: `${row.description} — ${String(settings[row.key])}`,
    }));
    api.ui.dialog.replace(() =>
      api.ui.DialogSelect<SettingsKey>({
        title: "LunaRoute settings",
        skipFilter: true,
        options,
        onSelect: (option) => void apply(option.value),
      }),
    );
  };

  const apply = async (key: SettingsKey) => {
    const next = applySettingChange(readSettings(env, home), key);
    let outcome: SettingsApplyOutcome;
    try {
      outcome = await saveSettingsAndApply(env, home, client, next);
    } catch (err) {
      api.ui.toast({ variant: "error", title: "LunaRoute", message: `Not saved: ${messageOf(err)}` });
      return;
    }
    api.ui.toast({
      variant: "success",
      title: "LunaRoute",
      message: `${key} = ${String(next[key])} · ${outcome === "patched" ? "applied live" : "saved; applies on next open"}`,
    });
    open();
  };

  // Legacy v1 command API (kept and typed for v1 plugins); the v2 migration is
  // api.keymap.registerLayer({ commands: [{ slashName: "lunaroute", run }] }).
  api.command?.register(() => [
    {
      title: "LunaRoute settings",
      value: "lunaroute.settings",
      description: "View and toggle LunaRoute tools (live apply)",
      slash: { name: "lunaroute" },
      onSelect: () => open(),
    },
  ]);
};

export default { id: "lunaroute-tui", tui } satisfies TuiPluginModule;
