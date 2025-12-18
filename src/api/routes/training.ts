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
      outputName
    } = req.body;

    if (!outputName) {
      return res.status(400).json({
        error: 'Missing required field',
        required: ['outputName']
      });
    }

    const result = await trainingService.generateDataset({
      source,
      dateRange,
      filterBy,
      outputName
    });

    res.json({
      datasetId: result.datasetId,
      status: 'generating',
      estimatedSize: result.estimatedSize
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
      estimatedDuration: result.estimatedDuration
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

export { router as trainingRoutes };
