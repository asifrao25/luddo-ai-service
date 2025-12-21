/**
 * API Key Authentication Middleware
 */

import { Request, Response, NextFunction } from 'express';
import { ServiceConfig } from '../../config/index.js';

export function authMiddleware(config: ServiceConfig) {
  return (req: Request, res: Response, next: NextFunction) => {
    // Skip auth if not required
    if (!config.server.apiKeyRequired) {
      return next();
    }

    const apiKey = req.headers['x-api-key'] as string;

    if (!apiKey) {
      return res.status(401).json({
        error: 'Unauthorized',
        message: 'Missing X-API-Key header'
      });
    }

    if (apiKey !== config.auth.apiKey) {
      return res.status(403).json({
        error: 'Forbidden',
        message: 'Invalid API key'
      });
    }

    next();
  };
}

/**
 * WebSocket authentication helper
 */
export function authenticateWebSocket(
  apiKey: string | undefined,
  config: ServiceConfig
): boolean {
  if (!config.server.apiKeyRequired) {
    return true;
  }
  return apiKey === config.auth.apiKey;
}
