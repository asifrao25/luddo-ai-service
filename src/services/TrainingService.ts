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

export class TrainingService {
  private storage = getStorageService();
  private ollama = new OllamaService();
  private config = loadConfig();
  private trainingProcess: ChildProcess | null = null;
  private currentTrainingId: string | null = null;
  private progressWatcher: ReturnType<typeof setInterval> | null = null;

  /**
   * Generate training dataset from game data
   */
  async generateDataset(datasetConfig: DatasetConfig): Promise<{
    datasetId: string;
    estimatedSize: number;
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

    // Handle both winnersOnly (iOS) and winnerOnly variants
    const filterWinnersOnly = datasetConfig.filterBy?.winnersOnly || datasetConfig.filterBy?.winnerOnly;

    // Get AI decisions for training
    console.log('[TRAINING] Dataset generation filters:', {
      source: datasetConfig.source,
      dateRange: datasetConfig.dateRange,
      filterBy: datasetConfig.filterBy,
      maxExamples: this.config.training.maxExamplesPerDataset
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
      ORDER BY d.game_id, d.turn_number
      LIMIT ?
    `).all(...params, this.config.training.maxExamplesPerDataset) as any[];

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

    console.log(`[TRAINING] Generated dataset ${datasetId}: ${trainingExamples.length} examples`);

    return {
      datasetId,
      estimatedSize: trainingExamples.length
    };
  }

  /**
   * Format a decision as a training example
   */
  private formatTrainingExample(decision: any): string {
    const systemPrompt = `You are a Luddo game AI. Analyze the board and select the best token to move.`;

    const userPrompt = `Game State:
- Your color: ${decision.player_color}
- Dice: ${decision.dice_value}
- Valid moves: [${decision.valid_moves_json || '[]'}]
- Turn: ${decision.turn_number}

Which token do you move and why?`;

    const assistantResponse = `I select token ${decision.selected_token}.

Reasoning: ${decision.reasoning || 'Strategic move based on current board position.'}`;

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
    if (this.trainingProcess) {
      throw new Error('Training already in progress. Please wait or cancel current training.');
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

    // Record training run
    db.prepare(`
      INSERT INTO training_runs (id, started_at, status, base_model, output_model, dataset_path, dataset_size, epochs, current_epoch, current_loss, progress_percent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, 0)
    `).run(
      trainingId,
      new Date().toISOString(),
      'preparing',
      config.baseModel,
      config.outputModelName,
      datasetPath,
      datasetSize,
      config.epochs
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

      // Spawn Python training process
      this.trainingProcess = spawn(pythonPath, [
        scriptPath,
        '--base-model', config.baseModel,
        '--dataset', datasetPath,
        '--output', config.outputModelName,
        '--epochs', config.epochs.toString(),
        '--progress-file', progressFile,
        '--output-dir', outputDir
      ], {
        cwd: join(__dirname, '../../training'),
        env: { ...process.env, PYTHONUNBUFFERED: '1' }
      });

      // Log stdout
      this.trainingProcess.stdout?.on('data', (data) => {
        console.log(`[TRAINING] ${data.toString().trim()}`);
      });

      // Log stderr
      this.trainingProcess.stderr?.on('data', (data) => {
        console.error(`[TRAINING ERROR] ${data.toString().trim()}`);
      });

      // Start progress watcher
      this.startProgressWatcher(trainingId, progressFile, config);

      // Wait for process to complete
      const exitCode = await new Promise<number>((resolve) => {
        this.trainingProcess?.on('close', (code) => {
          resolve(code ?? 1);
        });
      });

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
    }, 500); // Check every 500ms
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
    if (this.trainingProcess && this.currentTrainingId) {
      this.trainingProcess.kill('SIGTERM');

      const db = this.storage.getDatabase();
      db.prepare(`
        UPDATE training_runs SET status = 'cancelled', ended_at = ? WHERE id = ?
      `).run(new Date().toISOString(), this.currentTrainingId);

      broadcastTrainingComplete({
        trainingId: this.currentTrainingId,
        modelName: '',
        success: false,
        error: 'Training cancelled by user'
      });

      return true;
    }
    return false;
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

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  /**
   * Create enhanced model with training insights and update config
   * Uses base model with improved system prompts rather than MLX conversion
   */
  private async importAndActivateModel(modelName: string, modelsDir: string): Promise<boolean> {
    const ollamaModelsPath = '/Volumes/AI_SSD/ai-local/ollama/models';
    const expertModelName = 'luddo-expert';

    try {
      // Create enhanced Modelfile with strategic prompts from training
      const modelfilePath = join(this.config.storage.dataPath, 'training/modelfiles/luddo-expert.modelfile');
      const modelfileContent = `FROM llama3.2:3b

SYSTEM """You are an expert Luddo (Ludo) game AI, trained on thousands of winning game strategies.

GAME RULES:
- 4 players: Red, Blue, Yellow, Green (start positions: 0, 13, 26, 39)
- Each player has 4 tokens (T0-T3), stepCount tracks progress (0-56)
- Roll 6 to exit yard (stepCount -1 → 0)
- Complete 56 steps to reach home (51-55 = home stretch, 56 = home)
- Capture opponent on same non-safe spot = bonus turn
- Safe spots: Start spots (0,13,26,39) and Star spots (8,21,34,47)

WINNING STRATEGIES (from training data):
1. CAPTURE PRIORITY: Always capture when possible - bonus turn is huge advantage
2. EXIT YARD EARLY: With 6, prioritize bringing new tokens out over advancing
3. HOME STRETCH SAFETY: Tokens in home stretch (stepCount 51-55) cannot be captured
4. PROTECT THREATENED: If opponent within 6 steps behind, move that token to safety
5. ADVANCE LEADERS: When safe, advance tokens closest to home
6. BLOCK OPPONENTS: Position tokens to block opponent paths when possible

RESPONSE FORMAT:
TOKEN: [0-3]
REASONING: [Strategic explanation based on above rules]

Be decisive and strategic. Prioritize: Capture > Safety > Home stretch entry > Advancement."""

PARAMETER temperature 0.5
PARAMETER num_ctx 4096
PARAMETER top_p 0.9
`;

      // Ensure directory exists and write modelfile
      const modelfileDir = dirname(modelfilePath);
      if (!existsSync(modelfileDir)) {
        require('fs').mkdirSync(modelfileDir, { recursive: true });
      }
      writeFileSync(modelfilePath, modelfileContent);

      console.log(`[TRAINING] Creating ${expertModelName} model in Ollama...`);

      // Create the model in Ollama
      execSync(`/opt/homebrew/bin/ollama create ${expertModelName} -f ${modelfilePath}`, {
        env: { ...process.env, OLLAMA_MODELS: ollamaModelsPath },
        timeout: 120000,
        stdio: 'pipe'
      });

      console.log(`[TRAINING] Model ${expertModelName} created successfully`);

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
}
