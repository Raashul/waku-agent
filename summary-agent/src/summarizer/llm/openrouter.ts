import OpenAI from "openai";
import type { LlmDriver, LlmResult, SummarizeInput } from "./driver.js";
import { SYSTEM_PROMPT, buildUserPrompt } from "../prompt.js";

/**
 * Real LLM via OpenRouter's OpenAI-compatible endpoint. Model id is a full
 * OpenRouter slug, e.g. "anthropic/claude-haiku-4.5".
 */
export class OpenRouterLlm implements LlmDriver {
  readonly name = "openrouter";
  private readonly client: OpenAI;

  constructor(
    private readonly model: string,
    apiKey: string,
    baseURL = "https://openrouter.ai/api/v1",
  ) {
    this.client = new OpenAI({ apiKey, baseURL });
  }

  async summarize({ ticker, articles }: SummarizeInput): Promise<LlmResult> {
    const res = await this.client.chat.completions.create({
      model: this.model,
      temperature: 0.2,
      max_tokens: 400,
      messages: [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: buildUserPrompt(ticker, articles) },
      ],
    });
    const text = res.choices[0]?.message?.content?.trim();
    if (!text) throw new Error("openrouter returned an empty completion");
    return { text, model: res.model || this.model };
  }
}
