/**
 * Luddo AI Service - Main Entry Point
 *
 * Port: 3004 (avoiding hormonology backend ports 3001-3003)
 *
 * Provides REST APIs for:
 * - AI game simulation management
 * - Strategy tips CRUD
 * - Training/fine-tuning pipeline
 * - Metrics and analytics
 * - Model management
 */

import express from 'express';
import cors from 'cors';
import { WebSocketServer, WebSocket } from 'ws';
import { createServer } from 'http';
import { authMiddleware } from './api/middleware/auth.js';
import { healthRoutes } from './api/routes/health.js';
import { tipsRoutes } from './api/routes/tips.js';
import { simulationRoutes } from './api/routes/simulation.js';
import { metricsRoutes } from './api/routes/metrics.js';
import { trainingRoutes } from './api/routes/training.js';
import { modelsRoutes } from './api/routes/models.js';
import aiRoutes from './api/routes/ai.js';
import { systemRoutes } from './api/routes/system.js';
import { setupWebSocket } from './api/websocket.js';
import { loadConfig } from './config/index.js';

const config = loadConfig();
const app = express();
const server = createServer(app);

// WebSocket server
const wss = new WebSocketServer({ server, path: '/ws' });
setupWebSocket(wss, config);

// Middleware
app.use(cors({
  origin: '*', // iOS app and local testing
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'Authorization']
}));
app.use(express.json({ limit: '10mb' }));

// Request logging
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    const duration = Date.now() - start;
    console.log(`[${new Date().toISOString()}] ${req.method} ${req.path} ${res.statusCode} ${duration}ms`);
  });
  next();
});

// Public routes (no auth required)
app.use('/api/health', healthRoutes);

// Protected routes (API key required)
app.use('/api/tips', authMiddleware(config), tipsRoutes);
app.use('/api/simulation', authMiddleware(config), simulationRoutes);
app.use('/api/metrics', authMiddleware(config), metricsRoutes);
app.use('/api/training', authMiddleware(config), trainingRoutes);
app.use('/api/models', authMiddleware(config), modelsRoutes);
app.use('/api/ai', authMiddleware(config), aiRoutes);
app.use('/api/system', authMiddleware(config), systemRoutes);

// Root endpoint
app.get('/', (req, res) => {
  res.json({
    service: 'Luddo AI Service',
    version: '1.0.0',
    port: config.server.port,
    endpoints: {
      health: '/api/health',
      tips: '/api/tips',
      simulation: '/api/simulation',
      metrics: '/api/metrics',
      training: '/api/training',
      models: '/api/models',
      ai: '/api/ai',
      system: '/api/system',
      websocket: '/ws'
    }
  });
});

// Error handler
app.use((err: Error, req: express.Request, res: express.Response, next: express.NextFunction) => {
  console.error(`[ERROR] ${err.message}`);
  console.error(err.stack);
  res.status(500).json({ error: 'Internal server error', message: err.message });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: 'Not found', path: req.path });
});

// Start server
server.listen(config.server.port, config.server.host, () => {
  console.log(`
╔══════════════════════════════════════════════════════════════╗
║                    LUDDO AI SERVICE                          ║
╠══════════════════════════════════════════════════════════════╣
║  Port: ${config.server.port}                                            ║
║  Host: ${config.server.host}                                       ║
║  Ollama: ${config.ollama.baseUrl}                       ║
║  Data: ${config.storage.dataPath}                              ║
╚══════════════════════════════════════════════════════════════╝
  `);
  console.log(`[${new Date().toISOString()}] Server started on http://${config.server.host}:${config.server.port}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down...');
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});

export { app, server, wss };
