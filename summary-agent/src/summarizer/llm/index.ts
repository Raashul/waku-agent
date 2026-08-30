import { config } from "../../config.js";
import type { LlmDriver } from "./driver.js";
import { MockLlm } from "./mock.js";
import { OpenRouterLlm } from "./openrouter.js";

export type { LlmDriver, LlmResult, SummarizeInput } from "./driver.js";

export function makeLlm(): LlmDriver {
  if (config.llm.driver === "openrouter" && config.llm.apiKey) {
    return new OpenRouterLlm(config.llm.model, config.llm.apiKey, config.llm.baseUrl);
  }
  return new MockLlm();
}
