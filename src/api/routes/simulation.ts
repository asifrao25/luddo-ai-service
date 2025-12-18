/**
 * Simulation Control API Routes
 *
 * Endpoints:
 * POST /api/simulation/start   - Start simulation batch
 * POST /api/simulation/stop    - Stop simulation batch
 * POST /api/simulation/pause   - Pause simulation
 * POST /api/simulation/resume  - Resume simulation
 * GET  /api/simulation/status  - Get current status
 * GET  /api/simulation/history - Get simulation history
 */

import { Router } from 'express';
import { SimulationService } from '../../services/SimulationService.js';

const router = Router();
const simulationService = new SimulationService();

// Start simulation batch
router.post('/start', async (req, res) => {
  try {
    const {
      batchSize = 10,
      aiModels,
      tipsProfile,
      speed = 'normal'
    } = req.body;

    const result = await simulationService.startBatch({
      batchSize,
      aiModels,
      tipsProfile,
      speed
    });

    res.json({
      batchId: result.batchId,
      status: 'started',
      estimatedDuration: result.estimatedDuration
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to start simulation', message: (error as Error).message });
  }
});

// Stop simulation batch
router.post('/stop', async (req, res) => {
  try {
    const { batchId } = req.body;

    if (!batchId) {
      return res.status(400).json({ error: 'Missing batchId' });
    }

    const result = await simulationService.stopBatch(batchId);
    res.json({
      status: 'stopped',
      gamesCompleted: result.gamesCompleted
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to stop simulation', message: (error as Error).message });
  }
});

// Pause simulation
router.post('/pause', async (req, res) => {
  try {
    const { batchId } = req.body;

    if (!batchId) {
      return res.status(400).json({ error: 'Missing batchId' });
    }

    const result = await simulationService.pauseBatch(batchId);
    res.json({
      status: 'paused',
      gamesCompleted: result.gamesCompleted
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to pause simulation', message: (error as Error).message });
  }
});

// Resume simulation
router.post('/resume', async (req, res) => {
  try {
    const { batchId } = req.body;

    if (!batchId) {
      return res.status(400).json({ error: 'Missing batchId' });
    }

    const result = await simulationService.resumeBatch(batchId);
    res.json({
      status: 'running',
      gamesRemaining: result.gamesRemaining
    });
  } catch (error) {
    res.status(500).json({ error: 'Failed to resume simulation', message: (error as Error).message });
  }
});

// Get current status
router.get('/status', async (req, res) => {
  try {
    const status = await simulationService.getStatus();
    res.json(status);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get status', message: (error as Error).message });
  }
});

// Get simulation history
router.get('/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 20;
    const offset = parseInt(req.query.offset as string) || 0;

    const history = await simulationService.getHistory(limit, offset);
    res.json(history);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get history', message: (error as Error).message });
  }
});

export { router as simulationRoutes };
