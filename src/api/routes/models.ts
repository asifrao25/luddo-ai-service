/**
 * Model Management API Routes
 *
 * Endpoints:
 * GET    /api/models         - List available models
 * POST   /api/models/switch  - Switch active model
 * DELETE /api/models/:name   - Delete model
 */

import { Router } from 'express';
import { OllamaService } from '../../services/OllamaService.js';
import { loadConfig, saveConfig } from '../../config/index.js';

const router = Router();
const ollamaService = new OllamaService();

// Get current active model info
router.get('/current', async (req, res) => {
  try {
    const config = loadConfig();
    const modelName = config.ollama.defaultModel;
    const models = await ollamaService.listModels();

    // Find the current model in the list
    const currentModel = models.find(m => m.name === modelName || m.name === `${modelName}:latest`);

    let modelInfo = {
      name: modelName,
      displayName: modelName.replace(/:latest$/, ''),
      createdAt: new Date().toISOString(),
      size: 'unknown',
      family: 'Unknown'
    };

    if (currentModel) {
      modelInfo.size = currentModel.size ? String(currentModel.size) : 'unknown';
      modelInfo.createdAt = currentModel.modified_at || new Date().toISOString();
    }

    // Determine family from model name
    const nameLower = modelName.toLowerCase();
    if (nameLower.includes('luddo')) {
      modelInfo.family = 'Luddo Expert';
      modelInfo.displayName = 'Luddo Expert AI';
    } else if (nameLower.includes('llama')) {
      modelInfo.family = 'Llama';
    } else if (nameLower.includes('qwen')) {
      modelInfo.family = 'Qwen';
    } else if (nameLower.includes('mistral')) {
      modelInfo.family = 'Mistral';
    }

    res.json(modelInfo);
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get current model',
      message: (error as Error).message
    });
  }
});

// List available models
router.get('/', async (req, res) => {
  try {
    const models = await ollamaService.listModels();
    const config = loadConfig();

    // Mark which models are fine-tuned (custom luddo models)
    const enrichedModels = models.map(m => ({
      name: m.name,
      size: m.size,
      modifiedAt: m.modified_at,
      isFineTuned: m.name.startsWith('luddo-'),
      baseModel: m.name.startsWith('luddo-') ? 'llama3.2:3b' : undefined
    }));

    res.json({
      available: enrichedModels,
      active: {
        humanGames: config.ollama.defaultModel,
        simulations: config.ollama.simulationModel
      }
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list models', message: (error as Error).message });
  }
});

// Switch active model
router.post('/switch', async (req, res) => {
  try {
    const { purpose, model } = req.body;

    if (!purpose || !model) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['purpose', 'model'],
        validPurposes: ['humanGames', 'simulations']
      });
    }

    if (purpose !== 'humanGames' && purpose !== 'simulations') {
      return res.status(400).json({
        error: 'Invalid purpose',
        validPurposes: ['humanGames', 'simulations']
      });
    }

    // Verify model exists
    const models = await ollamaService.listModels();
    const modelExists = models.some(m => m.name === model);

    if (!modelExists) {
      return res.status(404).json({
        error: 'Model not found',
        model,
        available: models.map(m => m.name)
      });
    }

    // Update config
    const config = loadConfig();
    if (purpose === 'humanGames') {
      config.ollama.defaultModel = model;
    } else {
      config.ollama.simulationModel = model;
    }
    saveConfig(config);

    res.json({
      status: 'switched',
      purpose,
      newModel: model
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to switch model', message: (error as Error).message });
  }
});

// Delete model
router.delete('/:modelName', async (req, res) => {
  try {
    const modelName = req.params.modelName;

    // Don't allow deleting base models
    if (!modelName.startsWith('luddo-')) {
      return res.status(400).json({
        error: 'Cannot delete base models',
        message: 'Only fine-tuned models (prefixed with "luddo-") can be deleted'
      });
    }

    await ollamaService.deleteModel(modelName);
    res.json({ deleted: true, model: modelName });
  } catch (error) {
    res.status(500).json({ error: 'Failed to delete model', message: (error as Error).message });
  }
});

export { router as modelsRoutes };
