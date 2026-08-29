# LunaRoute for OpenCode

Use LunaRoute from [OpenCode](https://opencode.ai) in under a minute: log in,
and every LunaRoute model shows up automatically — correctly configured and
ready to use. No hand-editing of `opencode.json`, no copying API keys around.
The hosted LunaRoute MCP server (image generation and more) is wired up for
you too.

## Why

- **Zero-config models.** LunaRoute's model catalog is synced into OpenCode
  automatically — context windows, token limits, reasoning, and vision
  capabilities all come through pre-mapped. Run `/models` and pick a
  `lunaroute/*` model. The catalog is fetched when OpenCode loads your
  config, so new models appear after a restart (or a new login) as soon
  as they ship.
- **Login that doesn't leak keys.** Browser-based login (PKCE) issues a fresh
  `lr_` key and stores it in `~/.local/share/opencode/auth.json` — OpenCode's
  own credential store. The plugin never writes your key to any other file.
  Prefer a key you already have? Paste it (it's validated against the gateway
  before it's accepted).
- **LunaRoute MCP built in.** When you're logged in, the hosted LunaRoute MCP
  server is registered in your live session config so tools like
  `generate_image` are callable from OpenCode. Nothing is written to your
  config files.
- **Attribution on every request.** Each LunaRoute request carries a
  per-session agent + session id so traffic is traceable on the LunaRoute
  side.

## Requirements

- OpenCode **>= 1.14.49**.
- A LunaRoute account with access to at least one organization.
- Linux or macOS. (Windows is untested and unsupported in v1.)

## Quick start

Add the plugin to your `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": ["@lunaroute/opencode-extension"]
}
```

Then in OpenCode:

```
/connect
```

Choose **LunaRoute**, then **Log in with browser** (a browser opens to
`https://app.lunaroute.com/device-auth/opencode`; after you approve, an API
key is issued and stored) or **Paste an API key** (paste an existing `lr_...`
key). After login, the first LunaRoute model is picked as your default —
run `/models` only if you want to choose a different one.

## LunaRoute MCP tools

When you are logged in, the extension registers the hosted LunaRoute MCP
server (`https://mcp.lunaroute.com/mcp`) in the **live session config** —
tools (in v1: `generate_image`) become callable from OpenCode. The entry
exists only in memory for the session: **it is never written to
`opencode.json` or any other config file**, and your `lr_` key is never
persisted anywhere outside OpenCode's own auth store.

- **Logged out**: no registration occurs (silent). Log in with `/connect`.
- **After login or key rotation**: MCP refreshes automatically when the
  instance reloads (the reload that follows the post-login default-model
  update); a new key is picked up on the next instance without a process
  restart. Restarting also works, but is not required.

### MCP entry management

The plugin recognizes its own `mcp.lunaroute` entry by its shape (`remote` +
the LunaRoute MCP URL + the expected headers). Two consequences:

- If you hand-write a `mcp.lunaroute` entry that matches that shape, the
  plugin treats it as its own and **refreshes its header values** (credential
  + attribution) whenever you're logged in.
- To keep OpenCode from managing an entry, make it *diverge* — set
  `"enabled": false` (keeps the entry but stops the plugin from touching it)
  or point it at a different URL. Adding extra headers is **not** recommended
  as an opt-out: they would be forwarded to the MCP server.

A `mcp.lunaroute` entry that doesn't match the plugin's shape is always left
untouched.

## Configuration

The gateway, API, and front URLs default to production and are overridable
for dev/staging via environment variables before starting OpenCode:

| Variable | Default | Purpose |
|---|---|---|
| `LUNAROUTE_ROUTING_URL` | `https://gw.lunaroute.com/v1` | Gateway base URL (provider `baseURL` + `/models`) |
| `LUNAROUTE_API_URL` | `https://api.lunaroute.com` | API host for `/v1/auth/exchange` |
| `LUNAROUTE_FRONT_URL` | `https://app.lunaroute.com` | Web app host for `/device-auth/opencode` browser login |
| `LUNAROUTE_MCP_URL` | `https://mcp.lunaroute.com/mcp` | Hosted MCP server URL registered in the live config |

## Troubleshooting

- **No models appear after login**: the gateway may be unreachable, or the
  key may be stale. Re-run `/connect`.
- **Key rotation**: re-run `/connect` — the new key replaces the old one, and
  MCP picks it up on the next instance reload (no restart needed).
- **Removing your credentials**: delete the `lunaroute` entry from
  `~/.local/share/opencode/auth.json` (OpenCode has no `/disconnect` command
  yet). The plugin stops injecting models and MCP on the next start; until
  then, an open session keeps using the old key — server-side revocation is
  what actually cuts access.
- **Unreadable or corrupt auth.json**: the plugin logs one secret-free
  warning and behaves as logged out (nothing is removed from your config).
  Re-running `/connect` rewrites the store and restores the session.
- **Windows**: not supported in v1 — the auth store path is verified on
  Linux and macOS only.

## Development

```bash
npm install
npm run check   # typecheck + tests
```

Manual smoke test: see [docs/smoke-checklist.md](./docs/smoke-checklist.md)
(run against staging before every release).

Package dry run:

```bash
npm pack --dry-run
```

## License

MIT License. See [LICENSE](./LICENSE).
