// Provider model ids for the Claude Flow adapter.
export const FLOW_MODELS = {
  sonnet: "claude-sonnet-5",
  opus: "claude-opus-5-5",
  fable: "claude-fable-5-1",
  haiku: "claude-haiku-4-5-20251001",
} as const;

export const CORE_ADAPTER_MODEL_IDS: readonly string[] = Object.values(FLOW_MODELS);
export type AdapterModelId = typeof FLOW_MODELS[keyof typeof FLOW_MODELS];
