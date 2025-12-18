/**
 * WebSocket server for real-time updates
 *
 * Events:
 * Server -> Client:
 *   - simulation:progress   { batchId, gamesCompleted, totalGames, currentGame }
 *   - simulation:gameEnd    { batchId, gameId, winner, rankings }
 *   - simulation:batchEnd   { batchId, summary }
 *   - training:progress     { trainingId, epoch, loss, percentage }
 *   - training:complete     { trainingId, modelName }
 *   - error                 { code, message }
 *
 * Client -> Server:
 *   - subscribe             { channels: ["simulation", "training"] }
 *   - unsubscribe           { channels: ["simulation"] }
 */

import { WebSocketServer, WebSocket } from 'ws';
import { ServiceConfig } from '../config/index.js';
import { authenticateWebSocket } from './middleware/auth.js';
import { parse } from 'url';

interface WSClient {
  ws: WebSocket;
  channels: Set<string>;
  authenticated: boolean;
}

const clients = new Map<WebSocket, WSClient>();

export function setupWebSocket(wss: WebSocketServer, config: ServiceConfig): void {
  wss.on('connection', (ws: WebSocket, req) => {
    // Parse API key from query string
    const url = parse(req.url || '', true);
    const apiKey = url.query.apiKey as string;

    const authenticated = authenticateWebSocket(apiKey, config);

    if (!authenticated) {
      ws.send(JSON.stringify({
        type: 'error',
        data: { code: 'AUTH_FAILED', message: 'Invalid or missing API key' }
      }));
      ws.close(1008, 'Unauthorized');
      return;
    }

    // Register client
    const client: WSClient = {
      ws,
      channels: new Set(['simulation', 'training']), // Subscribe to all by default
      authenticated: true
    };
    clients.set(ws, client);

    console.log(`[WS] Client connected. Total clients: ${clients.size}`);

    // Send welcome message
    ws.send(JSON.stringify({
      type: 'connected',
      data: {
        message: 'Connected to Luddo AI Service',
        channels: Array.from(client.channels)
      }
    }));

    // Handle messages from client
    ws.on('message', (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        handleClientMessage(ws, message);
      } catch (error) {
        ws.send(JSON.stringify({
          type: 'error',
          data: { code: 'INVALID_MESSAGE', message: 'Invalid JSON' }
        }));
      }
    });

    // Handle disconnect
    ws.on('close', () => {
      clients.delete(ws);
      console.log(`[WS] Client disconnected. Total clients: ${clients.size}`);
    });

    ws.on('error', (error) => {
      console.error('[WS] Client error:', error);
      clients.delete(ws);
    });
  });
}

function handleClientMessage(ws: WebSocket, message: any): void {
  const client = clients.get(ws);
  if (!client) return;

  switch (message.type) {
    case 'subscribe':
      if (Array.isArray(message.channels)) {
        message.channels.forEach((ch: string) => client.channels.add(ch));
        ws.send(JSON.stringify({
          type: 'subscribed',
          data: { channels: Array.from(client.channels) }
        }));
      }
      break;

    case 'unsubscribe':
      if (Array.isArray(message.channels)) {
        message.channels.forEach((ch: string) => client.channels.delete(ch));
        ws.send(JSON.stringify({
          type: 'unsubscribed',
          data: { channels: Array.from(client.channels) }
        }));
      }
      break;

    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', data: { timestamp: Date.now() } }));
      break;

    default:
      ws.send(JSON.stringify({
        type: 'error',
        data: { code: 'UNKNOWN_MESSAGE', message: `Unknown message type: ${message.type}` }
      }));
  }
}

/**
 * Broadcast message to all clients subscribed to a channel
 */
export function broadcast(channel: string, eventType: string, data: any): void {
  const message = JSON.stringify({
    type: `${channel}:${eventType}`,
    data,
    timestamp: new Date().toISOString()
  });

  clients.forEach((client) => {
    if (client.channels.has(channel) && client.ws.readyState === WebSocket.OPEN) {
      client.ws.send(message);
    }
  });
}

/**
 * Broadcast simulation progress
 */
export function broadcastSimulationProgress(data: {
  batchId: string;
  gamesCompleted: number;
  totalGames: number;
  currentGame?: any;
}): void {
  broadcast('simulation', 'progress', data);
}

/**
 * Broadcast simulation game end
 */
export function broadcastSimulationGameEnd(data: {
  batchId: string;
  gameId: string;
  winner: string;
  rankings: string[];
}): void {
  broadcast('simulation', 'gameEnd', data);
}

/**
 * Broadcast simulation batch complete
 */
export function broadcastSimulationBatchEnd(data: {
  batchId: string;
  summary: any;
}): void {
  broadcast('simulation', 'batchEnd', data);
}

/**
 * Broadcast training progress
 */
export function broadcastTrainingProgress(data: {
  trainingId: string;
  epoch: number;
  totalEpochs: number;
  loss?: number;
  percentage: number;
}): void {
  broadcast('training', 'progress', data);
}

/**
 * Broadcast training complete
 */
export function broadcastTrainingComplete(data: {
  trainingId: string;
  modelName: string;
}): void {
  broadcast('training', 'complete', data);
}

/**
 * Get connected client count
 */
export function getClientCount(): number {
  return clients.size;
}
