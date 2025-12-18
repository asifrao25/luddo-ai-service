/**
 * AI Routes - Move selection endpoint for frontend integration
 */

import { Router, Request, Response } from 'express';
import { AIPlayerService } from '../../services/AIPlayerService.js';
import { OllamaService } from '../../services/OllamaService.js';
import { TipsService } from '../../services/TipsService.js';
import { OnlineGameState } from '../../shared/types.js';

const router = Router();

// Service instances
let aiPlayerService: AIPlayerService | null = null;

function getAIPlayerService(): AIPlayerService {
  if (!aiPlayerService) {
    const ollamaService = new OllamaService();
    const tipsService = new TipsService();
    aiPlayerService = new AIPlayerService(ollamaService, tipsService);
  }
  return aiPlayerService;
}

/**
 * POST /api/ai/move
 *
 * Request AI move selection for a game state
 *
 * Body:
 * - gameState: OnlineGameState
 * - diceValue: number
 * - validMoves: number[]
 * - aiType?: 'ultra' | 'openai' | 'gemini' | 'ollama'
 * - tipsProfile?: string
 */
router.post('/move', async (req: Request, res: Response) => {
  try {
    const { gameState, diceValue, validMoves, aiType, tipsProfile } = req.body;

    // Validate required fields
    if (!gameState || typeof diceValue !== 'number' || !Array.isArray(validMoves)) {
      return res.status(400).json({
        error: 'Missing required fields: gameState, diceValue, validMoves'
      });
    }

    if (validMoves.length === 0) {
      return res.json({
        tokenId: -1,
        reasoning: 'No valid moves',
        confidence: 1.0,
        model: 'none'
      });
    }

    if (validMoves.length === 1) {
      return res.json({
        tokenId: validMoves[0],
        reasoning: 'Only one valid move available',
        confidence: 1.0,
        model: 'deterministic'
      });
    }

    const service = getAIPlayerService();

    // Select model based on aiType
    let model: string | undefined;
    if (aiType === 'ultra') {
      model = 'qwen2.5:7b-instruct-q4_K_M';
    } else if (aiType === 'ollama') {
      model = 'llama3.2:3b';
    }
    // For other types, use default

    const decision = await service.selectMove(
      gameState as OnlineGameState,
      diceValue,
      {
        model,
        tipsProfile,
        temperature: 0.3,
        maxRetries: 2
      }
    );

    res.json({
      tokenId: decision.tokenId,
      reasoning: decision.reasoning,
      confidence: decision.confidence,
      model: decision.model,
      processingTimeMs: decision.processingTimeMs
    });

  } catch (error) {
    console.error('[AI] Move selection error:', error);
    res.status(500).json({
      error: 'AI move selection failed',
      message: (error as Error).message
    });
  }
});

/**
 * GET /api/ai/status
 *
 * Get AI service status
 */
router.get('/status', async (req: Request, res: Response) => {
  try {
    const ollamaService = new OllamaService();
    const connected = await ollamaService.checkConnection();
    const models = connected ? await ollamaService.listModels() : [];

    res.json({
      status: connected ? 'ready' : 'disconnected',
      ollama: {
        connected,
        models: models.map(m => m.name)
      }
    });
  } catch (error) {
    res.status(500).json({
      status: 'error',
      error: (error as Error).message
    });
  }
});

export default router;
