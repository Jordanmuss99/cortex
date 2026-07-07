import { getConfig, resetLLMClients } from "../lib/llm.js";

describe("llm provider config", () => {
  const originalEnv = { ...process.env };

  afterEach(() => {
    resetLLMClients();
    process.env = { ...originalEnv };
  });

  it("defaults to anthropic when no provider is set", () => {
    delete process.env.CORTEX_LLM_PROVIDER;
    delete process.env.CORTEX_LLM_MODEL;
    process.env.ANTHROPIC_API_KEY = "test-ant-key";
    const config = getConfig();
    expect(config.provider).toBe("anthropic");
    expect(config.model).toBe("claude-sonnet-4-6-20250514");
    expect(config.apiKey).toBe("test-ant-key");
  });

  it("selects local ollama defaults", () => {
    process.env.CORTEX_LLM_PROVIDER = "ollama";
    delete process.env.CORTEX_LLM_MODEL;
    delete process.env.CORTEX_LLM_API_KEY;
    delete process.env.OLLAMA_API_KEY;
    const config = getConfig();
    expect(config.provider).toBe("ollama");
    expect(config.model).toBe("glm5.2");
    expect(config.apiKey).toBe("ollama");
  });

  it("selects ollama cloud defaults for GLM 5.2", () => {
    process.env.CORTEX_LLM_PROVIDER = "ollama_cloud";
    delete process.env.CORTEX_LLM_MODEL;
    delete process.env.CORTEX_LLM_API_KEY;
    process.env.OLLAMA_API_KEY = "oc_test_key";
    const config = getConfig();
    expect(config.provider).toBe("ollama_cloud");
    expect(config.model).toBe("glm5.2");
    expect(config.apiKey).toBe("oc_test_key");
  });

  it("selects zhipu / GLM Cloud defaults", () => {
    process.env.CORTEX_LLM_PROVIDER = "zhipu";
    process.env.ZHIPU_API_KEY = "zhipu-test";
    delete process.env.CORTEX_LLM_MODEL;
    delete process.env.CORTEX_LLM_API_KEY;
    const config = getConfig();
    expect(config.provider).toBe("zhipu");
    expect(config.model).toBe("glm-5.2");
    expect(config.apiKey).toBe("zhipu-test");
  });

  it("prefers CORTEX_LLM_MODEL over defaults", () => {
    process.env.CORTEX_LLM_PROVIDER = "ollama_cloud";
    process.env.CORTEX_LLM_MODEL = "custom-model";
    process.env.OLLAMA_API_KEY = "oc_test_key";
    const config = getConfig();
    expect(config.model).toBe("custom-model");
  });
});
