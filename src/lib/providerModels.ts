export interface ProviderModelOption {
  id: string;
  name: string;
  shortName: string;
  description: string;
}

const PROVIDER_MODEL_OPTIONS: Record<string, ProviderModelOption[]> = {
  claude: [
    {
      id: "default",
      name: "Default (recommended)",
      shortName: "D",
      description: "Opus 4.6 · Most capable for complex work",
    },
    {
      id: "sonnet",
      name: "Sonnet",
      shortName: "S",
      description: "Sonnet 4.5 · Best for everyday tasks",
    },
    {
      id: "haiku",
      name: "Haiku",
      shortName: "H",
      description: "Haiku 4.5 · Fastest for quick answers",
    },
  ],
  codex: [
    {
      id: "gpt-5.2-codex",
      name: "GPT-5.2-Codex",
      shortName: "5.2C",
      description: "Codex specialized model",
    },
    {
      id: "gpt-5.3-codex",
      name: "GPT-5.3-Codex",
      shortName: "5.3C",
      description: "Latest Codex specialized model",
    },
    {
      id: "gpt-5.1-codex-max",
      name: "GPT-5.1-Codex-Max",
      shortName: "5.1M",
      description: "Higher-capacity Codex model",
    },
    {
      id: "gpt-5.2",
      name: "GPT-5.2",
      shortName: "5.2",
      description: "General-purpose GPT-5 model",
    },
    {
      id: "gpt-5.1-codex-mini",
      name: "GPT-5.1-Codex-Mini",
      shortName: "5.1m",
      description: "Lower-latency Codex model",
    },
    {
      id: "",
      name: "Provider Default",
      shortName: "D",
      description: "Use the CLI's configured default model",
    },
  ],
  gemini: [
    {
      id: "",
      name: "Provider Default",
      shortName: "D",
      description: "Use the CLI's configured default model",
    },
    {
      id: "gemini-2.5-pro",
      name: "Gemini 2.5 Pro",
      shortName: "GPro",
      description: "Best quality reasoning model",
    },
    {
      id: "gemini-2.5-flash",
      name: "Gemini 2.5 Flash",
      shortName: "GFl",
      description: "Lower latency model",
    },
  ],
  aider: [
    {
      id: "",
      name: "Provider Default",
      shortName: "D",
      description: "Use Aider's configured default model",
    },
  ],
  goose: [
    {
      id: "",
      name: "Provider Default",
      shortName: "D",
      description: "Use Goose's configured default model",
    },
  ],
  opencode: [
    {
      id: "",
      name: "Provider Default",
      shortName: "D",
      description: "Use OpenCode's configured default model",
    },
  ],
};

const PROVIDER_LABELS: Record<string, string> = {
  claude: "Claude",
  codex: "Codex",
  gemini: "Gemini",
  aider: "Aider",
  goose: "Goose",
  opencode: "OpenCode",
};

const LEGACY_MODEL_LABELS: Record<string, string> = {
  default: "Default (recommended)",
  sonnet: "Sonnet",
  haiku: "Haiku",
  opus: "Opus",
  "gpt-5-codex": "GPT-5-Codex (Legacy)",
  "gpt-5": "GPT-5 (Legacy)",
};

export function getProviderModelOptions(providerId: string): ProviderModelOption[] {
  return (
    PROVIDER_MODEL_OPTIONS[providerId] || [
      {
        id: "",
        name: "Provider Default",
        shortName: "D",
        description: "Use the provider's configured default model",
      },
    ]
  );
}

export function getDefaultModelForProvider(providerId: string): string {
  if (providerId === "codex") {
    return "gpt-5.3-codex";
  }
  return getProviderModelOptions(providerId)[0]?.id ?? "";
}

export function getModelDisplayName(providerId: string, model: string): string {
  const known = getProviderModelOptions(providerId).find((option) => option.id === model);
  if (known) {
    return known.name;
  }

  if (!model) {
    return "Provider Default";
  }

  return LEGACY_MODEL_LABELS[model] || model;
}

export function getProviderDisplayName(providerId: string): string {
  return PROVIDER_LABELS[providerId] || providerId || "Assistant";
}
