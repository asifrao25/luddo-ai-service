/**
 * Storage Service
 *
 * Handles file-based storage (JSON) and SQLite database operations
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, unlinkSync } from 'fs';
import { join, dirname } from 'path';
import Database from 'better-sqlite3';
import { loadConfig } from '../config/index.js';

export class StorageService {
  private dataPath: string;
  private db: Database.Database | null = null;

  constructor() {
    const config = loadConfig();
    this.dataPath = config.storage.dataPath;
    this.ensureDirectories();
  }

  /**
   * Ensure all required directories exist
   */
  private ensureDirectories(): void {
    const dirs = [
      join(this.dataPath, 'tips'),
      join(this.dataPath, 'games', 'simulations'),
      join(this.dataPath, 'games', 'human'),
      join(this.dataPath, 'training', 'datasets'),
      join(this.dataPath, 'training', 'modelfiles'),
      join(this.dataPath, 'metrics'),
      join(this.dataPath, 'config')
    ];

    dirs.forEach(dir => {
      if (!existsSync(dir)) {
        mkdirSync(dir, { recursive: true });
      }
    });
  }

  /**
   * Get SQLite database connection
   */
  getDatabase(): Database.Database {
    if (!this.db) {
      const dbPath = join(this.dataPath, 'metrics', 'metrics.db');
      this.db = new Database(dbPath);
      this.db.pragma('journal_mode = WAL');
      this.initializeSchema();
    }
    return this.db;
  }

  /**
   * Initialize SQLite schema
   */
  private initializeSchema(): void {
    const db = this.db!;

    db.exec(`
      -- Games table
      CREATE TABLE IF NOT EXISTS games (
        id TEXT PRIMARY KEY,
        type TEXT NOT NULL CHECK(type IN ('simulation', 'human_vs_ai')),
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        duration_ms INTEGER,
        winner TEXT,
        total_turns INTEGER,
        tips_profile TEXT,
        config_json TEXT
      );

      -- Game players
      CREATE TABLE IF NOT EXISTS game_players (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL REFERENCES games(id),
        color TEXT NOT NULL CHECK(color IN ('red', 'blue', 'yellow', 'green')),
        name TEXT NOT NULL,
        is_ai BOOLEAN NOT NULL,
        ai_model TEXT,
        final_rank INTEGER,
        captures INTEGER DEFAULT 0,
        tokens_home INTEGER DEFAULT 0,
        sixes_rolled INTEGER DEFAULT 0
      );

      -- AI decisions
      CREATE TABLE IF NOT EXISTS ai_decisions (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        game_id TEXT NOT NULL REFERENCES games(id),
        turn_number INTEGER NOT NULL,
        player_color TEXT NOT NULL,
        dice_value INTEGER NOT NULL,
        valid_moves_json TEXT,
        selected_token INTEGER NOT NULL,
        reasoning TEXT,
        confidence REAL,
        response_time_ms INTEGER,
        tips_applied_json TEXT,
        was_capture BOOLEAN DEFAULT FALSE,
        reached_home BOOLEAN DEFAULT FALSE,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );

      -- Simulation batches
      CREATE TABLE IF NOT EXISTS simulation_batches (
        id TEXT PRIMARY KEY,
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        status TEXT CHECK(status IN ('running', 'paused', 'completed', 'failed')),
        total_games INTEGER,
        completed_games INTEGER DEFAULT 0,
        config_json TEXT
      );

      -- Training runs
      CREATE TABLE IF NOT EXISTS training_runs (
        id TEXT PRIMARY KEY,
        started_at DATETIME NOT NULL,
        ended_at DATETIME,
        status TEXT CHECK(status IN ('preparing', 'training', 'completed', 'failed')),
        base_model TEXT NOT NULL,
        output_model TEXT,
        dataset_path TEXT,
        dataset_size INTEGER,
        epochs INTEGER,
        error_message TEXT
      );

      -- Daily metrics snapshots
      CREATE TABLE IF NOT EXISTS daily_metrics (
        date TEXT PRIMARY KEY,
        total_games INTEGER,
        simulation_games INTEGER,
        human_games INTEGER,
        total_ai_decisions INTEGER,
        avg_response_time_ms REAL,
        captures_total INTEGER,
        win_rate_by_model_json TEXT,
        tips_effectiveness_json TEXT
      );

      -- Create indexes
      CREATE INDEX IF NOT EXISTS idx_games_type ON games(type);
      CREATE INDEX IF NOT EXISTS idx_games_started ON games(started_at);
      CREATE INDEX IF NOT EXISTS idx_ai_decisions_game ON ai_decisions(game_id);
      CREATE INDEX IF NOT EXISTS idx_game_players_game ON game_players(game_id);
    `);
  }

  // ============ JSON File Operations ============

  /**
   * Read JSON file
   */
  readJson<T>(relativePath: string, defaultValue: T): T {
    const fullPath = join(this.dataPath, relativePath);
    try {
      if (existsSync(fullPath)) {
        const content = readFileSync(fullPath, 'utf-8');
        return JSON.parse(content);
      }
    } catch (error) {
      console.error(`[STORAGE] Failed to read ${relativePath}:`, error);
    }
    return defaultValue;
  }

  /**
   * Write JSON file
   */
  writeJson(relativePath: string, data: any): void {
    const fullPath = join(this.dataPath, relativePath);
    const dir = dirname(fullPath);

    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }

    writeFileSync(fullPath, JSON.stringify(data, null, 2), 'utf-8');
  }

  /**
   * List files in directory
   */
  listFiles(relativePath: string, extension?: string): string[] {
    const fullPath = join(this.dataPath, relativePath);

    if (!existsSync(fullPath)) {
      return [];
    }

    let files = readdirSync(fullPath);

    if (extension) {
      files = files.filter(f => f.endsWith(extension));
    }

    return files;
  }

  /**
   * Delete file
   */
  deleteFile(relativePath: string): boolean {
    const fullPath = join(this.dataPath, relativePath);
    try {
      if (existsSync(fullPath)) {
        unlinkSync(fullPath);
        return true;
      }
    } catch (error) {
      console.error(`[STORAGE] Failed to delete ${relativePath}:`, error);
    }
    return false;
  }

  /**
   * Check if file exists
   */
  fileExists(relativePath: string): boolean {
    return existsSync(join(this.dataPath, relativePath));
  }

  /**
   * Get full path for a relative path
   */
  getFullPath(relativePath: string): string {
    return join(this.dataPath, relativePath);
  }

  /**
   * Get date-organized directory for game transcripts
   */
  getGameTranscriptPath(type: 'simulations' | 'human', gameId: string): string {
    const date = new Date().toISOString().split('T')[0];
    return `games/${type}/${date}/${gameId}.json`;
  }

  /**
   * Close database connection
   */
  close(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }
}

// Singleton instance
let storageServiceInstance: StorageService | null = null;

export function getStorageService(): StorageService {
  if (!storageServiceInstance) {
    storageServiceInstance = new StorageService();
  }
  return storageServiceInstance;
}
