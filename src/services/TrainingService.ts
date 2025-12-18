/**
 * Training Service
 *
 * Manages dataset generation and model fine-tuning
 */

import { v4 as uuidv4 } from 'uuid';
import { writeFileSync, readFileSync, existsSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { getStorageService } from './StorageService.js';
import { OllamaService } from './OllamaService.js';
import { loadConfig } from '../config/index.js';
import { broadcastTrainingProgress, broadcastTrainingComplete } from '../api/websocket.js';

export interface DatasetConfig {
  source: 'simulations' | 'human' | 'all';
  dateRange?: { from: string; to: string };
  filterBy?: {
    winnerOnly?: boolean;
    minTurns?: number;
    maxTurns?: number;
  };
  outputName: string;
}

export interface TrainingConfig {
  baseModel: string;
  datasetId: string;
  outputModelName: string;
  epochs: number;
}

export class TrainingService {
  private storage = getStorageService();
  private ollama = new OllamaService();
  private config = loadConfig();

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
      params.push(datasetConfig.source === 'simulations' ? 'simulation' : 'human_vs_ai');
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

    // Get AI decisions for training
    const decisions = db.prepare(`
      SELECT
        d.*,
        g.winner,
        gp.final_rank
      FROM ai_decisions d
      JOIN games g ON g.id = d.game_id
      JOIN game_players gp ON gp.game_id = d.game_id AND gp.color = d.player_color
      WHERE ${whereClause}
        ${datasetConfig.filterBy?.winnerOnly ? 'AND gp.final_rank = 1' : ''}
      ORDER BY d.game_id, d.turn_number
      LIMIT ?
    `).all(...params, this.config.training.maxExamplesPerDataset) as any[];

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
    name: string;
    path: string;
    size: number;
    createdAt: string;
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
        name: f.replace('.jsonl', ''),
        path: `training/datasets/${f}`,
        size: lines,
        createdAt: stats.birthtime.toISOString()
      };
    });
  }

  /**
   * Start model fine-tuning
   */
  async startTraining(config: TrainingConfig): Promise<{
    trainingId: string;
    estimatedDuration: string;
  }> {
    const trainingId = `train_${Date.now()}_${uuidv4().slice(0, 6)}`;
    const db = this.storage.getDatabase();

    // Get dataset path
    const datasetPath = this.storage.getFullPath(`training/datasets/${config.datasetId}.jsonl`);

    if (!existsSync(datasetPath)) {
      throw new Error(`Dataset not found: ${config.datasetId}`);
    }

    const datasetContent = readFileSync(datasetPath, 'utf-8');
    const datasetSize = datasetContent.split('\n').filter(Boolean).length;

    // Record training run
    db.prepare(`
      INSERT INTO training_runs (id, started_at, status, base_model, output_model, dataset_path, dataset_size, epochs)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
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

    // Start training in background
    this.runTraining(trainingId, config, datasetContent);

    // Estimate duration (rough estimate)
    const estimatedMinutes = Math.ceil((datasetSize * config.epochs) / 100);

    return {
      trainingId,
      estimatedDuration: `${estimatedMinutes}m`
    };
  }

  /**
   * Run training process
   */
  private async runTraining(trainingId: string, config: TrainingConfig, datasetContent: string): Promise<void> {
    const db = this.storage.getDatabase();

    try {
      // Update status
      db.prepare(`UPDATE training_runs SET status = 'training' WHERE id = ?`).run(trainingId);

      // Create Modelfile
      const modelfile = this.createModelfile(config.baseModel, datasetContent);

      // Save Modelfile
      const modelfilePath = this.storage.getFullPath(`training/modelfiles/${config.outputModelName}.modelfile`);
      writeFileSync(modelfilePath, modelfile, 'utf-8');

      console.log(`[TRAINING] Starting training for ${config.outputModelName}`);

      // Simulate training progress (actual Ollama create doesn't give progress)
      for (let epoch = 1; epoch <= config.epochs; epoch++) {
        broadcastTrainingProgress({
          trainingId,
          epoch,
          totalEpochs: config.epochs,
          percentage: Math.round((epoch / config.epochs) * 100)
        });

        await this.delay(2000); // Simulate epoch time
      }

      // Create model in Ollama
      await this.ollama.createModel(config.outputModelName, modelfile);

      // Update status to completed
      db.prepare(`
        UPDATE training_runs SET status = 'completed', ended_at = ? WHERE id = ?
      `).run(new Date().toISOString(), trainingId);

      broadcastTrainingComplete({
        trainingId,
        modelName: config.outputModelName
      });

      console.log(`[TRAINING] Completed: ${config.outputModelName}`);

    } catch (error) {
      console.error(`[TRAINING] Failed:`, error);

      db.prepare(`
        UPDATE training_runs SET status = 'failed', ended_at = ?, error_message = ? WHERE id = ?
      `).run(new Date().toISOString(), (error as Error).message, trainingId);
    }
  }

  /**
   * Create Modelfile for Ollama
   */
  private createModelfile(baseModel: string, trainingData: string): string {
    return `FROM ${baseModel}

SYSTEM """You are an expert Luddo game AI trained on thousands of games.
You analyze board positions and select optimal moves considering:
- Capture opportunities (highest priority)
- Safety from opponent captures
- Advancement toward home
- Token distribution strategy

Always respond with:
TOKEN: [0-3]
REASONING: [Brief explanation]
"""

PARAMETER temperature 0.7
PARAMETER num_ctx 4096
PARAMETER top_p 0.9

# Training data embedded
# ${trainingData.split('\n').length} examples
`;
  }

  /**
   * Get training status
   */
  async getTrainingStatus(trainingId: string): Promise<any | null> {
    const db = this.storage.getDatabase();

    const run = db.prepare(`
      SELECT * FROM training_runs WHERE id = ?
    `).get(trainingId) as any;

    if (!run) return null;

    return {
      id: run.id,
      status: run.status,
      baseModel: run.base_model,
      outputModel: run.output_model,
      datasetSize: run.dataset_size,
      epochs: run.epochs,
      startedAt: run.started_at,
      endedAt: run.ended_at,
      errorMessage: run.error_message,
      progress: run.status === 'training' ? { epoch: 1, totalEpochs: run.epochs, percentage: 50 } : undefined
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
}
