/**
 * Simulation Service
 *
 * Manages AI vs AI game simulations for training data collection
 */

import { v4 as uuidv4 } from 'uuid';
import { getStorageService, StorageService } from './StorageService.js';
import { broadcastSimulationProgress, broadcastSimulationGameEnd, broadcastSimulationBatchEnd } from '../api/websocket.js';
import { GameRunner, GameConfig, GameResult } from '../simulation/GameRunner.js';
import { AIPlayerService } from './AIPlayerService.js';
import { OllamaService } from './OllamaService.js';
import { TipsService } from './TipsService.js';
import { MetricsService } from './MetricsService.js';
import { getConfig } from '../config/index.js';
import { PlayerColor } from '../shared/types.js';

export interface SimulationConfig {
  batchSize: number;
  aiModels?: {
    red?: string;
    blue?: string;
    yellow?: string;
    green?: string;
  };
  tipsProfile?: string;
  speed: 'fast' | 'normal' | 'slow';
}

export interface SimulationBatch {
  id: string;
  status: 'running' | 'paused' | 'completed' | 'failed';
  config: SimulationConfig;
  startedAt: string;
  endedAt?: string;
  gamesCompleted: number;
  totalGames: number;
  currentGame?: {
    id: string;
    turn: number;
    rankings: string[];
  };
}

// In-memory state for current simulation
let currentBatch: SimulationBatch | null = null;
let isPaused = false;
let shouldStop = false;
let currentGameRunner: GameRunner | null = null;
let winsByColor: Record<string, number> = { red: 0, blue: 0, yellow: 0, green: 0 };

export class SimulationService {
  private storage: StorageService;
  private ollamaService: OllamaService;
  private tipsService: TipsService;
  private metricsService: MetricsService;
  private aiPlayerService: AIPlayerService;

  constructor() {
    this.storage = getStorageService();
    this.ollamaService = new OllamaService();
    this.tipsService = new TipsService();
    this.metricsService = new MetricsService();
    this.aiPlayerService = new AIPlayerService(this.ollamaService, this.tipsService);

    // Clean up any stale "running" simulations from previous server instances
    this.cleanupStaleSimulations();
  }

  /**
   * Mark any "running" simulations as failed on startup
   * (they can't actually be running if the service just started)
   */
  private cleanupStaleSimulations(): void {
    try {
      const db = this.storage.getDatabase();
      const result = db.prepare(`
        UPDATE simulation_batches
        SET status = 'failed', ended_at = ?
        WHERE status = 'running'
      `).run(new Date().toISOString());

      if (result.changes > 0) {
        console.log(`[SIMULATION] Cleaned up ${result.changes} stale simulation(s) from previous run`);
      }
    } catch (error) {
      console.error('[SIMULATION] Failed to cleanup stale simulations:', error);
    }
  }

  /**
   * Start a new simulation batch
   */
  async startBatch(config: SimulationConfig): Promise<{ batchId: string; estimatedDuration: string }> {
    if (currentBatch && currentBatch.status === 'running') {
      throw new Error('A simulation batch is already running');
    }

    const batchId = `batch_${Date.now()}_${uuidv4().slice(0, 6)}`;

    winsByColor = { red: 0, blue: 0, yellow: 0, green: 0 };
    currentBatch = {
      id: batchId,
      status: 'running',
      config,
      startedAt: new Date().toISOString(),
      gamesCompleted: 0,
      totalGames: config.batchSize
    };

    isPaused = false;
    shouldStop = false;

    // Save to database
    const db = this.storage.getDatabase();
    db.prepare(`
      INSERT INTO simulation_batches (id, started_at, status, total_games, completed_games, config_json)
      VALUES (?, ?, ?, ?, ?, ?)
    `).run(
      batchId,
      currentBatch.startedAt,
      'running',
      config.batchSize,
      0,
      JSON.stringify(config)
    );

    // Start simulation in background
    this.runSimulationLoop();

    // Estimate duration based on speed
    const msPerGame = config.speed === 'fast' ? 30000 : config.speed === 'slow' ? 120000 : 60000;
    const totalMs = config.batchSize * msPerGame;
    const minutes = Math.ceil(totalMs / 60000);

    return {
      batchId,
      estimatedDuration: `${minutes}m`
    };
  }

  /**
   * Stop current simulation batch
   */
  async stopBatch(batchId: string): Promise<{ gamesCompleted: number }> {
    if (!currentBatch || currentBatch.id !== batchId) {
      throw new Error('Batch not found or not running');
    }

    shouldStop = true;

    // Abort current game if running
    if (currentGameRunner && currentGameRunner.isRunning()) {
      currentGameRunner.abort('Batch stopped');
    }

    const gamesCompleted = currentBatch.gamesCompleted;

    // Update database
    const db = this.storage.getDatabase();
    db.prepare(`
      UPDATE simulation_batches SET status = 'completed', ended_at = ?, completed_games = ?
      WHERE id = ?
    `).run(new Date().toISOString(), gamesCompleted, batchId);

    currentBatch.status = 'completed';
    currentBatch.endedAt = new Date().toISOString();

    return { gamesCompleted };
  }

  /**
   * Pause simulation
   */
  async pauseBatch(batchId: string): Promise<{ gamesCompleted: number }> {
    if (!currentBatch || currentBatch.id !== batchId) {
      throw new Error('Batch not found or not running');
    }

    isPaused = true;
    currentBatch.status = 'paused';

    // Update database
    const db = this.storage.getDatabase();
    db.prepare(`UPDATE simulation_batches SET status = 'paused' WHERE id = ?`).run(batchId);

    return { gamesCompleted: currentBatch.gamesCompleted };
  }

  /**
   * Resume simulation
   */
  async resumeBatch(batchId: string): Promise<{ gamesRemaining: number }> {
    if (!currentBatch || currentBatch.id !== batchId) {
      throw new Error('Batch not found');
    }

    if (currentBatch.status !== 'paused') {
      throw new Error('Batch is not paused');
    }

    isPaused = false;
    currentBatch.status = 'running';

    // Update database
    const db = this.storage.getDatabase();
    db.prepare(`UPDATE simulation_batches SET status = 'running' WHERE id = ?`).run(batchId);

    // Resume simulation loop
    this.runSimulationLoop();

    return { gamesRemaining: currentBatch.totalGames - currentBatch.gamesCompleted };
  }

  /**
   * Get current status
   */
  async getStatus(): Promise<{
    isRunning: boolean;
    currentBatch: SimulationBatch | null;
  }> {
    return {
      isRunning: currentBatch?.status === 'running' || false,
      currentBatch
    };
  }

  /**
   * Get simulation history
   */
  async getHistory(limit: number, offset: number): Promise<{
    batches: any[];
    total: number;
  }> {
    const db = this.storage.getDatabase();

    const total = db.prepare(`SELECT COUNT(*) as count FROM simulation_batches`).get() as { count: number };

    const batches = db.prepare(`
      SELECT id, started_at, ended_at, status, total_games, completed_games, config_json
      FROM simulation_batches
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `).all(limit, offset);

    return {
      batches: batches.map((b: any) => ({
        ...b,
        config: JSON.parse(b.config_json || '{}')
      })),
      total: total.count
    };
  }

  /**
   * Main simulation loop (runs in background)
   */
  private async runSimulationLoop(): Promise<void> {
    if (!currentBatch) return;

    console.log(`[SIM] Starting simulation batch: ${currentBatch.id}`);

    while (
      currentBatch &&
      currentBatch.gamesCompleted < currentBatch.totalGames &&
      !shouldStop
    ) {
      // Check if paused
      if (isPaused) {
        await this.delay(1000);
        continue;
      }

      // Run a single game
      try {
        const gameResult = await this.runSingleGame();

        currentBatch.gamesCompleted++;

        // Update database
        const db = this.storage.getDatabase();
        db.prepare(`
          UPDATE simulation_batches SET completed_games = ? WHERE id = ?
        `).run(currentBatch.gamesCompleted, currentBatch.id);

        // Broadcast progress
        broadcastSimulationProgress({
          batchId: currentBatch.id,
          gamesCompleted: currentBatch.gamesCompleted,
          totalGames: currentBatch.totalGames,
          currentGame: currentBatch.currentGame
        });

        // Broadcast game end
        broadcastSimulationGameEnd({
          turns: gameResult.turns,
          batchId: currentBatch.id,
          gameId: gameResult.gameId,
          winner: gameResult.winner,
          rankings: gameResult.rankings
        });

        winsByColor[gameResult.winner.toLowerCase()] = (winsByColor[gameResult.winner.toLowerCase()] || 0) + 1;
        console.log(`[SIM] Game ${currentBatch.gamesCompleted}/${currentBatch.totalGames} completed. Winner: ${gameResult.winner}`);

      } catch (error) {
        console.error(`[SIM] Game failed:`, error);
      }

      // Delay between games based on speed
      const delay = currentBatch.config.speed === 'fast' ? 100 : currentBatch.config.speed === 'slow' ? 2000 : 500;
      await this.delay(delay);
    }

    // Batch complete
    if (currentBatch && !shouldStop) {
      currentBatch.status = 'completed';
      currentBatch.endedAt = new Date().toISOString();

      const db = this.storage.getDatabase();
      db.prepare(`
        UPDATE simulation_batches SET status = 'completed', ended_at = ? WHERE id = ?
      `).run(currentBatch.endedAt, currentBatch.id);

      broadcastSimulationBatchEnd({
        batchId: currentBatch.id,
        summary: {
          totalGames: currentBatch.totalGames,
          gamesCompleted: currentBatch.gamesCompleted,
          duration: currentBatch.endedAt,
          winsByColor: winsByColor
        }
      });

      console.log(`[SIM] Batch ${currentBatch.id} completed. Total games: ${currentBatch.gamesCompleted}`);
    }

    currentBatch = null;
  }

  /**
   * Run a single simulated game using GameRunner
   */
  private async runSingleGame(): Promise<{
    gameId: string;
    winner: string;
    rankings: string[];
    turns: number;
  }> {
    if (!currentBatch) {
      throw new Error('No batch running');
    }

    const config = getConfig();
    const players: PlayerColor[] = ['red', 'blue', 'yellow', 'green'];

    // Build game config
    const gameConfig: GameConfig = {
      players,
      playerNames: {
        red: 'AI-Red',
        blue: 'AI-Blue',
        yellow: 'AI-Yellow',
        green: 'AI-Green'
      },
      aiModels: {
        red: currentBatch.config.aiModels?.red || config.ollama.simulationModel,
        blue: currentBatch.config.aiModels?.blue || config.ollama.simulationModel,
        yellow: currentBatch.config.aiModels?.yellow || config.ollama.simulationModel,
        green: currentBatch.config.aiModels?.green || config.ollama.simulationModel
      },
      tipsProfile: currentBatch.config.tipsProfile,
      maxTurns: 500,
      delayBetweenMoves: currentBatch.config.speed === 'fast' ? 0 : currentBatch.config.speed === 'slow' ? 200 : 50
    };

    // Create game runner
    const runner = new GameRunner(
      this.aiPlayerService,
      gameConfig,
      this.metricsService
    );

    currentGameRunner = runner;

    // Set up event handling for real-time updates
    runner.onEvent((event, data) => {
      if (currentBatch) {
        if (event === 'turn:move') {
          currentBatch.currentGame = {
            id: runner.getGameId(),
            turn: data.turn,
            rankings: []
          };
        }
      }
    });

    // Run the game
    let result: GameResult;
    try {
      result = await runner.run();
    } finally {
      currentGameRunner = null;
    }

    // Save game transcript
    try {
      const transcriptPath = `games/simulations/${result.gameId}.json`;
      this.storage.writeJson(transcriptPath, {
        gameId: result.gameId,
        batchId: currentBatch.id,
        startedAt: result.startedAt.toISOString(),
        endedAt: result.endedAt.toISOString(),
        winner: result.winner,
        rankings: result.rankings,
        totalTurns: result.totalTurns,
        playerStats: result.playerStats,
        turns: result.turns.slice(0, 100), // Save first 100 turns to avoid huge files
        aborted: result.aborted,
        abortReason: result.abortReason
      });
    } catch (err) {
      console.error(`[SIM] Failed to save transcript: ${(err as Error).message}`);
    }

    return {
      gameId: result.gameId,
      winner: result.winner || 'none',
      rankings: result.rankings,
      turns: result.totalTurns
    };
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
