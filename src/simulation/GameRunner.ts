/**
 * GameRunner - Executes complete Luddo games with AI players
 */

import { AIPlayerService, MoveDecision } from '../services/AIPlayerService.js';
import { MetricsService } from '../services/MetricsService.js';
import {
  OnlineGameState,
  PlayerColor,
  MoveResult
} from '../shared/types.js';
import {
  initializeGameState,
  rollDice,
  executeTokenMove,
  getNextPlayer
} from '../shared/game-logic.js';
import { v4 as uuidv4 } from 'uuid';

export interface GameConfig {
  players: PlayerColor[];
  playerNames: Record<PlayerColor, string>;
  aiModels: Record<PlayerColor, string>;
  tipsProfile?: string;
  maxTurns?: number;
  delayBetweenMoves?: number;
}

export interface TurnRecord {
  turn: number;
  player: PlayerColor;
  diceValue: number;
  validMoves: number[];
  selectedToken: number;
  reasoning: string;
  model: string;
  confidence: number;
  tipsApplied: string[];
  outcome: {
    captured?: { color: PlayerColor; tokenId: number };
    reachedHome?: boolean;
    extraTurn?: boolean;
  };
}

export interface GameResult {
  gameId: string;
  startedAt: Date;
  endedAt: Date;
  winner: PlayerColor | null;
  rankings: PlayerColor[];
  totalTurns: number;
  turns: TurnRecord[];
  playerStats: Record<PlayerColor, {
    model: string;
    captures: number;
    sixes: number;
    tokensHome: number;
    avgConfidence: number;
    totalMoves: number;
  }>;
  aborted: boolean;
  abortReason?: string;
}

type GameEventCallback = (event: string, data: any) => void;

const log = (message: string, data?: any) => {
  const timestamp = new Date().toISOString();
  if (data) {
    console.log(`[${timestamp}] [GameRunner] ${message}`, JSON.stringify(data));
  } else {
    console.log(`[${timestamp}] [GameRunner] ${message}`);
  }
};

export class GameRunner {
  private aiPlayer: AIPlayerService;
  private metricsService: MetricsService | null;
  private config: GameConfig;
  private gameState: OnlineGameState | null = null;
  private turns: TurnRecord[] = [];
  private playerStats: Record<PlayerColor, {
    model: string;
    captures: number;
    sixes: number;
    tokensHome: number;
    confidenceSum: number;
    totalMoves: number;
  }>;
  private turnCount: number = 0;
  private running: boolean = false;
  private aborted: boolean = false;
  private abortReason?: string;
  private gameId: string;
  private startedAt: Date;
  private eventCallback?: GameEventCallback;

  constructor(
    aiPlayer: AIPlayerService,
    config: GameConfig,
    metricsService?: MetricsService
  ) {
    this.aiPlayer = aiPlayer;
    this.metricsService = metricsService || null;
    this.config = {
      maxTurns: 500,
      delayBetweenMoves: 100,
      ...config
    };

    this.gameId = uuidv4();
    this.startedAt = new Date();
    this.playerStats = {} as any;

    // Initialize player stats
    for (const color of config.players) {
      this.playerStats[color] = {
        model: config.aiModels[color] || 'unknown',
        captures: 0,
        sixes: 0,
        tokensHome: 0,
        confidenceSum: 0,
        totalMoves: 0
      };
    }
  }

  /**
   * Set callback for game events
   */
  onEvent(callback: GameEventCallback): void {
    this.eventCallback = callback;
  }

  /**
   * Run the complete game
   */
  async run(): Promise<GameResult> {
    this.running = true;
    log(`Starting game ${this.gameId}`, { players: this.config.players });

    // Initialize game state
    this.gameState = initializeGameState(
      this.config.players,
      this.config.playerNames,
      this.config.players // All players are AI
    );

    this.emit('game:start', { gameId: this.gameId, players: this.config.players });

    // Main game loop
    while (this.running && !this.aborted && this.gameState.gameState === 'playing') {
      // Check turn limit
      if (this.turnCount >= (this.config.maxTurns || 500)) {
        this.aborted = true;
        this.abortReason = 'Max turns exceeded';
        break;
      }

      await this.executeTurn();

      // Small delay between turns
      if (this.config.delayBetweenMoves && this.config.delayBetweenMoves > 0) {
        await this.delay(this.config.delayBetweenMoves);
      }
    }

    this.running = false;
    const result = this.buildResult();

    // Record to metrics
    if (this.metricsService) {
      try {
        await this.recordMetrics(result);
      } catch (err) {
        log(`Failed to record metrics: ${(err as Error).message}`);
      }
    }

    this.emit('game:end', {
      gameId: this.gameId,
      winner: result.winner,
      rankings: result.rankings,
      totalTurns: result.totalTurns
    });

    log(`Game ${this.gameId} finished`, {
      winner: result.winner,
      turns: result.totalTurns,
      aborted: result.aborted
    });

    return result;
  }

  /**
   * Execute a single turn
   */
  private async executeTurn(): Promise<void> {
    if (!this.gameState) return;

    const currentColor = this.gameState.currentTurn;
    const currentPlayer = this.gameState.players[currentColor];

    // Roll dice
    const diceResult = rollDice(this.gameState);
    const diceValue = diceResult.value;
    const validMoves = diceResult.validMoves;

    // Update game state with dice roll
    this.gameState.diceValue = diceValue;
    this.gameState.hasRolled = true;
    this.gameState.validMoves = validMoves;

    // Track sixes
    if (diceValue === 6) {
      this.playerStats[currentColor].sixes++;
    }

    this.emit('turn:roll', {
      turn: this.turnCount,
      player: currentColor,
      dice: diceValue,
      validMoves
    });

    // No valid moves - skip turn
    if (validMoves.length === 0 || diceResult.autoSkip) {
      this.turns.push({
        turn: this.turnCount,
        player: currentColor,
        diceValue,
        validMoves: [],
        selectedToken: -1,
        reasoning: 'No valid moves',
        model: 'skip',
        confidence: 1.0,
        tipsApplied: [],
        outcome: {}
      });

      // Advance to next player
      this.gameState.currentTurn = getNextPlayer(
        currentColor,
        this.gameState.activeTurnOrder,
        this.gameState.rankings
      );
      this.gameState.hasRolled = false;
      this.turnCount++;
      return;
    }

    // AI selects move
    let decision: MoveDecision;
    try {
      decision = await this.aiPlayer.selectSimulationMove(
        this.gameState,
        diceValue,
        this.config.tipsProfile
      );
    } catch (error) {
      log(`AI decision failed: ${(error as Error).message}`);
      // Fallback to first valid move
      decision = {
        tokenId: validMoves[0],
        reasoning: 'Fallback after error',
        confidence: 0.1,
        model: 'error-fallback',
        processingTimeMs: 0,
        tipsApplied: []
      };
    }

    // Execute the move
    const moveResult = executeTokenMove(this.gameState, decision.tokenId, diceValue);

    if (!moveResult.success) {
      log(`Move execution failed: ${moveResult.error}`);
      // Try first valid move as fallback
      const fallbackResult = executeTokenMove(this.gameState, validMoves[0], diceValue);
      if (fallbackResult.success && fallbackResult.newGameState) {
        this.gameState = fallbackResult.newGameState;
        decision.tokenId = validMoves[0];
        decision.reasoning = `Fallback: ${moveResult.error}`;
      }
    } else if (moveResult.newGameState) {
      this.gameState = moveResult.newGameState;
    }

    // Update stats
    this.playerStats[currentColor].totalMoves++;
    this.playerStats[currentColor].confidenceSum += decision.confidence;

    if (moveResult.capturedToken) {
      this.playerStats[currentColor].captures++;
    }

    // Count tokens home
    this.playerStats[currentColor].tokensHome = this.gameState.players[currentColor].tokens
      .filter(t => t.position === 99).length;

    // Determine if extra turn
    const extraTurn = diceValue === 6 || !!moveResult.capturedToken || !!moveResult.reachedHome;

    // Record turn
    this.turns.push({
      turn: this.turnCount,
      player: currentColor,
      diceValue,
      validMoves,
      selectedToken: decision.tokenId,
      reasoning: decision.reasoning,
      model: decision.model,
      confidence: decision.confidence,
      tipsApplied: decision.tipsApplied,
      outcome: {
        captured: moveResult.capturedToken,
        reachedHome: moveResult.reachedHome,
        extraTurn: extraTurn && this.gameState.currentTurn === currentColor
      }
    });

    this.emit('turn:move', {
      turn: this.turnCount,
      player: currentColor,
      token: decision.tokenId,
      dice: diceValue,
      captured: moveResult.capturedToken,
      reachedHome: moveResult.reachedHome
    });

    this.turnCount++;
  }

  /**
   * Stop the game
   */
  abort(reason: string = 'User requested'): void {
    this.aborted = true;
    this.abortReason = reason;
    this.running = false;
    log(`Game ${this.gameId} aborted: ${reason}`);
  }

  /**
   * Check if game is running
   */
  isRunning(): boolean {
    return this.running;
  }

  /**
   * Get current game ID
   */
  getGameId(): string {
    return this.gameId;
  }

  /**
   * Build final result
   */
  private buildResult(): GameResult {
    const finalStats: Record<PlayerColor, {
      model: string;
      captures: number;
      sixes: number;
      tokensHome: number;
      avgConfidence: number;
      totalMoves: number;
    }> = {} as any;

    for (const color of this.config.players) {
      const stats = this.playerStats[color];
      finalStats[color] = {
        model: stats.model,
        captures: stats.captures,
        sixes: stats.sixes,
        tokensHome: stats.tokensHome,
        avgConfidence: stats.totalMoves > 0
          ? stats.confidenceSum / stats.totalMoves
          : 0,
        totalMoves: stats.totalMoves
      };
    }

    return {
      gameId: this.gameId,
      startedAt: this.startedAt,
      endedAt: new Date(),
      winner: this.gameState?.winner || null,
      rankings: this.gameState?.rankings || [],
      totalTurns: this.turnCount,
      turns: this.turns,
      playerStats: finalStats,
      aborted: this.aborted,
      abortReason: this.abortReason
    };
  }

  /**
   * Record game to metrics database
   */
  private async recordMetrics(result: GameResult): Promise<void> {
    if (!this.metricsService) return;

    // Record the game
    await this.metricsService.recordGame({
      id: result.gameId,
      type: 'simulation',
      startedAt: result.startedAt.toISOString(),
      endedAt: result.endedAt.toISOString(),
      winner: result.winner || 'none',
      totalTurns: result.totalTurns,
      tipsProfile: this.config.tipsProfile
    });

    // Record player results
    let rank = 1;
    for (const color of result.rankings) {
      const stats = result.playerStats[color];
      await this.metricsService.recordPlayer({
        gameId: result.gameId,
        color,
        name: this.config.playerNames[color],
        isAI: true,
        aiModel: stats.model,
        finalRank: rank++,
        captures: stats.captures,
        tokensHome: stats.tokensHome,
        sixesRolled: stats.sixes
      });
    }

    // Record AI decisions (sample every 10th to avoid bloat)
    for (let i = 0; i < result.turns.length; i += 10) {
      const turn = result.turns[i];
      if (turn.selectedToken >= 0) {
        await this.metricsService.recordAIDecision({
          gameId: result.gameId,
          turnNumber: turn.turn,
          playerColor: turn.player,
          diceValue: turn.diceValue,
          validMoves: turn.validMoves,
          selectedToken: turn.selectedToken,
          reasoning: turn.reasoning.substring(0, 200),
          confidence: turn.confidence,
          responseTimeMs: 0, // Not tracked per-decision currently
          tipsApplied: turn.tipsApplied,
          wasCapture: !!turn.outcome.captured,
          reachedHome: !!turn.outcome.reachedHome
        });
      }
    }
  }

  private emit(event: string, data: any): void {
    if (this.eventCallback) {
      this.eventCallback(event, data);
    }
  }

  private delay(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
