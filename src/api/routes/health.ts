/**
 * Health check endpoint
 */

import { Router } from 'express';
import { OllamaService } from '../../services/OllamaService.js';

const router = Router();
const startTime = Date.now();

router.get('/', async (req, res) => {
  const ollamaService = new OllamaService();
  let ollamaStatus = 'unknown';

  try {
    const isConnected = await ollamaService.checkConnection();
    ollamaStatus = isConnected ? 'connected' : 'disconnected';
  } catch {
    ollamaStatus = 'error';
  }

  res.json({
    status: 'ok',
    service: 'luddo-ai-service',
    version: '1.0.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    ollama: ollamaStatus,
    timestamp: new Date().toISOString()
  });
});

router.get('/detailed', async (req, res) => {
  const ollamaService = new OllamaService();
  let ollamaInfo: any = { status: 'unknown' };

  try {
    const models = await ollamaService.listModels();
    ollamaInfo = {
      status: 'connected',
      models: models.map(m => ({ name: m.name, size: m.size }))
    };
  } catch (error) {
    ollamaInfo = {
      status: 'error',
      error: error instanceof Error ? error.message : 'Unknown error'
    };
  }

  res.json({
    status: 'ok',
    service: 'luddo-ai-service',
    version: '1.0.0',
    uptime: Math.floor((Date.now() - startTime) / 1000),
    memory: process.memoryUsage(),
    ollama: ollamaInfo,
    timestamp: new Date().toISOString()
  });
});

export { router as healthRoutes };
