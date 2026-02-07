export interface ProviderModelOption {
  id: string;
  name: string;
  shortName: string;
  description: string;
}

const PROVIDER_MODEL_OPTIONS: Record<string, ProviderModelOption[]> = {
  claude: [
    {
      id: "sonnet",
      name: "Claude 4 Sonnet",
      shortName: "S",
      description: "Faster, efficient for most tasks",
    },
    {
      id: "opus",
      name: "Claude 4 Opus",
      shortName: "O",
      description: "More capable, better for complex tasks",
    },
  ],
  codex: [
    {
      id: "",
      name: "Provider Default",
      shortName: "D",
      description: "Use the CLI's configured default model",
    },
    {
      id: "gpt-5-codex",
      name: "GPT-5 Codex",
      shortName: "C5",
      description: "Code-specialized model",
    },
    {
      id: "gpt-5",
      name: "GPT-5",
      shortName: "G5",
      description: "General-purpose GPT-5 model",
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
  sonnet: "Claude 4 Sonnet",
  opus: "Claude 4 Opus",
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
  return getProviderModelOptions(providerId)[0]?.id ?? "";
}

export function getModelDisplayName(providerId: string, model: string): string {
  if (!model) {
    return "Provider Default";
  }

  const known = getProviderModelOptions(providerId).find((option) => option.id === model);
  if (known) {
    return known.name;
  }

  return LEGACY_MODEL_LABELS[model] || model;
}

export function getProviderDisplayName(providerId: string): string {
  return PROVIDER_LABELS[providerId] || providerId || "Assistant";
}
