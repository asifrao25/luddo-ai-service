/**
 * Configuration loader for Luddo AI Service
 */

import { existsSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

export interface ServiceConfig {
  server: {
    port: number;
    host: string;
    corsOrigins: string[];
    apiKeyRequired: boolean;
  };
  auth: {
    apiKey: string;
  };
  ollama: {
    baseUrl: string;
    defaultModel: string;
    simulationModel: string;
    timeout: number;
    maxRetries: number;
  };
  simulation: {
    defaultBatchSize: number;
    maxConcurrentGames: number;
    delayBetweenMoves: number;
    maxTurnsPerGame: number;
    autoSaveInterval: number;
  };
  training: {
    minGamesForDataset: number;
    maxExamplesPerDataset: number;
    defaultEpochs: number;
  };
  storage: {
    dataPath: string;
    logsPath: string;
    maxLogSizeMb: number;
    retentionDays: number;
  };
}

const DEFAULT_CONFIG: ServiceConfig = {
  server: {
    port: 3010,
    host: '0.0.0.0',
    corsOrigins: ['*'],
    apiKeyRequired: true
  },
  auth: {
    apiKey: 'luddo-ai-2025-secret-key'
  },
  ollama: {
    baseUrl: 'http://localhost:11434',
    defaultModel: 'qwen2.5:7b-instruct-q4_K_M',
    simulationModel: 'llama3.2:3b',
    timeout: 30000,
    maxRetries: 3
  },
  simulation: {
    defaultBatchSize: 10,
    maxConcurrentGames: 2,
    delayBetweenMoves: 100,
    maxTurnsPerGame: 500,
    autoSaveInterval: 10
  },
  training: {
    minGamesForDataset: 100,
    maxExamplesPerDataset: 10000,
    defaultEpochs: 3
  },
  storage: {
    dataPath: '/Volumes/AI_SSD/ai-local/data',
    logsPath: '/Volumes/AI_SSD/ai-local/logs',
    maxLogSizeMb: 100,
    retentionDays: 90
  }
};

const CONFIG_PATH = '/Volumes/AI_SSD/ai-local/data/config/service-config.json';

export function loadConfig(): ServiceConfig {
  try {
    if (existsSync(CONFIG_PATH)) {
      const fileContent = readFileSync(CONFIG_PATH, 'utf-8');
      const loadedConfig = JSON.parse(fileContent);
      // Merge with defaults to ensure all fields exist
      return deepMerge(DEFAULT_CONFIG, loadedConfig);
    }
  } catch (error) {
    console.warn(`[CONFIG] Failed to load config from ${CONFIG_PATH}, using defaults:`, error);
  }

  // Save default config if it doesn't exist
  saveConfig(DEFAULT_CONFIG);
  return DEFAULT_CONFIG;
}

export function saveConfig(config: ServiceConfig): void {
  try {
    writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    console.log(`[CONFIG] Saved config to ${CONFIG_PATH}`);
  } catch (error) {
    console.error(`[CONFIG] Failed to save config:`, error);
  }
}

function deepMerge<T extends Record<string, any>>(target: T, source: Partial<T>): T {
  const result = { ...target };
  for (const key in source) {
    if (source[key] !== undefined) {
      if (
        typeof source[key] === 'object' &&
        source[key] !== null &&
        !Array.isArray(source[key]) &&
        typeof target[key] === 'object' &&
        target[key] !== null
      ) {
        result[key] = deepMerge(target[key], source[key] as any);
      } else {
        result[key] = source[key] as any;
      }
    }
  }
  return result;
}

// Cached config instance
let cachedConfig: ServiceConfig | null = null;

/**
 * Get the service configuration (cached)
 */
export function getConfig(): ServiceConfig {
  if (!cachedConfig) {
    cachedConfig = loadConfig();
  }
  return cachedConfig;
}

/**
 * Reset cached config (for testing or hot reload)
 */
export function resetConfig(): void {
  cachedConfig = null;
}
