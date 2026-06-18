import "dotenv/config";
import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";

// ─── Configuration ──────────────────────────────────────

type LLMProvider = "anthropic" | "openai" | "openrouter" | "ollama" | "ollama_cloud" | "zhipu";

interface LLMConfig {
  provider: LLMProvider;
  model: string;
  apiKey: string;
}

export function getConfig(): LLMConfig {
  const provider = (process.env.CORTEX_LLM_PROVIDER || "anthropic") as LLMProvider;
  const model = process.env.CORTEX_LLM_MODEL || getDefaultModel(provider);
  const apiKey = resolveApiKey(provider);
  return { provider, model, apiKey };
}

function getDefaultModel(provider: LLMProvider): string {
  switch (provider) {
    case "anthropic": return "claude-sonnet-4-6-20250514";
    case "openai": return "gpt-4o";
    case "openrouter": return "anthropic/claude-sonnet-4-6-20250514";
    case "ollama": return "glm5.2";
    case "ollama_cloud": return "glm5.2";
    case "zhipu": return "glm-5.2";
  }
}

function resolveApiKey(provider: LLMProvider): string {
  switch (provider) {
    case "anthropic": {
      const key = process.env.CORTEX_LLM_API_KEY || process.env.ANTHROPIC_API_KEY;
      if (!key) throw new Error("ANTHROPIC_API_KEY (or CORTEX_LLM_API_KEY) not set for provider=anthropic");
      return key;
    }
    case "openai": {
      const key = process.env.CORTEX_LLM_API_KEY || process.env.OPENAI_API_KEY;
      if (!key) throw new Error("OPENAI_API_KEY (or CORTEX_LLM_API_KEY) not set for provider=openai");
      return key;
    }
    case "openrouter": {
      const key = process.env.CORTEX_LLM_API_KEY || process.env.OPENROUTER_API_KEY;
      if (!key) throw new Error("OPENROUTER_API_KEY (or CORTEX_LLM_API_KEY) not set for provider=openrouter");
      return key;
    }
    case "ollama": {
      // Local Ollama's OpenAI-compatible endpoint does not require auth,
      // but the OpenAI SDK requires a non-empty string.
      return process.env.CORTEX_LLM_API_KEY || process.env.OLLAMA_API_KEY || "ollama";
    }
    case "ollama_cloud": {
      const key = process.env.CORTEX_LLM_API_KEY || process.env.OLLAMA_API_KEY;
      if (!key) throw new Error("OLLAMA_API_KEY (or CORTEX_LLM_API_KEY) is required for provider=ollama_cloud");
      return key;
    }
    case "zhipu": {
      const key = process.env.CORTEX_LLM_API_KEY || process.env.ZHIPU_API_KEY;
      if (!key) throw new Error("ZHIPU_API_KEY (or CORTEX_LLM_API_KEY) not set for provider=zhipu");
      return key;
    }
  }
}

// ─── Shared interface ───────────────────────────────────

export interface LLMMessage {
  role: "user" | "assistant" | "system";
  content: string;
}

export interface LLMResponse {
  content: string;
  model: string;
  usage?: { inputTokens: number; outputTokens: number };
}

// ─── Provider clients (lazy, keyed by baseURL) ──────────

let _anthropicClient: Anthropic | null = null;
const _openaiClients = new Map<string, OpenAI>();

function getAnthropicClient(apiKey: string): Anthropic {
  if (!_anthropicClient) {
    _anthropicClient = new Anthropic({ apiKey });
  }
  return _anthropicClient;
}

function getOpenAIClient(apiKey: string, baseURL: string): OpenAI {
  const key = `${baseURL}::${apiKey.slice(0, 8)}`;
  if (!_openaiClients.has(key)) {
    _openaiClients.set(key, new OpenAI({ apiKey, baseURL }));
  }
  return _openaiClients.get(key)!;
}

// ─── Main completion function ───────────────────────────

export async function llmComplete(
  messages: LLMMessage[],
  options: {
    maxTokens?: number;
    temperature?: number;
    system?: string;
  } = {}
): Promise<LLMResponse> {
  const config = getConfig();
  const maxTokens = options.maxTokens ?? 4096;
  const temperature = options.temperature ?? 0.7;

  switch (config.provider) {
    case "anthropic":
      return callAnthropic(config, messages, maxTokens, temperature, options.system);
    case "openai":
      return callOpenAI(config, messages, maxTokens, temperature, options.system);
    case "openrouter":
      return callOpenRouter(config, messages, maxTokens, temperature, options.system);
    case "ollama":
      return callOllama(config, messages, maxTokens, temperature, options.system);
    case "ollama_cloud":
      return callOllamaCloud(config, messages, maxTokens, temperature, options.system);
    case "zhipu":
      return callZhipu(config, messages, maxTokens, temperature, options.system);
  }
}

// ─── Anthropic ──────────────────────────────────────────

async function callAnthropic(
  config: LLMConfig,
  messages: LLMMessage[],
  maxTokens: number,
  temperature: number,
  system?: string
): Promise<LLMResponse> {
  const client = getAnthropicClient(config.apiKey);

  const anthropicMessages = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role as "user" | "assistant", content: m.content }));

  const systemText = system || messages.find((m) => m.role === "system")?.content;

  const response = await client.messages.create({
    model: config.model,
    max_tokens: maxTokens,
    temperature,
    ...(systemText ? { system: systemText } : {}),
    messages: anthropicMessages,
  });

  const textBlock = response.content.find((b) => b.type === "text");

  return {
    content: textBlock?.text || "",
    model: response.model,
    usage: {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
    },
  };
}

// ─── OpenAI-compatible helper ─────────────────────────────

function buildOpenAIMessages(
  messages: LLMMessage[],
  system?: string
): Array<{ role: "system" | "user" | "assistant"; content: string }> {
  const openaiMessages: Array<{ role: "system" | "user" | "assistant"; content: string }> = [];

  if (system) {
    openaiMessages.push({ role: "system", content: system });
  }

  for (const msg of messages) {
    openaiMessages.push({ role: msg.role, content: msg.content });
  }

  return openaiMessages;
}

async function callOpenAICompatible(
  config: LLMConfig,
  baseURL: string,
  messages: LLMMessage[],
  maxTokens: number,
  temperature: number,
  system?: string
): Promise<LLMResponse> {
  const client = getOpenAIClient(config.apiKey, baseURL);
  const openaiMessages = buildOpenAIMessages(messages, system);

  const response = await client.chat.completions.create({
    model: config.model,
    max_tokens: maxTokens,
    temperature,
    messages: openaiMessages,
  });

  const message = response.choices[0]?.message as { content?: string; reasoning?: string } | undefined;
  const content = message?.content || message?.reasoning || "";

  return {
    content,
    model: response.model,
    usage: response.usage
      ? {
          inputTokens: response.usage.prompt_tokens,
          outputTokens: response.usage.completion_tokens || 0,
        }
      : undefined,
  };
}

// ─── OpenAI ─────────────────────────────────────────────

async function callOpenAI(
  config: LLMConfig,
  messages: LLMMessage[],
  maxTokens: number,
  temperature: number,
  system?: string
): Promise<LLMResponse> {
  const baseURL = process.env.OPENAI_BASE_URL || undefined;
  return callOpenAICompatible(
    { ...config, apiKey: config.apiKey },
    baseURL || "https://api.openai.com/v1",
    messages,
    maxTokens,
    temperature,
    system
  );
}

// ─── OpenRouter (OpenAI-compatible) ─────────────────────

async function callOpenRouter(
  config: LLMConfig,
  messages: LLMMessage[],
  maxTokens: number,
  temperature: number,
  system?: string
): Promise<LLMResponse> {
  return callOpenAICompatible(config, "https://openrouter.ai/api/v1", messages, maxTokens, temperature, system);
}

// ─── Ollama (OpenAI-compatible) ─────────────────────────

async function callOllama(
  config: LLMConfig,
  messages: LLMMessage[],
  maxTokens: number,
  temperature: number,
  system?: string
): Promise<LLMResponse> {
  const baseURL = `${process.env.OLLAMA_URL || "http://localhost:11434"}/v1`;
  return callOpenAICompatible(config, baseURL, messages, maxTokens, temperature, system);
}

// ─── Ollama Cloud (OpenAI-compatible) ────────────────────

async function callOllamaCloud(
  config: LLMConfig,
  messages: LLMMessage[],
  maxTokens: number,
  temperature: number,
  system?: string
): Promise<LLMResponse> {
  const baseURL = process.env.OLLAMA_CLOUD_URL || "https://ollama.com/v1";
  return callOpenAICompatible(config, baseURL, messages, maxTokens, temperature, system);
}

// ─── Zhipu / GLM Cloud (OpenAI-compatible) ───────────────

async function callZhipu(
  config: LLMConfig,
  messages: LLMMessage[],
  maxTokens: number,
  temperature: number,
  system?: string
): Promise<LLMResponse> {
  return callOpenAICompatible(config, "https://open.bigmodel.cn/api/paas/v4/", messages, maxTokens, temperature, system);
}

// ─── Reset helpers (testing) ────────────────────────────

export function resetLLMClients(): void {
  _anthropicClient = null;
  _openaiClients.clear();
}
