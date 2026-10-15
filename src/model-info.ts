import { Model, Provider } from "@opencode/plugin";
import type { MappedModel } from "./lunaroute.js";

/**
 * Map one LunaRoute catalog entry onto the v2 Model.Info shape.
 *
 * Model.Info.default() supplies the required scaffold; catalog values replace
 * the parts the gateway owns (name, limits, capabilities, variants). Cost is
 * a tier array in v2 (v1 wrote a single object) and the gateway is
 * zero-marginal-cost, so one zero tier matches the v1 behavior. The base
 * object is spread into a fresh object — never mutate a shared default.
 */
export function toModelInfo(model: MappedModel, providerID: string): Model.Info {
  const base = Model.Info.default(providerID as Provider.ID, model.id as Model.ID) as Record<string, unknown>;
  return {
    ...base,
    name: model.name,
    limit: { context: model.limitContext, output: model.limitOutput },
    capabilities: {
      tools: model.tool_call,
      input: model.modalitiesInput,
      output: ["text"],
    },
    cost: [{ input: 0, output: 0, cache: { read: 0, write: 0 } }],
    variants: Object.entries(model.variants).map(([id, variant]) => ({
      id,
      settings: { reasoningEffort: variant.reasoningEffort },
    })),
  } as unknown as Model.Info;
}
