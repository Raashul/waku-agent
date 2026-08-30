export interface SummarizeInput {
  ticker: string;
  articles: string[];
}

export interface LlmResult {
  text: string;
  model: string;
}

export interface LlmDriver {
  readonly name: string;
  summarize(input: SummarizeInput): Promise<LlmResult>;
}
