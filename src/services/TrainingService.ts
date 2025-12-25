/**
 * Training Service
 *
 * Manages dataset generation and model fine-tuning using Unsloth LoRA
 */

import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync, unlinkSync, watchFile, unwatchFile } from 'fs';
import { join, dirname } from 'path';
import { spawn, ChildProcess, execSync } from 'child_process';
import { fileURLToPath } from 'url';
import pm2 from 'pm2';
import { getStorageService } from './StorageService.js';
import { OllamaService } from './OllamaService.js';
import { loadConfig, saveConfig, resetConfig } from '../config/index.js';
import { broadcastTrainingProgress, broadcastTrainingComplete } from '../api/websocket.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export interface DatasetConfig {
  source: 'simulations' | 'simulation' | 'human' | 'human_vs_ai' | 'all';
  dateRange?: { from: string; to: string };
  filterBy?: {
    winnerOnly?: boolean;
    winnersOnly?: boolean;  // iOS sends this variant
    minTurns?: number;
    maxTurns?: number;
    minConfidence?: number;
  };
  outputName: string;
  incrementalOnly?: boolean;  // Only include games not yet used in training
}

export interface TrainingConfig {
  baseModel: string;
  datasetId: string;
  outputModelName: string;
  epochs: number;
}

export interface TrainingProgress {
  stage: string;
  progress: number;
  message: string;
  epoch: number;
  total_epochs: number;
  loss: number | null;
  learning_rate: number | null;
  dataset_size?: number;
  step?: number;
  total_steps?: number;
  loss_history?: Array<{ step: number; loss: number; epoch: number }>;
  error?: string;
  final_loss?: number;
  model_path?: string;
  ollama_model?: string;
}

/**
 * Custom error for when training is already in progress
 * Includes the active training ID so clients can reconnect
 */
export class TrainingInProgressError extends Error {
  constructor(message: string, public readonly trainingId: string) {
    super(message);
    this.name = 'TrainingInProgressError';
  }
}

export class TrainingService {
  private storage = getStorageService();
  private ollama = new OllamaService();
  private config = loadConfig();
  private trainingProcess: ChildProcess | null = null;
  private currentTrainingId: string | null = null;
  private progressWatcher: ReturnType<typeof setInterval> | null = null;

  constructor() {
    // Try to recover active training on startup (async, non-blocking)
    this.recoverActiveTraining().catch(err =>
      console.error('[TRAINING] Recovery failed:', err)
    );
  }

  /**
   * Recover active training session on startup
   * If progress file exists, training may still be running - reconnect to it
   * If progress file missing, mark as failed
   */
  private async recoverActiveTraining(): Promise<void> {
    try {
      const db = this.storage.getDatabase();

      // Find any training run that's marked as "training" or "preparing"
      const activeRun = db.prepare(`
        SELECT id, output_model, base_model, epochs, dataset_path
        FROM training_runs
        WHERE status IN ('training', 'preparing')
        ORDER BY started_at DESC
        LIMIT 1
      `).get() as any;

      if (!activeRun) {
        console.log('[TRAINING] No active training to recover');
        return;
      }

      // Check if the progress file exists (indicates Python process may still be running)
      const progressFile = this.storage.getFullPath(`training/progress/${activeRun.id}.json`);

      // Check for checkpoint file (saved every 100 iterations)
      const modelDir = this.storage.getFullPath(`training/models/${activeRun.output_model}`);
      const checkpointFile = join(modelDir, 'checkpoint.json');
      const hasCheckpoint = existsSync(checkpointFile);

      // First, check if the training process is actually still running
      const isProcessRunning = await this.isTrainingProcessRunning(activeRun.id);

      if (isProcessRunning) {
        // Process is running - just reconnect to monitor it
        console.log(`[TRAINING] Training process already running, reconnecting: ${activeRun.id}`);
        this.currentTrainingId = activeRun.id;

        // Start watching the progress file
        this.startProgressWatcher(activeRun.id, progressFile, {
          baseModel: activeRun.base_model,
          datasetId: '',
          outputModelName: activeRun.output_model,
          epochs: activeRun.epochs
        });

        // Broadcast current progress if available
        if (existsSync(progressFile)) {
          try {
            const progress: TrainingProgress = JSON.parse(readFileSync(progressFile, 'utf-8'));
            broadcastTrainingProgress({
              trainingId: activeRun.id,
              stage: progress.stage,
              epoch: progress.epoch,
              totalEpochs: progress.total_epochs,
              percentage: progress.progress,
              loss: progress.loss,
              learningRate: progress.learning_rate,
              message: progress.message || 'Reconnected to training session',
              step: progress.step,
              totalSteps: progress.total_steps,
              lossHistory: progress.loss_history,
              datasetSize: progress.dataset_size
            });
          } catch (e) {
            console.log('[TRAINING] Could not read progress file for broadcast');
          }
        }
        return;
      }

      // Process is NOT running - check if we can resume or should mark as failed
      if (hasCheckpoint) {
        // Checkpoint exists - resume training
        console.log(`[TRAINING] Process stopped, resuming from checkpoint: ${activeRun.id}`);

        let checkpointData: any = {};
        try {
          checkpointData = JSON.parse(readFileSync(checkpointFile, 'utf-8'));
        } catch (e) {
          console.log('[TRAINING] Could not read checkpoint file');
        }

        // Resume training with --resume flag
        await this.resumeTraining(activeRun.id, {
          baseModel: activeRun.base_model,
          datasetId: '',
          outputModelName: activeRun.output_model,
          epochs: activeRun.epochs
        }, activeRun.dataset_path, checkpointData);

      } else {
        // No checkpoint and process not running - mark as failed (orphaned)
        const now = new Date().toISOString();
        db.prepare(`
          UPDATE training_runs
          SET status = 'failed', ended_at = ?, error_message = 'Training process stopped unexpectedly'
          WHERE id = ?
        `).run(now, activeRun.id);

        console.log(`[TRAINING] Marked orphaned training as failed: ${activeRun.id}`);
      }
    } catch (error) {
      console.error('[TRAINING] Failed to recover active training:', error);
    }
  }

  /**
   * Check if a training process is already running for the given training ID
   * Checks both PM2 managed processes and legacy spawn processes
   */
  private async isTrainingProcessRunning(trainingId: string): Promise<boolean> {
    // First check PM2
    const pm2ProcessName = `training-${trainingId}`;
    const pm2Running = await new Promise<boolean>((resolve) => {
      pm2.connect((err) => {
        if (err) {
          resolve(false);
          return;
        }
        pm2.describe(pm2ProcessName, (err, processDesc) => {
          pm2.disconnect();
          if (err || !processDesc || processDesc.length === 0) {
            resolve(false);
            return;
          }
          // Check if process is actually online
          const isOnline = processDesc.some((p: any) => p.pm2_env?.status === 'online');
          resolve(isOnline);
        });
      });
    });

    if (pm2Running) return true;

    // Fallback: check for legacy spawned processes (for backward compatibility)
    return new Promise((resolve) => {
      const { exec } = require('child_process');
      exec(`ps aux | grep "train.py" | grep "${trainingId}" | grep -v grep`, (error: any, stdout: string) => {
        resolve(stdout.trim().length > 0);
      });
    });
  }

  /**
   * Get the storage database for external access (e.g., routes)
   */
  getDatabase(): any {
    return this.storage.getDatabase();
  }

  /**
   * Generate training dataset from game data
   */
  async generateDataset(datasetConfig: DatasetConfig): Promise<{
    datasetId: string;
    estimatedSize: number;
    includedGameIds: string[];
    statistics: {
      gamesExamined: number;
      gamesIncluded: number;
      gamesExcluded: number;
      excludedStalemate: number;
      excludedAlreadyTrained: number;
    };
  }> {
    const datasetId = `ds_${Date.now()}_${uuidv4().slice(0, 6)}`;
    const db = this.storage.getDatabase();

    // Build query based on config
    let whereClause = '1=1';
    const params: any[] = [];

    if (datasetConfig.source !== 'all') {
      whereClause += ' AND g.type = ?';
      // Accept both 'simulation'/'simulations' and 'human'/'human_vs_ai' variants
      const isSimulation = datasetConfig.source === 'simulations' || datasetConfig.source === 'simulation';
      params.push(isSimulation ? 'simulation' : 'human_vs_ai');
    }

    if (datasetConfig.dateRange?.from) {
      whereClause += ' AND g.started_at >= ?';
      params.push(datasetConfig.dateRange.from);
    }

    if (datasetConfig.dateRange?.to) {
      whereClause += ' AND g.started_at <= ?';
      params.push(datasetConfig.dateRange.to);
    }

    if (datasetConfig.filterBy?.minTurns) {
      whereClause += ' AND g.total_turns >= ?';
      params.push(datasetConfig.filterBy.minTurns);
    }

    if (datasetConfig.filterBy?.maxTurns) {
      whereClause += ' AND g.total_turns <= ?';
      params.push(datasetConfig.filterBy.maxTurns);
    }

    if (datasetConfig.filterBy?.minConfidence) {
      whereClause += ' AND d.confidence >= ?';
      params.push(datasetConfig.filterBy.minConfidence);
    }

    // Handle incremental training - exclude games already used in completed training runs
    let excludedAlreadyTrained = 0;
    if (datasetConfig.incrementalOnly) {
      // Count games that would be excluded
      const alreadyTrainedCount = db.prepare(`
        SELECT COUNT(DISTINCT g.id) as count
        FROM games g
        WHERE ${whereClause}
          AND g.id IN (
            SELECT DISTINCT game_id FROM training_games
            WHERE training_run_id IN (
              SELECT id FROM training_runs WHERE status = 'completed'
            )
          )
      `).get(...params) as { count: number };
      excludedAlreadyTrained = alreadyTrainedCount.count;

      // Add exclusion clause
      whereClause += ` AND g.id NOT IN (
        SELECT DISTINCT game_id FROM training_games
        WHERE training_run_id IN (
          SELECT id FROM training_runs WHERE status = 'completed'
        )
      )`;
    }

    // Handle both winnersOnly (iOS) and winnerOnly variants
    const filterWinnersOnly = datasetConfig.filterBy?.winnersOnly || datasetConfig.filterBy?.winnerOnly;

    // Get statistics on game filtering BEFORE applying stalemate filter
    const gameStats = db.prepare(`
      SELECT
        COUNT(DISTINCT g.id) as total_games,
        SUM(CASE WHEN g.winner = 'none' THEN 1 ELSE 0 END) as stalemate_games
      FROM games g
      WHERE ${whereClause}
    `).get(...params) as { total_games: number; stalemate_games: number };

    // Get AI decisions for training
    console.log('[TRAINING] Dataset generation filters:', {
      source: datasetConfig.source,
      dateRange: datasetConfig.dateRange,
      filterBy: datasetConfig.filterBy,
      maxExamples: this.config.training.maxExamplesPerDataset,
      totalGamesBeforeFilter: gameStats.total_games,
      stalemateGames: gameStats.stalemate_games
    });

    const decisions = db.prepare(`
      SELECT
        d.*,
        g.winner,
        gp.final_rank
      FROM ai_decisions d
      JOIN games g ON g.id = d.game_id
      JOIN game_players gp ON gp.game_id = d.game_id AND gp.color = d.player_color
      WHERE ${whereClause}
        ${filterWinnersOnly ? 'AND gp.final_rank = 1' : ''}
        AND JSON_ARRAY_LENGTH(d.valid_moves_json) > 1
        AND g.winner != 'none'
      ORDER BY d.game_id, d.turn_number
      LIMIT ?
    `).all(...params, this.config.training.maxExamplesPerDataset) as any[];

    // Count unique games included in the dataset
    const includedGameIdsSet = new Set<string>(decisions.map(d => d.game_id));
    const includedGameIds = Array.from(includedGameIdsSet);
    const gamesIncluded = includedGameIds.length;

    console.log(`[TRAINING] Query returned ${decisions.length} AI decisions for training`);

    if (decisions.length === 0) {
      console.warn('[TRAINING] WARNING: No training samples found matching filter criteria!');
      console.warn('[TRAINING] This could be due to:');
      console.warn('[TRAINING]   - Date range not matching any games');
      console.warn('[TRAINING]   - Turn filters (minTurns/maxTurns) excluding all games');
      console.warn('[TRAINING]   - winnerOnly filter with no winning decisions');
      console.warn('[TRAINING]   - Source filter not matching game types in database');

      // Get game count to help diagnose
      const gameCount = db.prepare(`SELECT COUNT(*) as count FROM games WHERE ${whereClause}`).get(...params) as { count: number };
      console.warn(`[TRAINING] Found ${gameCount.count} games matching the WHERE clause`);
    }

    // Convert to JSONL format for Ollama training
    const trainingExamples = decisions.map(d => this.formatTrainingExample(d));

    // Write dataset file
    const datasetPath = `training/datasets/${datasetConfig.outputName}.jsonl`;
    const fullPath = this.storage.getFullPath(datasetPath);

    writeFileSync(fullPath, trainingExamples.join('\n'), 'utf-8');

    // Store metadata with game IDs for incremental training tracking
    const metaPath = `training/datasets/${datasetConfig.outputName}.meta.json`;
    const metaFullPath = this.storage.getFullPath(metaPath);
    writeFileSync(metaFullPath, JSON.stringify({
      datasetId,
      createdAt: new Date().toISOString(),
      gameIds: includedGameIds,
      incrementalOnly: datasetConfig.incrementalOnly || false
    }), 'utf-8');

    console.log(`[TRAINING] Generated dataset ${datasetId}: ${trainingExamples.length} examples from ${gamesIncluded} games (excluded ${gameStats.stalemate_games} stalemate, ${excludedAlreadyTrained} already trained)`);

    return {
      datasetId,
      estimatedSize: trainingExamples.length,
      includedGameIds,
      statistics: {
        gamesExamined: gameStats.total_games,
        gamesIncluded,
        gamesExcluded: gameStats.total_games - gamesIncluded,
        excludedStalemate: gameStats.stalemate_games,
        excludedAlreadyTrained
      }
    };
  }

  /**
   * Format a decision as a training example with rich context
   */
  private formatTrainingExample(decision: any): string {
    const validMoves = JSON.parse(decision.valid_moves_json || '[]');
    const isWinningPlayer = decision.final_rank === 1;

    // Rich system prompt with game knowledge
    const systemPrompt = `You are an expert Luddo game AI. You analyze board positions and select optimal moves.

RULES:
- Roll 6 to exit yard, capture opponent or reach home = bonus turn
- Safe spots: Start spots (0,13,26,39) and Stars (8,21,34,47)
- Complete 56 steps to reach home (steps 51-55 = home stretch, 56 = home)

PRIORITIES: Capture > Escape threat > Enter home stretch > Advance leader

Respond with: TOKEN: [number] and REASONING: [explanation]`;

    // Build contextual user prompt
    let userPrompt = `GAME STATE:
Color: ${decision.player_color.toUpperCase()}
Dice: ${decision.dice_value}
Turn: ${decision.turn_number}
Valid tokens: ${validMoves.join(', ')}`;

    // Add outcome hints if this was a good move
    if (decision.was_capture) {
      userPrompt += `\n\nOPPORTUNITY: Can capture opponent!`;
    }
    if (decision.reached_home) {
      userPrompt += `\n\nOPPORTUNITY: Can reach home!`;
    }

    userPrompt += `\n\nSelect the best token to move.`;

    // Build the assistant response with clear format
    let reasoning = decision.reasoning || 'Strategic positioning';
    // Clean up reasoning - remove "Only one valid move" entries (shouldn't be in training anyway)
    if (reasoning.includes('Only one valid move') || reasoning.includes('Fallback')) {
      reasoning = 'Strategic move to advance position';
    }

    // Add context about why this was a good move (from a winning player)
    if (isWinningPlayer && decision.was_capture) {
      reasoning = `Capture for bonus turn. ${reasoning}`;
    } else if (isWinningPlayer && decision.reached_home) {
      reasoning = `Reach home to secure position. ${reasoning}`;
    }

    const assistantResponse = `TOKEN: ${decision.selected_token}
REASONING: ${reasoning}`;

    return JSON.stringify({
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
        { role: 'assistant', content: assistantResponse }
      ]
    });
  }

  /**
   * List available datasets
   */
  async listDatasets(): Promise<Array<{
    id: string;
    createdAt: string;
    examples: number;
    source: string;
    sizeBytes: number;
  }>> {
    const datasetsPath = this.storage.getFullPath('training/datasets');

    if (!existsSync(datasetsPath)) {
      return [];
    }

    const files = readdirSync(datasetsPath).filter(f => f.endsWith('.jsonl'));

    return files.map(f => {
      const fullPath = join(datasetsPath, f);
      const stats = statSync(fullPath);
      const content = readFileSync(fullPath, 'utf-8');
      const lines = content.split('\n').filter(Boolean).length;

      return {
        id: f.replace('.jsonl', ''),
        createdAt: stats.birthtime.toISOString(),
        examples: lines,
        source: 'simulation',
        sizeBytes: stats.size
      };
    });
  }

  /**
   * Start model fine-tuning with real LoRA training
   */
  async startTraining(config: TrainingConfig): Promise<{
    trainingId: string;
    estimatedDuration: string;
  }> {
    // Check if training already in progress
    if (this.trainingProcess && this.currentTrainingId) {
      throw new TrainingInProgressError(
        'Training already in progress. Please wait or cancel current training.',
        this.currentTrainingId
      );
    }

    const trainingId = `train_${Date.now()}_${uuidv4().slice(0, 6)}`;
    const db = this.storage.getDatabase();

    // Get dataset path
    const datasetPath = this.storage.getFullPath(`training/datasets/${config.datasetId}.jsonl`);

    if (!existsSync(datasetPath)) {
      throw new Error(`Dataset not found: ${config.datasetId}`);
    }

    const datasetContent = readFileSync(datasetPath, 'utf-8');
    const datasetSize = datasetContent.split('\n').filter(Boolean).length;

    if (datasetSize < 10) {
      throw new Error(`Dataset too small: ${datasetSize} examples. Need at least 10 for training.`);
    }

    // Get next version number (auto-increment based on completed training runs)
    const lastVersion = db.prepare(`
      SELECT MAX(version) as maxVersion FROM training_runs WHERE status = 'completed'
    `).get() as { maxVersion: number | null };
    const nextVersion = (lastVersion?.maxVersion ?? 0) + 1;

    console.log(`[TRAINING] Starting training V${nextVersion}.0 for ${config.outputModelName}`);

    // Record training run with version
    db.prepare(`
      INSERT INTO training_runs (id, started_at, status, base_model, output_model, dataset_path, dataset_size, epochs, current_epoch, current_loss, progress_percent, version)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0, ?)
    `).run(
      trainingId,
      new Date().toISOString(),
      'preparing',
      config.baseModel,
      config.outputModelName,
      datasetPath,
      datasetSize,
      config.epochs,
      nextVersion
    );

    // Start training in background (pass path, not content)
    this.runTraining(trainingId, config, datasetPath);

    // Estimate duration based on dataset size and epochs
    // Roughly 1-2 minutes per 100 examples per epoch on M4
    const estimatedMinutes = Math.ceil((datasetSize * config.epochs) / 50);

    return {
      trainingId,
      estimatedDuration: `~${estimatedMinutes}m`
    };
  }

  /**
   * Run training process using Python Unsloth script
   */
  private async runTraining(trainingId: string, config: TrainingConfig, datasetPath: string): Promise<void> {
    const db = this.storage.getDatabase();
    this.currentTrainingId = trainingId;

    // Progress file for Python to write updates
    const progressFile = this.storage.getFullPath(`training/progress/${trainingId}.json`);
    const outputDir = this.storage.getFullPath('training/models');

    // Ensure progress directory exists
    const progressDir = this.storage.getFullPath('training/progress');
    if (!existsSync(progressDir)) {
      require('fs').mkdirSync(progressDir, { recursive: true });
    }

    // Initialize progress file
    writeFileSync(progressFile, JSON.stringify({
      stage: 'starting',
      progress: 0,
      message: 'Initializing training...',
      epoch: 0,
      total_epochs: config.epochs,
      loss: null,
      learning_rate: null
    }));

    try {
      // Update status
      db.prepare(`UPDATE training_runs SET status = 'training' WHERE id = ?`).run(trainingId);

      console.log(`[TRAINING] Starting real fine-tuning for ${config.outputModelName}`);
      console.log(`[TRAINING] Base model: ${config.baseModel}`);
      console.log(`[TRAINING] Dataset: ${datasetPath}`);
      console.log(`[TRAINING] Epochs: ${config.epochs}`);

      // Find Python script path
      const scriptPath = join(__dirname, '../../training/train.py');

      // Use virtual environment Python for training
      const pythonPath = join(__dirname, '../../training/venv/bin/python');
      const trainingCwd = join(__dirname, '../../training');

      // Create config file for PM2 to read
      const configFile = this.storage.getFullPath(`training/progress/${trainingId}.config.json`);
      writeFileSync(configFile, JSON.stringify({
        baseModel: config.baseModel,
        dataset: datasetPath,
        output: config.outputModelName,
        epochs: config.epochs,
        progressFile: progressFile,
        outputDir: outputDir,
        resume: false
      }));

      // Start training as independent PM2 process
      const pm2ProcessName = `training-${trainingId}`;
      await new Promise<void>((resolve, reject) => {
        pm2.connect((err) => {
          if (err) {
            console.error('[TRAINING] PM2 connect error:', err);
            reject(err);
            return;
          }

          pm2.start({
            name: pm2ProcessName,
            script: pythonPath,
            args: [scriptPath, '--config', configFile],
            cwd: trainingCwd,
            interpreter: 'none',  // Python is the script itself
            autorestart: false,
            max_restarts: 0,
            env: { PYTHONUNBUFFERED: '1' }
          }, (err) => {
            if (err) {
              console.error('[TRAINING] PM2 start error:', err);
              pm2.disconnect();
              reject(err);
              return;
            }
            console.log(`[TRAINING] Started PM2 process: ${pm2ProcessName}`);
            pm2.disconnect();
            resolve();
          });
        });
      });

      // Start progress watcher
      this.startProgressWatcher(trainingId, progressFile, config);

      // Wait for training to complete by watching progress file
      const exitCode = await this.waitForTrainingCompletion(trainingId, progressFile);

      // Stop progress watcher
      this.stopProgressWatcher();

      // Read final progress
      let finalProgress: TrainingProgress | null = null;
      if (existsSync(progressFile)) {
        try {
          finalProgress = JSON.parse(readFileSync(progressFile, 'utf-8'));
        } catch (e) {
          console.error('[TRAINING] Failed to read final progress:', e);
        }
      }

      if (exitCode === 0 && finalProgress?.stage === 'completed') {
        // Success
        db.prepare(`
          UPDATE training_runs
          SET status = 'completed', ended_at = ?, final_loss = ?
          WHERE id = ?
        `).run(
          new Date().toISOString(),
          finalProgress.final_loss,
          trainingId
        );

        // Record games used in training (for incremental training)
        const metaPath = datasetPath.replace('.jsonl', '.meta.json');
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            if (meta.gameIds && Array.isArray(meta.gameIds)) {
              this.recordTrainingGames(trainingId, meta.gameIds);
            }
          } catch (e) {
            console.error('[TRAINING] Failed to read dataset metadata:', e);
          }
        }

        // Auto-import fine-tuned model into Ollama and update config
        const importSuccess = await this.importAndActivateModel(config.outputModelName, outputDir);

        broadcastTrainingComplete({
          trainingId,
          modelName: config.outputModelName,
          success: true,
          finalLoss: finalProgress.final_loss
        });

        console.log(`[TRAINING] Completed: ${config.outputModelName} (loss: ${finalProgress.final_loss}, activated: ${importSuccess})`);
      } else {
        // Failed
        const errorMsg = finalProgress?.error || `Training process exited with code ${exitCode}`;
        throw new Error(errorMsg);
      }

    } catch (error) {
      console.error(`[TRAINING] Failed:`, error);

      db.prepare(`
        UPDATE training_runs SET status = 'failed', ended_at = ?, error_message = ? WHERE id = ?
      `).run(new Date().toISOString(), (error as Error).message, trainingId);

      broadcastTrainingComplete({
        trainingId,
        modelName: config.outputModelName,
        success: false,
        error: (error as Error).message
      });
    } finally {
      this.trainingProcess = null;
      this.currentTrainingId = null;

      // Clean up progress file after a delay
      setTimeout(() => {
        if (existsSync(progressFile)) {
          try { unlinkSync(progressFile); } catch (e) {}
        }
      }, 60000); // Keep for 1 minute for debugging
    }
  }

  /**
   * Resume an interrupted training from checkpoint
   */
  private async resumeTraining(
    trainingId: string,
    config: TrainingConfig,
    datasetPath: string,
    checkpointData: any
  ): Promise<void> {
    const db = this.storage.getDatabase();
    this.currentTrainingId = trainingId;

    // Progress file for Python to write updates
    const progressFile = this.storage.getFullPath(`training/progress/${trainingId}.json`);
    const outputDir = this.storage.getFullPath('training/models');

    // Initialize progress file with checkpoint state
    writeFileSync(progressFile, JSON.stringify({
      stage: 'resuming',
      progress: checkpointData.last_iter ? Math.floor((checkpointData.last_iter / checkpointData.total_iters) * 95) : 0,
      message: `Resuming from iteration ${checkpointData.last_iter || 0}...`,
      epoch: checkpointData.epoch || 1,
      total_epochs: config.epochs,
      loss: checkpointData.last_loss || null,
      learning_rate: 1e-5,
      loss_history: checkpointData.loss_history || []
    }));

    try {
      console.log(`[TRAINING] Resuming training ${trainingId} from iteration ${checkpointData.last_iter || 0}`);

      // Find Python script path
      const scriptPath = join(__dirname, '../../training/train.py');
      const pythonPath = join(__dirname, '../../training/venv/bin/python');
      const trainingCwd = join(__dirname, '../../training');

      // Create config file for PM2 to read
      const configFile = this.storage.getFullPath(`training/progress/${trainingId}.config.json`);
      writeFileSync(configFile, JSON.stringify({
        baseModel: config.baseModel,
        dataset: datasetPath,
        output: config.outputModelName,
        epochs: config.epochs,
        progressFile: progressFile,
        outputDir: outputDir,
        resume: true  // Resume from checkpoint
      }));

      // Start training as independent PM2 process
      const pm2ProcessName = `training-${trainingId}`;
      await new Promise<void>((resolve, reject) => {
        pm2.connect((err) => {
          if (err) {
            console.error('[TRAINING] PM2 connect error:', err);
            reject(err);
            return;
          }

          pm2.start({
            name: pm2ProcessName,
            script: pythonPath,
            args: [scriptPath, '--config', configFile],
            cwd: trainingCwd,
            interpreter: 'none',
            autorestart: false,
            max_restarts: 0,
            env: { PYTHONUNBUFFERED: '1' }
          }, (err) => {
            if (err) {
              console.error('[TRAINING] PM2 start error:', err);
              pm2.disconnect();
              reject(err);
              return;
            }
            console.log(`[TRAINING] Resumed PM2 process: ${pm2ProcessName}`);
            pm2.disconnect();
            resolve();
          });
        });
      });

      // Start progress watcher
      this.startProgressWatcher(trainingId, progressFile, config);

      // Wait for training to complete by watching progress file
      const exitCode = await this.waitForTrainingCompletion(trainingId, progressFile);

      // Stop progress watcher
      this.stopProgressWatcher();

      // Read final progress
      let finalProgress: TrainingProgress | null = null;
      if (existsSync(progressFile)) {
        try {
          finalProgress = JSON.parse(readFileSync(progressFile, 'utf-8'));
        } catch (e) {
          console.error('[TRAINING] Failed to read final progress:', e);
        }
      }

      if (exitCode === 0 && finalProgress?.stage === 'completed') {
        // Success
        db.prepare(`
          UPDATE training_runs
          SET status = 'completed', ended_at = ?, final_loss = ?
          WHERE id = ?
        `).run(
          new Date().toISOString(),
          finalProgress.final_loss,
          trainingId
        );

        // Record games used in training
        const metaPath = datasetPath.replace('.jsonl', '.meta.json');
        if (existsSync(metaPath)) {
          try {
            const meta = JSON.parse(readFileSync(metaPath, 'utf-8'));
            if (meta.gameIds && Array.isArray(meta.gameIds)) {
              this.recordTrainingGames(trainingId, meta.gameIds);
            }
          } catch (e) {
            console.error('[TRAINING] Failed to read dataset metadata:', e);
          }
        }

        // Auto-import fine-tuned model into Ollama
        await this.importAndActivateModel(config.outputModelName, outputDir);

        broadcastTrainingComplete({
          trainingId,
          modelName: config.outputModelName,
          success: true,
          finalLoss: finalProgress.final_loss
        });

        console.log(`[TRAINING] Resumed and completed: ${config.outputModelName}`);
      } else {
        const errorMsg = finalProgress?.error || `Training process exited with code ${exitCode}`;
        throw new Error(errorMsg);
      }

    } catch (error) {
      console.error(`[TRAINING] Resume failed:`, error);

      db.prepare(`
        UPDATE training_runs SET status = 'failed', ended_at = ?, error_message = ? WHERE id = ?
      `).run(new Date().toISOString(), (error as Error).message, trainingId);

      broadcastTrainingComplete({
        trainingId,
        modelName: config.outputModelName,
        success: false,
        error: (error as Error).message
      });
    } finally {
      this.trainingProcess = null;
      this.currentTrainingId = null;

      // Clean up progress file after a delay
      setTimeout(() => {
        if (existsSync(progressFile)) {
          try { unlinkSync(progressFile); } catch (e) {}
        }
      }, 60000);
    }
  }

  /**
   * Wait for training to complete by monitoring progress file
   * Returns exit code (0 for success, 1 for failure)
   */
  private async waitForTrainingCompletion(trainingId: string, progressFile: string): Promise<number> {
    return new Promise((resolve) => {
      const checkInterval = setInterval(() => {
        if (!existsSync(progressFile)) return;

        try {
          const content = readFileSync(progressFile, 'utf-8');
          const progress: TrainingProgress = JSON.parse(content);

          if (progress.stage === 'completed') {
            clearInterval(checkInterval);
            // Clean up PM2 process
            this.cleanupPM2Process(trainingId);
            resolve(0);
          } else if (progress.stage === 'failed' || progress.error) {
            clearInterval(checkInterval);
            // Clean up PM2 process
            this.cleanupPM2Process(trainingId);
            resolve(1);
          }
        } catch (e) {
          // File might be mid-write, ignore
        }
      }, 1000);

      // Timeout after 24 hours (very long training sessions)
      setTimeout(() => {
        clearInterval(checkInterval);
        this.cleanupPM2Process(trainingId);
        resolve(1);
      }, 24 * 60 * 60 * 1000);
    });
  }

  /**
   * Clean up PM2 process after training completes
   */
  private cleanupPM2Process(trainingId: string): void {
    const pm2ProcessName = `training-${trainingId}`;
    pm2.connect((err) => {
      if (err) return;
      pm2.delete(pm2ProcessName, () => {
        pm2.disconnect();
      });
    });
  }

  /**
   * Start watching progress file for updates
   */
  private startProgressWatcher(trainingId: string, progressFile: string, config: TrainingConfig): void {
    let lastProgress: TrainingProgress | null = null;

    this.progressWatcher = setInterval(() => {
      if (!existsSync(progressFile)) return;

      try {
        const content = readFileSync(progressFile, 'utf-8');
        const progress: TrainingProgress = JSON.parse(content);

        // Only broadcast if changed
        if (JSON.stringify(progress) !== JSON.stringify(lastProgress)) {
          lastProgress = progress;

          // Broadcast to WebSocket clients
          broadcastTrainingProgress({
            trainingId,
            stage: progress.stage,
            epoch: progress.epoch,
            totalEpochs: progress.total_epochs,
            percentage: progress.progress,
            loss: progress.loss,
            learningRate: progress.learning_rate,
            message: progress.message,
            step: progress.step,
            totalSteps: progress.total_steps,
            lossHistory: progress.loss_history,
            datasetSize: progress.dataset_size
          });

          // Also update database with current progress
          const db = this.storage.getDatabase();
          db.prepare(`
            UPDATE training_runs
            SET current_epoch = ?, current_loss = ?, progress_percent = ?
            WHERE id = ?
          `).run(progress.epoch, progress.loss, progress.progress, trainingId);
        }
      } catch (e) {
        // Ignore parse errors (file might be being written)
      }
    }, 100); // Check every 100ms for real-time updates
  }

  /**
   * Stop progress watcher
   */
  private stopProgressWatcher(): void {
    if (this.progressWatcher) {
      clearInterval(this.progressWatcher);
      this.progressWatcher = null;
    }
  }

  /**
   * Cancel current training
   */
  async cancelTraining(): Promise<boolean> {
    // Get training ID from memory or database
    let trainingId: string | null = this.currentTrainingId;

    if (!trainingId) {
      // Check database for active training (in case service was restarted)
      const db = this.storage.getDatabase();
      const activeRun = db.prepare(`
        SELECT id FROM training_runs
        WHERE status IN ('training', 'preparing')
        ORDER BY started_at DESC LIMIT 1
      `).get() as any;

      if (!activeRun) return false;
      trainingId = activeRun.id as string;
    }

    const pm2ProcessName = `training-${trainingId!}`;

    // Try to stop PM2 process first
    await new Promise<void>((resolve) => {
      pm2.connect((err) => {
        if (err) {
          resolve();
          return;
        }
        pm2.delete(pm2ProcessName, () => {
          pm2.disconnect();
          resolve();
        });
      });
    });

    // Also kill legacy spawned process if exists
    if (this.trainingProcess) {
      this.trainingProcess.kill('SIGTERM');
    }

    const db = this.storage.getDatabase();
    db.prepare(`
      UPDATE training_runs SET status = 'failed', ended_at = ?, error_message = 'Cancelled by user' WHERE id = ?
    `).run(new Date().toISOString(), trainingId!);

    broadcastTrainingComplete({
      trainingId: trainingId!,
      modelName: '',
      success: false,
      error: 'Training cancelled by user'
    });

    this.stopProgressWatcher();
    this.currentTrainingId = null;
    this.trainingProcess = null;

    return true;
  }

  /**
   * Get current training progress from file
   */
  async getCurrentProgress(): Promise<TrainingProgress | null> {
    if (!this.currentTrainingId) return null;

    const progressFile = this.storage.getFullPath(`training/progress/${this.currentTrainingId}.json`);
    if (!existsSync(progressFile)) return null;

    try {
      return JSON.parse(readFileSync(progressFile, 'utf-8'));
    } catch (e) {
      return null;
    }
  }

  /**
   * Get training status with live progress
   */
  async getTrainingStatus(trainingId: string): Promise<any | null> {
    const db = this.storage.getDatabase();

    const run = db.prepare(`
      SELECT * FROM training_runs WHERE id = ?
    `).get(trainingId) as any;

    if (!run) return null;

    // Get live progress if this is the current training
    let liveProgress: TrainingProgress | null = null;
    if (trainingId === this.currentTrainingId) {
      liveProgress = await this.getCurrentProgress();
    }

    const isTraining = run.status === 'training';
    const isCompleted = run.status === 'completed';

    // Use live progress if available, otherwise use DB values
    const progress = liveProgress?.progress ?? run.progress_percent ?? (isCompleted ? 100 : 0);
    const currentEpoch = liveProgress?.epoch ?? run.current_epoch ?? (isCompleted ? run.epochs : 0);
    const currentLoss = liveProgress?.loss ?? run.current_loss;

    // Estimate completion time - only during actual training stage (not loading/preparing)
    let estimatedCompletion: string | null = null;
    const isActuallyTraining = liveProgress?.stage === 'training' && progress >= 30 && progress < 100;
    if (isTraining && run.started_at && isActuallyTraining) {
      const startTime = new Date(run.started_at).getTime();
      const elapsed = Date.now() - startTime;
      // Calculate remaining time based on current progress
      const progressRemaining = 100 - progress;
      const timePerPercent = elapsed / progress;
      const estimatedRemaining = timePerPercent * progressRemaining;
      estimatedCompletion = new Date(Date.now() + estimatedRemaining).toISOString();
    }

    return {
      id: run.id,
      status: run.status,
      stage: liveProgress?.stage ?? run.status,
      progress,
      baseModel: run.base_model,
      outputModel: run.output_model,
      datasetSize: run.dataset_size,
      epochs: run.epochs,
      currentEpoch,
      currentLoss,
      learningRate: liveProgress?.learning_rate,
      step: liveProgress?.step,
      totalSteps: liveProgress?.total_steps,
      lossHistory: liveProgress?.loss_history,
      message: liveProgress?.message,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      estimatedCompletion,
      finalLoss: run.final_loss,
      errorMessage: run.error_message
    };
  }

  /**
   * Get training history
   */
  async getHistory(): Promise<any[]> {
    const db = this.storage.getDatabase();

    return db.prepare(`
      SELECT * FROM training_runs ORDER BY started_at DESC LIMIT 50
    `).all();
  }

  /**
   * Delete a dataset (file and any references)
   */
  async deleteDataset(datasetId: string): Promise<void> {
    const datasetPath = join(this.config.storage.dataPath, 'training/datasets', `${datasetId}.jsonl`);

    // Delete the file if it exists
    if (existsSync(datasetPath)) {
      unlinkSync(datasetPath);
      console.log(`[TRAINING] Deleted dataset file: ${datasetPath}`);
    } else {
      console.log(`[TRAINING] Dataset file not found (already deleted): ${datasetPath}`);
    }
  }

  /**
   * Delete a training run record
   */
  async deleteTrainingRun(runId: string): Promise<void> {
    const db = this.storage.getDatabase();

    // Check if run exists
    const run = db.prepare(`SELECT id FROM training_runs WHERE id = ?`).get(runId);
    if (!run) {
      throw new Error(`Training run ${runId} not found`);
    }

    // Delete the run record
    db.prepare(`DELETE FROM training_runs WHERE id = ?`).run(runId);
    console.log(`[TRAINING] Deleted training run ${runId}`);
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Import trained model to Ollama and activate it
   * PRIORITY: Use actual LoRA-trained fused model if available
   * FALLBACK: Use base model with enhanced prompts if training failed
   */
  private async importAndActivateModel(modelName: string, modelsDir: string): Promise<boolean> {
    const ollamaModelsPath = '/Volumes/AI_SSD/ai-local/ollama/models';
    const expertModelName = 'luddo-expert';

    // PRIORITY 1: Look for GGUF files (best format for Ollama)
    const ggufPaths = [
      join(modelsDir, modelName, `${modelName}.gguf`),
      join(modelsDir, `${modelName}-luddo-finetuned`, `${modelName}.gguf`),
      join(modelsDir, 'luddo-expert-luddo-finetuned', 'luddo-expert-f16.gguf'),
      join(modelsDir, 'luddo-expert-luddo-finetuned', 'luddo-expert.gguf'),
    ];

    let ggufPath: string | null = null;
    for (const path of ggufPaths) {
      if (existsSync(path)) {
        ggufPath = path;
        break;
      }
    }

    // PRIORITY 2: Look for fused safetensors model (fallback)
    const fusedPaths = [
      join(modelsDir, modelName, 'fused'),
      join(modelsDir, `${modelName}-luddo-finetuned`, 'fused'),
      join(modelsDir, 'luddo-expert-luddo-finetuned', 'fused'),
      join(modelsDir, 'llama3.2-luddo-finetuned', 'fused'),
    ];

    let fusedModelPath: string | null = null;
    for (const path of fusedPaths) {
      if (existsSync(path) && existsSync(join(path, 'config.json'))) {
        fusedModelPath = path;
        break;
      }
    }

    console.log(`[TRAINING] Searched for GGUF in: ${ggufPaths.join(', ')}`);
    console.log(`[TRAINING] Found GGUF: ${ggufPath || 'none'}`);
    console.log(`[TRAINING] Searched for fused model in: ${fusedPaths.join(', ')}`);
    console.log(`[TRAINING] Found fused model: ${fusedModelPath || 'none'}`);

    try {
      const modelfilePath = join(this.config.storage.dataPath, 'training/modelfiles/luddo-expert.modelfile');
      const modelfileDir = dirname(modelfilePath);

      if (!existsSync(modelfileDir)) {
        require('fs').mkdirSync(modelfileDir, { recursive: true });
      }

      let modelfileContent: string;
      let modelSource: string | null = null;

      if (ggufPath) {
        // BEST: Use GGUF file directly - native Ollama format
        modelSource = ggufPath;
        console.log(`[TRAINING] ✅ Using GGUF model from: ${ggufPath}`);

        modelfileContent = `FROM ${ggufPath}

SYSTEM """You are an expert Luddo game AI, fine-tuned with LoRA on winning game decisions.

RULES:
- Roll 6 to exit yard, capture or reach home = bonus turn
- Safe spots: Start (0,13,26,39) and Stars (8,21,34,47)
- 56 steps to home (51-55 = home stretch)

PRIORITIES: Capture > Escape threat > Home stretch > Advance

Respond: TOKEN: [0-3] and REASONING: [explanation]"""

PARAMETER temperature 0.5
PARAMETER num_ctx 4096
`;
      } else if (fusedModelPath) {
        // FALLBACK 1: Use fused safetensors (may not work with all Ollama versions)
        modelSource = fusedModelPath;
        console.log(`[TRAINING] ⚠️ Using fused safetensors model (GGUF preferred): ${fusedModelPath}`);

        modelfileContent = `FROM ${fusedModelPath}

SYSTEM """You are an expert Luddo game AI, fine-tuned with LoRA on winning game decisions.

RULES:
- Roll 6 to exit yard, capture or reach home = bonus turn
- Safe spots: Start (0,13,26,39) and Stars (8,21,34,47)
- 56 steps to home (51-55 = home stretch)

PRIORITIES: Capture > Escape threat > Home stretch > Advance

Respond: TOKEN: [0-3] and REASONING: [explanation]"""

PARAMETER temperature 0.5
PARAMETER num_ctx 4096
`;
      } else {
        // FALLBACK 2: No trained model, use base with enhanced prompts
        console.log(`[TRAINING] ⚠️ No trained model found, falling back to base model + enhanced prompts`);

        modelfileContent = `FROM llama3.2:3b

SYSTEM """You are an expert Luddo (Ludo) game AI.

GAME RULES:
- 4 players: Red, Blue, Yellow, Green (start positions: 0, 13, 26, 39)
- Each player has 4 tokens (T0-T3), stepCount tracks progress (0-56)
- Roll 6 to exit yard, complete 56 steps to reach home
- Capture opponent on non-safe spot = bonus turn
- Safe spots: Start spots (0,13,26,39) and Star spots (8,21,34,47)

STRATEGIES:
1. CAPTURE when possible - bonus turn advantage
2. EXIT YARD with 6s - more tokens = more options
3. ESCAPE THREATS - move tokens with opponents within 6 behind
4. ADVANCE LEADERS - progress tokens closest to home

RESPONSE FORMAT:
TOKEN: [0-3]
REASONING: [Strategic explanation]"""

PARAMETER temperature 0.5
PARAMETER num_ctx 4096
PARAMETER top_p 0.9
`;
      }

      writeFileSync(modelfilePath, modelfileContent);

      console.log(`[TRAINING] Creating ${expertModelName} model in Ollama...`);

      // Create the model in Ollama
      execSync(`/opt/homebrew/bin/ollama create ${expertModelName} -f ${modelfilePath}`, {
        env: { ...process.env, OLLAMA_MODELS: ollamaModelsPath },
        timeout: 300000, // 5 min timeout for larger fused models
        stdio: 'pipe'
      });

      console.log(`[TRAINING] Model ${expertModelName} created successfully (source: ${modelSource ? 'trained' : 'base'})`);

      // Update service config to use the expert model
      const currentConfig = loadConfig();
      currentConfig.ollama.defaultModel = expertModelName;
      saveConfig(currentConfig);
      resetConfig();

      console.log(`[TRAINING] Config updated: defaultModel = ${expertModelName}`);

      return true;

    } catch (error) {
      console.error(`[TRAINING] Failed to create expert model:`, error);

      // Fallback: just use base llama3.2:3b
      try {
        const currentConfig = loadConfig();
        currentConfig.ollama.defaultModel = 'llama3.2:3b';
        saveConfig(currentConfig);
        resetConfig();
        console.log(`[TRAINING] Fallback: using base llama3.2:3b model`);
      } catch (e) {
        console.error(`[TRAINING] Failed to set fallback model:`, e);
      }

      return false;
    }
  }

  /**
   * Record which games were used in a training run (for incremental training)
   */
  recordTrainingGames(trainingRunId: string, gameIds: string[]): void {
    if (gameIds.length === 0) return;

    const db = this.storage.getDatabase();
    const insert = db.prepare(`
      INSERT OR IGNORE INTO training_games (training_run_id, game_id)
      VALUES (?, ?)
    `);

    const insertMany = db.transaction((ids: string[]) => {
      for (const gameId of ids) {
        insert.run(trainingRunId, gameId);
      }
    });

    insertMany(gameIds);
    console.log(`[TRAINING] Recorded ${gameIds.length} games for training run ${trainingRunId}`);
  }

  /**
   * Get count of games that haven't been used in training yet
   */
  getUntrainedGamesCount(filters?: { source?: string }): { total: number; untrained: number } {
    const db = this.storage.getDatabase();

    let whereClause = '1=1';
    const params: any[] = [];

    if (filters?.source && filters.source !== 'all') {
      whereClause += ' AND g.type = ?';
      const isSimulation = filters.source === 'simulations' || filters.source === 'simulation';
      params.push(isSimulation ? 'simulation' : 'human_vs_ai');
    }

    // Total games matching filters (excluding stalemates)
    const totalResult = db.prepare(`
      SELECT COUNT(*) as count
      FROM games g
      WHERE ${whereClause}
        AND g.winner != 'none'
    `).get(...params) as { count: number };

    // Games already used in completed training runs
    const trainedResult = db.prepare(`
      SELECT COUNT(DISTINCT g.id) as count
      FROM games g
      WHERE ${whereClause}
        AND g.winner != 'none'
        AND g.id IN (
          SELECT DISTINCT game_id FROM training_games
          WHERE training_run_id IN (
            SELECT id FROM training_runs WHERE status = 'completed'
          )
        )
    `).get(...params) as { count: number };

    return {
      total: totalResult.count,
      untrained: totalResult.count - trainedResult.count
    };
  }

  /**
   * Get untrained game counts for ALL data sources at once
   * More efficient than multiple separate API calls
   */
  getUntrainedCountsAll(): {
    all: { total: number; untrained: number };
    simulation: { total: number; untrained: number };
    human_vs_ai: { total: number; untrained: number };
    human_vs_human: { total: number; untrained: number };
  } {
    return {
      all: this.getUntrainedGamesCount({ source: 'all' }),
      simulation: this.getUntrainedGamesCount({ source: 'simulation' }),
      human_vs_ai: this.getUntrainedGamesCount({ source: 'human_vs_ai' }),
      human_vs_human: this.getUntrainedGamesCount({ source: 'human_vs_human' })
    };
  }
}
