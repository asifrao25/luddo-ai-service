/**
 * Training Pipeline API Routes
 *
 * Endpoints:
 * POST /api/training/generate-dataset - Generate training dataset
 * GET  /api/training/datasets          - List datasets
 * POST /api/training/start             - Start fine-tuning
 * GET  /api/training/status/:id        - Training status
 * GET  /api/training/history           - Training history
 */

import { Router } from 'express';
import { TrainingService } from '../../services/TrainingService.js';

const router = Router();
const trainingService = new TrainingService();

// Generate training dataset
router.post('/generate-dataset', async (req, res) => {
  try {
    const {
      source = 'simulations',
      dateRange,
      filterBy,
      maxExamples,
      outputName
    } = req.body;

    // Auto-generate outputName if not provided (iOS doesn't send it)
    const datasetName = outputName || `dataset-${Date.now()}`;

    const result = await trainingService.generateDataset({
      source,
      dateRange,
      filterBy,
      outputName: datasetName
    });

    // Return format expected by iOS app (snake_case for CodingKeys)
    res.json({
      dataset_id: datasetName,
      path: `training/datasets/${datasetName}.jsonl`,
      examples: result.estimatedSize,
      size_bytes: result.estimatedSize * 350 // Rough estimate
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to generate dataset', message: (error as Error).message });
  }
});

// List datasets
router.get('/datasets', async (req, res) => {
  try {
    const datasets = await trainingService.listDatasets();
    res.json({ datasets });
  } catch (error) {
    res.status(500).json({ error: 'Failed to list datasets', message: (error as Error).message });
  }
});

// Start fine-tuning
router.post('/start', async (req, res) => {
  try {
    const {
      baseModel,
      datasetId,
      outputModelName,
      epochs = 3
    } = req.body;

    if (!baseModel || !datasetId || !outputModelName) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['baseModel', 'datasetId', 'outputModelName']
      });
    }

    const result = await trainingService.startTraining({
      baseModel,
      datasetId,
      outputModelName,
      epochs
    });

    res.json({
      trainingId: result.trainingId,
      status: 'started',
      message: `Training started, estimated duration: ${result.estimatedDuration}`
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start training', message: (error as Error).message });
  }
});

// Training status
router.get('/status/:trainingId', async (req, res) => {
  try {
    const status = await trainingService.getTrainingStatus(req.params.trainingId);
    if (!status) {
      return res.status(404).json({ error: 'Training run not found' });
    }
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status', message: (error as Error).message });
  }
});

// Training history
router.get('/history', async (req, res) => {
  try {
    const history = await trainingService.getHistory();
    res.json({ runs: history });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get history', message: (error as Error).message });
  }
});

// Cancel current training
router.post('/cancel', async (req, res) => {
  try {
    const cancelled = await trainingService.cancelTraining();
    if (cancelled) {
      res.json({ success: true, message: 'Training cancelled' });
    } else {
      res.status(400).json({ success: false, message: 'No training in progress' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to cancel training', message: (error as Error).message });
  }
});

// Get current live progress
router.get('/progress', async (req, res) => {
  try {
    const progress = await trainingService.getCurrentProgress();
    if (progress) {
      res.json(progress);
    } else {
      res.status(404).json({ message: 'No training in progress' });
    }
  } catch (error) {
    res.status(500).json({ error: 'Failed to get progress', message: (error as Error).message });
  }
});

export { router as trainingRoutes };
