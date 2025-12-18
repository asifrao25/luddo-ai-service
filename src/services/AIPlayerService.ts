/**
 * AI Player Service - LLM-powered move selection for Luddo
 */

import { OllamaService } from './OllamaService.js';
import { TipsService } from './TipsService.js';
import { getConfig } from '../config/index.js';
import { generateMovePrompt, parseAIResponse, MOVE_SELECTION_SYSTEM_PROMPT } from '../prompts/move-selection.js';
import { OnlineGameState, PlayerColor, Player, Token } from '../shared/types.js';
import { calculateValidMoves } from '../shared/game-logic.js';

export interface MoveDecision {
  tokenId: number;
  reasoning: string;
  confidence: number;
  model: string;
  processingTimeMs: number;
  tipsApplied: string[];
}

export interface AIPlayerConfig {
  model?: string;
  tipsProfile?: string;
  temperature?: number;
  maxRetries?: number;
}

const log = (message: string, data?: any) => {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] [AIPlayer] ${message}`, JSON.stringify(data));
  } else {
    console.log(`[${timestamp}] [AIPlayer] ${message}`);
  }
};

export class AIPlayerService {
  private ollamaService: OllamaService;
  private tipsService: TipsService;
  private defaultModel: string;
  private simulationModel: string;

  constructor(ollamaService: OllamaService, tipsService: TipsService) {
    this.ollamaService = ollamaService;
    this.tipsService = tipsService;

    const config = getConfig();
    this.defaultModel = config.ollama.defaultModel;
    this.simulationModel = config.ollama.simulationModel;
  }

  /**
   * Select the best move for the current game state
   */
  async selectMove(
    gameState: OnlineGameState,
    diceValue: number,
    config: AIPlayerConfig = {}
  ): Promise<MoveDecision> {
    const startTime = Date.now();
    const model = config.model || this.defaultModel;

    const currentPlayer = gameState.players[gameState.currentTurn];
    const validMoves = calculateValidMoves(currentPlayer, diceValue);

    // Edge cases - no LLM needed
    if (validMoves.length === 0) {
      return {
        tokenId: -1,
        reasoning: 'No valid moves available',
        confidence: 1.0,
        model: 'none',
        processingTimeMs: Date.now() - startTime,
        tipsApplied: []
      };
    }

    if (validMoves.length === 1) {
      return {
        tokenId: validMoves[0],
        reasoning: 'Only one valid move',
        confidence: 1.0,
        model: 'deterministic',
        processingTimeMs: Date.now() - startTime,
        tipsApplied: []
      };
    }

    // Get tips for context
    let tips: string[] = [];
    let tipsApplied: string[] = [];

    if (config.tipsProfile) {
      const profile = await this.tipsService.getProfile(config.tipsProfile);
      if (profile) {
        const activeTips = await this.tipsService.getTipsByIds(profile.tipIds);
        tips = activeTips.map(t => t.shortPrompt);
        tipsApplied = activeTips.map(t => t.id);
      }
    } else {
      // Use situational tips based on game phase
      tips = this.getDefaultTips(gameState);
    }

    // Generate prompt
    const userPrompt = generateMovePrompt(gameState, diceValue, validMoves, tips);

    // Call LLM
    const maxRetries = config.maxRetries || 3;
    let lastError: Error | null = null;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.ollamaService.generate({
          model,
          prompt: userPrompt,
          system: MOVE_SELECTION_SYSTEM_PROMPT,
          options: {
            temperature: config.temperature ?? 0.3,
            num_predict: 100
          }
        });

        const parsed = parseAIResponse(response.response, validMoves);

        log(`Move selected (attempt ${attempt})`, {
          color: gameState.currentTurn,
          dice: diceValue,
          validMoves,
          selected: parsed.tokenId,
          confidence: parsed.confidence
        });

        return {
          tokenId: parsed.tokenId,
          reasoning: parsed.reasoning,
          confidence: parsed.confidence,
          model,
          processingTimeMs: Date.now() - startTime,
          tipsApplied
        };

      } catch (error) {
        lastError = error as Error;
        log(`LLM call failed (attempt ${attempt}/${maxRetries}): ${lastError.message}`);

        if (attempt < maxRetries) {
          await this.delay(500 * attempt); // Exponential backoff
        }
      }
    }

    // Fallback: use heuristic selection
    log('Using heuristic fallback after LLM failures');
    const heuristicMove = this.selectHeuristicMove(currentPlayer, diceValue, validMoves, gameState);

    return {
      tokenId: heuristicMove.tokenId,
      reasoning: `Heuristic fallback: ${heuristicMove.reason}`,
      confidence: 0.5,
      model: 'heuristic',
      processingTimeMs: Date.now() - startTime,
      tipsApplied: []
    };
  }

  /**
   * Select move for simulation (uses faster/smaller model)
   */
  async selectSimulationMove(
    gameState: OnlineGameState,
    diceValue: number,
    tipsProfile?: string
  ): Promise<MoveDecision> {
    return this.selectMove(gameState, diceValue, {
      model: this.simulationModel,
      tipsProfile,
      temperature: 0.5, // Slightly more varied for learning diversity
      maxRetries: 2
    });
  }

  /**
   * Get default tips based on game phase
   */
  private getDefaultTips(gameState: OnlineGameState): string[] {
    const currentPlayer = gameState.players[gameState.currentTurn];
    const tokensHome = currentPlayer.tokens.filter(t => t.position === 99).length;
    const tokensInYard = currentPlayer.tokens.filter(t => t.position === -1).length;
    const tokensOnBoard = 4 - tokensHome - tokensInYard;

    // Opening phase
    if (tokensOnBoard < 2 && tokensInYard > 2) {
      return [
        'Get tokens out of yard quickly - more tokens = more options',
        'Use 6s to bring out new tokens first'
      ];
    }

    // Endgame
    if (tokensHome >= 2) {
      return [
        'Rush closest tokens home',
        'Prioritize finishing over capturing'
      ];
    }

    // Midgame
    return [
      'Capture when possible for bonus turn',
      'Move to safe spots when threatened',
      'Advance tokens in home stretch'
    ];
  }

  /**
   * Heuristic move selection when LLM fails
   */
  private selectHeuristicMove(
    player: Player,
    diceValue: number,
    validMoves: number[],
    gameState: OnlineGameState
  ): { tokenId: number; reason: string } {
    const SAFE_SPOTS = [0, 8, 13, 21, 26, 34, 39, 47];

    // Score each valid move
    const scores: { tokenId: number; score: number; reason: string }[] = [];

    for (const tokenId of validMoves) {
      const token = player.tokens.find(t => t.id === tokenId)!;
      let score = 0;
      let reason = '';

      // Coming out of yard
      if (token.position === -1 && diceValue === 6) {
        score = 80;
        reason = 'Exit yard';
      } else if (token.position >= 0 && token.position < 100) {
        const newStepCount = token.stepCount + diceValue;

        // Can reach home
        if (newStepCount === 56) {
          score = 100;
          reason = 'Reach home';
        }
        // Move into home stretch
        else if (newStepCount > 50 && token.stepCount <= 50) {
          score = 90;
          reason = 'Enter home stretch';
        }
        // Can capture (simplified check)
        else if (this.canCapture(token, diceValue, gameState)) {
          score = 85;
          reason = 'Capture opponent';
        }
        // Move to safe spot
        else if (this.landsOnSafe(player.id, token.stepCount + diceValue)) {
          score = 70;
          reason = 'Move to safe spot';
        }
        // Currently threatened - escape
        else if (this.isTokenThreatened(token, gameState)) {
          score = 75;
          reason = 'Escape threat';
        }
        // Advance closest to home
        else {
          score = 50 + token.stepCount;
          reason = 'Advance token';
        }
      }

      scores.push({ tokenId, score, reason });
    }

    // Sort by score descending
    scores.sort((a, b) => b.score - a.score);
    return { tokenId: scores[0].tokenId, reason: scores[0].reason };
  }

  /**
   * Check if token can capture an opponent
   */
  private canCapture(token: Token, diceValue: number, gameState: OnlineGameState): boolean {
    const SAFE_SPOTS = [0, 8, 13, 21, 26, 34, 39, 47];

    if (token.position < 0 || token.stepCount + diceValue > 50) return false;

    const currentPlayer = gameState.players[gameState.currentTurn];
    const config = { startPos: currentPlayer.startPos };
    const newPos = (config.startPos + token.stepCount + diceValue) % 52;

    if (SAFE_SPOTS.includes(newPos)) return false;

    for (const color of gameState.activeTurnOrder) {
      if (color === gameState.currentTurn) continue;
      for (const oppToken of gameState.players[color].tokens) {
        if (oppToken.position === newPos) return true;
      }
    }
    return false;
  }

  /**
   * Check if new position is a safe spot
   */
  private landsOnSafe(playerColor: PlayerColor, newStepCount: number): boolean {
    if (newStepCount > 50) return true; // Home stretch is safe

    const PLAYERS_CONFIG: Record<PlayerColor, { startPos: number }> = {
      red: { startPos: 0 },
      blue: { startPos: 13 },
      yellow: { startPos: 26 },
      green: { startPos: 39 }
    };

    const SAFE_SPOTS = [0, 8, 13, 21, 26, 34, 39, 47];
    const newPos = (PLAYERS_CONFIG[playerColor].startPos + newStepCount) % 52;
    return SAFE_SPOTS.includes(newPos);
  }

  /**
   * Check if token is threatened by any opponent
   */
  private isTokenThreatened(token: Token, gameState: OnlineGameState): boolean {
    const SAFE_SPOTS = [0, 8, 13, 21, 26, 34, 39, 47];

    if (token.position < 0 || token.position >= 100) return false;
    if (SAFE_SPOTS.includes(token.position)) return false;

    for (const color of gameState.activeTurnOrder) {
      if (color === gameState.currentTurn) continue;
      for (const oppToken of gameState.players[color].tokens) {
        if (oppToken.position < 0 || oppToken.position >= 100) continue;

        // Check if opponent is within 6 spaces behind
        const diff = (token.position - oppToken.position + 52) % 52;
        if (diff > 0 && diff <= 6) return true;
      }
    }
    return false;
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
