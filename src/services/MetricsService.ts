/**
 * Metrics Service
 *
 * Analytics and metrics tracking for games, AI decisions, and learning progress
 */

import { getStorageService } from './StorageService.js';

export interface GameFilter {
  type?: 'simulation' | 'human_vs_ai';
  limit: number;
  offset: number;
  dateFrom?: string;
  dateTo?: string;
}

export interface WinRateFilter {
  groupBy: 'model' | 'tipsProfile' | 'date';
  dateRange: string;
}

export class MetricsService {
  private storage = getStorageService();

  /**
   * Get overview metrics
   */
  async getOverview(): Promise<{
    totalGames: number;
    simulationGames: number;
    humanGames: number;
    totalAIDecisions: number;
    avgResponseTimeMs: number;
    lastUpdated: string;
  }> {
    const db = this.storage.getDatabase();

    const games = db.prepare(`
      SELECT
        COUNT(*) as total,
        SUM(CASE WHEN type = 'simulation' THEN 1 ELSE 0 END) as simulations,
        SUM(CASE WHEN type = 'human_vs_ai' THEN 1 ELSE 0 END) as human
      FROM games
    `).get() as { total: number; simulations: number; human: number };

    const decisions = db.prepare(`
      SELECT COUNT(*) as total, AVG(response_time_ms) as avg_time
      FROM ai_decisions
    `).get() as { total: number; avg_time: number };

    return {
      totalGames: games.total || 0,
      simulationGames: games.simulations || 0,
      humanGames: games.human || 0,
      totalAIDecisions: decisions.total || 0,
      avgResponseTimeMs: Math.round(decisions.avg_time || 0),
      lastUpdated: new Date().toISOString()
    };
  }

  /**
   * Get games list
   */
  async getGames(filter: GameFilter): Promise<{
    games: any[];
    total: number;
  }> {
    const db = this.storage.getDatabase();

    let whereClause = '1=1';
    const params: any[] = [];

    if (filter.type) {
      whereClause += ' AND type = ?';
      params.push(filter.type);
    }
    if (filter.dateFrom) {
      whereClause += ' AND started_at >= ?';
      params.push(filter.dateFrom);
    }
    if (filter.dateTo) {
      whereClause += ' AND started_at <= ?';
      params.push(filter.dateTo);
    }

    const total = db.prepare(`
      SELECT COUNT(*) as count FROM games WHERE ${whereClause}
    `).get(...params) as { count: number };

    const games = db.prepare(`
      SELECT id, type, started_at, ended_at, duration_ms, winner, total_turns, tips_profile
      FROM games
      WHERE ${whereClause}
      ORDER BY started_at DESC
      LIMIT ? OFFSET ?
    `).all(...params, filter.limit, filter.offset);

    return {
      games,
      total: total.count
    };
  }

  /**
   * Get single game with full details
   */
  async getGameById(gameId: string): Promise<any | null> {
    const db = this.storage.getDatabase();

    const game = db.prepare(`
      SELECT * FROM games WHERE id = ?
    `).get(gameId) as any;

    if (!game) return null;

    const players = db.prepare(`
      SELECT * FROM game_players WHERE game_id = ?
    `).all(gameId);

    const decisions = db.prepare(`
      SELECT * FROM ai_decisions WHERE game_id = ? ORDER BY turn_number
    `).all(gameId);

    return {
      ...game,
      config: JSON.parse(game.config_json || '{}'),
      players,
      decisions
    };
  }

  /**
   * Get win rates
   */
  async getWinRates(filter: WinRateFilter): Promise<Record<string, { wins: number; games: number; rate: number }>> {
    const db = this.storage.getDatabase();

    // For now, group by AI model
    const results = db.prepare(`
      SELECT
        gp.ai_model as group_key,
        COUNT(*) as games,
        SUM(CASE WHEN gp.final_rank = 1 THEN 1 ELSE 0 END) as wins
      FROM game_players gp
      JOIN games g ON g.id = gp.game_id
      WHERE gp.is_ai = 1 AND gp.ai_model IS NOT NULL
      GROUP BY gp.ai_model
    `).all() as { group_key: string; games: number; wins: number }[];

    const winRates: Record<string, { wins: number; games: number; rate: number }> = {};

    results.forEach(r => {
      winRates[r.group_key] = {
        wins: r.wins,
        games: r.games,
        rate: r.games > 0 ? Math.round((r.wins / r.games) * 100) / 100 : 0
      };
    });

    return winRates;
  }

  /**
   * Get tips effectiveness
   */
  async getTipsEffectiveness(): Promise<Array<{
    tipId: string;
    timesApplied: number;
    winRateWhenApplied: number;
  }>> {
    const db = this.storage.getDatabase();

    // Get all decisions with tips applied
    const decisions = db.prepare(`
      SELECT d.tips_applied_json, d.game_id, d.player_color,
             gp.final_rank
      FROM ai_decisions d
      JOIN game_players gp ON gp.game_id = d.game_id AND gp.color = d.player_color
      WHERE d.tips_applied_json IS NOT NULL
    `).all() as any[];

    const tipStats: Record<string, { applied: number; wins: number }> = {};

    decisions.forEach(d => {
      try {
        const tips = JSON.parse(d.tips_applied_json || '[]');
        const isWin = d.final_rank === 1;

        tips.forEach((tipId: string) => {
          if (!tipStats[tipId]) {
            tipStats[tipId] = { applied: 0, wins: 0 };
          }
          tipStats[tipId].applied++;
          if (isWin) tipStats[tipId].wins++;
        });
      } catch {
        // Ignore parse errors
      }
    });

    return Object.entries(tipStats).map(([tipId, stats]) => ({
      tipId,
      timesApplied: stats.applied,
      winRateWhenApplied: stats.applied > 0 ? Math.round((stats.wins / stats.applied) * 100) / 100 : 0
    }));
  }

  /**
   * Get learning progress over time
   */
  async getLearningProgress(days: number): Promise<Array<{
    date: string;
    winRate: number;
    avgResponseTime: number;
    gamesPlayed: number;
  }>> {
    const db = this.storage.getDatabase();

    const results = db.prepare(`
      SELECT
        DATE(g.started_at) as date,
        COUNT(*) as games,
        AVG(d.response_time_ms) as avg_time
      FROM games g
      LEFT JOIN ai_decisions d ON d.game_id = g.id
      WHERE g.started_at >= DATE('now', '-' || ? || ' days')
      GROUP BY DATE(g.started_at)
      ORDER BY date
    `).all(days) as any[];

    // Calculate win rates per day
    const winRates = db.prepare(`
      SELECT
        DATE(g.started_at) as date,
        SUM(CASE WHEN gp.final_rank = 1 AND gp.is_ai = 1 THEN 1 ELSE 0 END) as ai_wins,
        COUNT(DISTINCT g.id) as total_games
      FROM games g
      JOIN game_players gp ON gp.game_id = g.id
      WHERE g.started_at >= DATE('now', '-' || ? || ' days')
      GROUP BY DATE(g.started_at)
    `).all(days) as any[];

    const winRateMap: Record<string, number> = {};
    winRates.forEach(w => {
      winRateMap[w.date] = w.total_games > 0 ? w.ai_wins / w.total_games : 0;
    });

    return results.map(r => ({
      date: r.date,
      winRate: Math.round((winRateMap[r.date] || 0) * 100) / 100,
      avgResponseTime: Math.round(r.avg_time || 0),
      gamesPlayed: r.games
    }));
  }

  // ============ Recording Methods ============

  /**
   * Record a new game
   */
  async recordGame(game: {
    id: string;
    type: 'simulation' | 'human_vs_ai';
    startedAt: string;
    endedAt: string;
    winner: string;
    totalTurns: number;
    tipsProfile?: string;
    config?: any;
  }): Promise<void> {
    const db = this.storage.getDatabase();

    const durationMs = new Date(game.endedAt).getTime() - new Date(game.startedAt).getTime();

    db.prepare(`
      INSERT INTO games (id, type, started_at, ended_at, duration_ms, winner, total_turns, tips_profile, config_json)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      game.id,
      game.type,
      game.startedAt,
      game.endedAt,
      durationMs,
      game.winner,
      game.totalTurns,
      game.tipsProfile,
      JSON.stringify(game.config || {})
    );
  }

  /**
   * Record a game player
   */
  async recordPlayer(player: {
    gameId: string;
    color: string;
    name: string;
    isAI: boolean;
    aiModel?: string;
    finalRank: number;
    captures: number;
    tokensHome: number;
    sixesRolled: number;
  }): Promise<void> {
    const db = this.storage.getDatabase();

    db.prepare(`
      INSERT INTO game_players (game_id, color, name, is_ai, ai_model, final_rank, captures, tokens_home, sixes_rolled)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      player.gameId,
      player.color,
      player.name,
      player.isAI ? 1 : 0,
      player.aiModel,
      player.finalRank,
      player.captures,
      player.tokensHome,
      player.sixesRolled
    );
  }

  /**
   * Record an AI decision
   */
  async recordAIDecision(decision: {
    gameId: string;
    turnNumber: number;
    playerColor: string;
    diceValue: number;
    validMoves: number[];
    selectedToken: number;
    reasoning: string;
    confidence?: number;
    responseTimeMs: number;
    tipsApplied: string[];
    wasCapture: boolean;
    reachedHome: boolean;
  }): Promise<void> {
    const db = this.storage.getDatabase();

    db.prepare(`
      INSERT INTO ai_decisions (
        game_id, turn_number, player_color, dice_value, valid_moves_json,
        selected_token, reasoning, confidence, response_time_ms, tips_applied_json,
        was_capture, reached_home
      )
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      decision.gameId,
      decision.turnNumber,
      decision.playerColor,
      decision.diceValue,
      JSON.stringify(decision.validMoves),
      decision.selectedToken,
      decision.reasoning,
      decision.confidence,
      decision.responseTimeMs,
      JSON.stringify(decision.tipsApplied),
      decision.wasCapture ? 1 : 0,
      decision.reachedHome ? 1 : 0
    );
  }
}
