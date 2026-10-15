/**
 * Wire-format kill switch, v2 edition. v1 picked an ai-sdk npm id
 * (`@ai-sdk/openai` / `@ai-sdk/openai-compatible`); v2 providers carry a
 * protocol package id instead. Semantics are unchanged: absent/empty means
 * the Responses default; a deliberate non-empty override that does not parse
 * fails toward completions and warns (a broken kill switch must not silently
 * route through the new protocol).
 */
export type WirePackage =
  | "@opencode/ai/providers/openai-compatible-responses"
  | "@opencode/ai/providers/openai-compatible";

export const PACKAGE_RESPONSES: WirePackage = "@opencode/ai/providers/openai-compatible-responses";
export const PACKAGE_COMPLETIONS: WirePackage = "@opencode/ai/providers/openai-compatible";

export type ResolvedWire = { package: WirePackage; warning?: string };

export function resolveWire(env: NodeJS.ProcessEnv): ResolvedWire {
  const raw = env.LUNAROUTE_API;
  if (typeof raw !== "string" || raw.trim() === "") return { package: PACKAGE_RESPONSES };
  const value = raw.trim().toLowerCase();
  if (value === "responses") return { package: PACKAGE_RESPONSES };
  if (value === "completions") return { package: PACKAGE_COMPLETIONS };
  return {
    package: PACKAGE_COMPLETIONS,
    warning:
      `LunaRoute: unrecognized LUNAROUTE_API=${JSON.stringify(raw)}; ` +
      `falling back to ${PACKAGE_COMPLETIONS} (valid values: responses | completions)`,
  };
}
