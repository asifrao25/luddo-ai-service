/**
 * Ollama API Service
 *
 * Wrapper for Ollama REST API at localhost:11434
 */

import { loadConfig } from '../config/index.js';

export interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  digest: string;
}

export interface OllamaGenerateRequest {
  model: string;
  prompt: string;
  system?: string;
  stream?: boolean;
  options?: {
    temperature?: number;
    top_p?: number;
    top_k?: number;
    num_predict?: number;
    stop?: string[];
  };
}

export interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
  context?: number[];
  total_duration?: number;
  load_duration?: number;
  prompt_eval_count?: number;
  eval_count?: number;
  eval_duration?: number;
}

export class OllamaService {
  private baseUrl: string;
  private timeout: number;
  private maxRetries: number;

  constructor() {
    const config = loadConfig();
    this.baseUrl = config.ollama.baseUrl;
    this.timeout = config.ollama.timeout;
    this.maxRetries = config.ollama.maxRetries;
  }

  /**
   * Check if Ollama is connected and responsive
   */
  async checkConnection(): Promise<boolean> {
    try {
      const response = await fetch(`${this.baseUrl}/api/tags`, {
        method: 'GET',
        signal: AbortSignal.timeout(5000)
      });
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * List available models
   */
  async listModels(): Promise<OllamaModel[]> {
    const response = await fetch(`${this.baseUrl}/api/tags`, {
      method: 'GET',
      signal: AbortSignal.timeout(this.timeout)
    });

    if (!response.ok) {
      throw new Error(`Failed to list models: ${response.statusText}`);
    }

    const data = await response.json() as { models: OllamaModel[] };
    return data.models || [];
  }

  /**
   * Generate completion (non-streaming)
   */
  async generate(request: OllamaGenerateRequest): Promise<OllamaGenerateResponse> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt < this.maxRetries; attempt++) {
      try {
        const response = await fetch(`${this.baseUrl}/api/generate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            ...request,
            stream: false
          }),
          signal: AbortSignal.timeout(this.timeout)
        });

        if (!response.ok) {
          throw new Error(`Ollama API error: ${response.statusText}`);
        }

        return await response.json() as OllamaGenerateResponse;
      } catch (error) {
        lastError = error as Error;
        console.warn(`[OLLAMA] Attempt ${attempt + 1} failed:`, error);

        if (attempt < this.maxRetries - 1) {
          await this.delay(1000 * (attempt + 1)); // Exponential backoff
        }
      }
    }

    throw lastError || new Error('Failed to generate after retries');
  }

  /**
   * Generate AI move decision for Luddo game
   */
  async generateMoveDecision(
    model: string,
    systemPrompt: string,
    userPrompt: string,
    options?: { temperature?: number }
  ): Promise<{ tokenId: number; reasoning: string; responseTimeMs: number }> {
    const startTime = Date.now();

    const response = await this.generate({
      model,
      system: systemPrompt,
      prompt: userPrompt,
      options: {
        temperature: options?.temperature ?? 0.7,
        num_predict: 200,
        stop: ['\n\n', 'TOKEN:']
      }
    });

    const responseTimeMs = Date.now() - startTime;
    const { tokenId, reasoning } = this.parseMoveResponse(response.response);

    return { tokenId, reasoning, responseTimeMs };
  }

  /**
   * Parse move response from LLM
   */
  private parseMoveResponse(response: string): { tokenId: number; reasoning: string } {
    // Try to extract TOKEN: X pattern
    const tokenMatch = response.match(/TOKEN:\s*(\d)/i);
    if (tokenMatch) {
      const tokenId = parseInt(tokenMatch[1]);
      const reasoning = response.replace(/TOKEN:\s*\d/i, '').trim();
      return { tokenId, reasoning };
    }

    // Try to extract just a number
    const numberMatch = response.match(/(\d)/);
    if (numberMatch) {
      return {
        tokenId: parseInt(numberMatch[1]),
        reasoning: response.trim()
      };
    }

    // Default to token 0 if parsing fails
    console.warn('[OLLAMA] Could not parse move response, defaulting to token 0');
    return { tokenId: 0, reasoning: response.trim() };
  }

  /**
   * Create a fine-tuned model using Modelfile
   */
  async createModel(modelName: string, modelfile: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/create`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: modelName,
        modelfile
      }),
      signal: AbortSignal.timeout(600000) // 10 minute timeout for model creation
    });

    if (!response.ok) {
      const error = await response.text();
      throw new Error(`Failed to create model: ${error}`);
    }

    // Stream the response to wait for completion
    const reader = response.body?.getReader();
    if (reader) {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        const text = new TextDecoder().decode(value);
        const lines = text.split('\n').filter(Boolean);

        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.status) {
              console.log(`[OLLAMA] Create model: ${data.status}`);
            }
            if (data.error) {
              throw new Error(data.error);
            }
          } catch (e) {
            // Ignore JSON parse errors for partial lines
          }
        }
      }
    }
  }

  /**
   * Delete a model
   */
  async deleteModel(modelName: string): Promise<void> {
    const response = await fetch(`${this.baseUrl}/api/delete`, {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(30000)
    });

    if (!response.ok) {
      throw new Error(`Failed to delete model: ${response.statusText}`);
    }
  }

  /**
   * Get model info
   */
  async getModelInfo(modelName: string): Promise<any> {
    const response = await fetch(`${this.baseUrl}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: AbortSignal.timeout(10000)
    });

    if (!response.ok) {
      throw new Error(`Failed to get model info: ${response.statusText}`);
    }

    return response.json();
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
