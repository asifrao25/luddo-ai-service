/**
 * Metrics & Analytics API Routes
 *
 * Endpoints:
 * GET /api/metrics/overview          - Summary metrics
 * GET /api/metrics/games             - List games
 * GET /api/metrics/games/:id         - Single game details
 * GET /api/metrics/win-rates         - Win rate analysis
 * GET /api/metrics/tips-effectiveness - Tips effectiveness
 * GET /api/metrics/learning-progress - Learning progress over time
 */

import { Router } from 'express';
import { MetricsService } from '../../services/MetricsService.js';

const router = Router();
const metricsService = new MetricsService();

// Overview metrics
router.get('/overview', async (req, res) => {
  try {
    const overview = await metricsService.getOverview();
    res.json(overview);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get overview', message: (error as Error).message });
  }
});

// List games
router.get('/games', async (req, res) => {
  try {
    const {
      type,
      limit = '50',
      offset = '0',
      dateFrom,
      dateTo
    } = req.query;

    const games = await metricsService.getGames({
      type: type as 'simulation' | 'human_vs_ai',
      limit: parseInt(limit as string),
      offset: parseInt(offset as string),
      dateFrom: dateFrom as string,
      dateTo: dateTo as string
    });

    res.json(games);
  } catch (error) {
    res.status(500).json({ error: 'Failed to get games', message: (error as Error).message });
  }
});

// Single game details
router.get('/games/:gameId', async (req, res) => {
  try {
    const game = await metricsService.getGameById(req.params.gameId);
    if (!game) {
      return res.status(404).json({ error: 'Game not found' });
    }
    res.json({ game });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get game', message: (error as Error).message });
  }
});

// Win rate analysis
router.get('/win-rates', async (req, res) => {
  try {
    const { groupBy = 'model', dateRange = 'all' } = req.query;

    const winRates = await metricsService.getWinRates({
      groupBy: groupBy as 'model' | 'tipsProfile' | 'date',
      dateRange: dateRange as string
    });

    res.json({ winRates });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get win rates', message: (error as Error).message });
  }
});

// Tips effectiveness
router.get('/tips-effectiveness', async (req, res) => {
  try {
    const effectiveness = await metricsService.getTipsEffectiveness();
    res.json({ tipEffectiveness: effectiveness });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get tips effectiveness', message: (error as Error).message });
  }
});

// Learning progress over time
router.get('/learning-progress', async (req, res) => {
  try {
    const { days = '30' } = req.query;
    const progress = await metricsService.getLearningProgress(parseInt(days as string));
    res.json({ progress });
  } catch (error) {
    res.status(500).json({ error: 'Failed to get learning progress', message: (error as Error).message });
  }
});

export { router as metricsRoutes };
