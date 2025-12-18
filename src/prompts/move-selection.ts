/**
 * Prompt templates for AI move selection
 */

import { Player, PlayerColor, Token, OnlineGameState, SAFE_SPOTS, VISIBLE_SAFE_SPOTS, START_SPOTS } from '../shared/types.js';

/**
 * System prompt for move selection
 */
export const MOVE_SELECTION_SYSTEM_PROMPT = `You are an expert Luddo (Ludo) game AI. You analyze board positions and select the optimal token to move.

GAME RULES:
- Roll 6 to exit yard (starting position)
- Roll 6, capture, or reach home = extra turn
- Safe spots (stars at 8, 21, 34, 47) and start positions (0, 13, 26, 39) cannot be captured
- First to get all 4 tokens home wins
- Cannot overshoot home (need exact roll)

RESPONSE FORMAT:
Respond with ONLY a JSON object (no other text):
{"token": <0-3>, "reasoning": "<brief explanation>"}`;

/**
 * Format token status for prompt
 */
function formatTokenStatus(token: Token): string {
  if (token.position === -1) return 'yard';
  if (token.position === 99) return 'HOME';
  if (token.position >= 100) return `home-stretch(${token.position - 100 + 1}/5)`;
  if (START_SPOTS.includes(token.position)) return `pos${token.position}(START-SAFE)`;
  if (VISIBLE_SAFE_SPOTS.includes(token.position)) return `pos${token.position}(STAR-SAFE)`;
  return `pos${token.position}`;
}

/**
 * Calculate distance between two positions on circular board
 */
function getDistanceBehind(myPos: number, oppPos: number): number {
  if (myPos < 0 || oppPos < 0) return -1;
  if (myPos >= 100 || oppPos >= 100) return -1;

  // How far behind is opponent from my position?
  const diff = (myPos - oppPos + 52) % 52;
  return diff > 0 && diff <= 6 ? diff : -1;
}

/**
 * Analyze threats and opportunities
 */
function analyzeBoard(
  currentPlayer: Player,
  allPlayers: Record<PlayerColor, Player>,
  activePlayers: PlayerColor[]
): { threats: string[]; opportunities: string[] } {
  const threats: string[] = [];
  const opportunities: string[] = [];

  currentPlayer.tokens.forEach(myToken => {
    if (myToken.position < 0 || myToken.position >= 100) return;

    activePlayers.forEach(oppColor => {
      if (oppColor === currentPlayer.id) return;
      const oppPlayer = allPlayers[oppColor];

      oppPlayer.tokens.forEach(oppToken => {
        if (oppToken.position < 0 || oppToken.position >= 100) return;

        // Check if opponent is behind me (threat)
        const distBehind = getDistanceBehind(myToken.position, oppToken.position);
        if (distBehind > 0 && distBehind <= 6) {
          if (!SAFE_SPOTS.includes(myToken.position)) {
            threats.push(`T${myToken.id} at risk from ${oppColor} (${distBehind} behind)`);
          }
        }

        // Check if I can capture opponent
        const distAhead = getDistanceBehind(oppToken.position, myToken.position);
        if (distAhead > 0 && distAhead <= 6) {
          if (!SAFE_SPOTS.includes(oppToken.position)) {
            opportunities.push(`T${myToken.id} can capture ${oppColor} in ${distAhead}`);
          }
        }
      });
    });
  });

  return { threats, opportunities };
}

/**
 * Generate user prompt for move selection
 */
export function generateMovePrompt(
  gameState: OnlineGameState,
  diceValue: number,
  validMoves: number[],
  tips?: string[]
): string {
  const currentPlayer = gameState.players[gameState.currentTurn];
  const { threats, opportunities } = analyzeBoard(
    currentPlayer,
    gameState.players,
    gameState.activeTurnOrder
  );

  const tokenStatus = currentPlayer.tokens
    .map(t => `  T${t.id}: ${formatTokenStatus(t)} (step ${t.stepCount})`)
    .join('\n');

  const opponentStatus = gameState.activeTurnOrder
    .filter(c => c !== gameState.currentTurn)
    .map(c => {
      const p = gameState.players[c];
      const onBoard = p.tokens.filter(t => t.position >= 0 && t.position < 99).length;
      const home = p.tokens.filter(t => t.position === 99).length;
      return `  ${c}: ${onBoard} on board, ${home} home`;
    })
    .join('\n');

  let prompt = `CURRENT GAME STATE:
You are: ${gameState.currentTurn.toUpperCase()}
Dice rolled: ${diceValue}
Valid moves: [${validMoves.join(', ')}]

YOUR TOKENS:
${tokenStatus}

OPPONENTS:
${opponentStatus}`;

  if (threats.length > 0) {
    prompt += `\n\nTHREATS:\n${threats.map(t => `  - ${t}`).join('\n')}`;
  }

  if (opportunities.length > 0) {
    prompt += `\n\nOPPORTUNITIES:\n${opportunities.map(o => `  - ${o}`).join('\n')}`;
  }

  if (tips && tips.length > 0) {
    prompt += `\n\nSTRATEGY TIPS:\n${tips.map(t => `  - ${t}`).join('\n')}`;
  }

  prompt += `\n\nSelect ONE token to move. Respond with JSON only: {"token": <id>, "reasoning": "<why>"}`;

  return prompt;
}

/**
 * Parse AI response to extract token selection
 */
export function parseAIResponse(response: string, validMoves: number[]): {
  tokenId: number;
  reasoning: string;
  confidence: number;
} {
  try {
    // Try to parse as JSON
    const jsonMatch = response.match(/\{[^}]+\}/);
    if (jsonMatch) {
      const parsed = JSON.parse(jsonMatch[0]);
      const tokenId = parsed.token ?? parsed.tokenId ?? parsed.id;

      if (typeof tokenId === 'number' && validMoves.includes(tokenId)) {
        return {
          tokenId,
          reasoning: parsed.reasoning || parsed.reason || 'No reasoning provided',
          confidence: 0.9
        };
      }
    }

    // Try to extract number
    const numberMatch = response.match(/\b([0-3])\b/);
    if (numberMatch) {
      const tokenId = parseInt(numberMatch[1]);
      if (validMoves.includes(tokenId)) {
        return {
          tokenId,
          reasoning: response.trim(),
          confidence: 0.7
        };
      }
    }
  } catch (e) {
    // Parse failed
  }

  // Fallback: return first valid move
  return {
    tokenId: validMoves[0],
    reasoning: 'Fallback selection',
    confidence: 0.3
  };
}
