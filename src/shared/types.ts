// === Shared Types for Luddo Royale ===
// Copied from luddo/shared/types.ts for AI service

export type PlayerColor = 'red' | 'green' | 'yellow' | 'blue';
export type PieceDesign = 'pawn' | 'crown' | 'gem';
export type GameState = 'setup' | 'playing' | 'finished';

export interface Token {
  id: number;              // 0-3 (four tokens per player)
  color: PlayerColor;      // Player color
  position: number;        // -1=yard, 0-51=main track, 100+=home stretch, 99=finished
  stepCount: number;       // Primary tracking: -1=yard, 0-56=steps from start
}

export interface Player {
  id: PlayerColor;
  name: string;
  color: string;           // Hex color (#ef4444)
  darkColor: string;       // Darker shade (#991b1b)
  bgClass: string;         // Tailwind bg class
  textClass: string;       // Tailwind text class
  borderClass: string;     // Tailwind border class
  tokens: Token[];         // 4 tokens
  startPos: number;        // Starting position on board (0, 13, 26, or 39)
  active: boolean;         // Is this player in the game?
  isAI?: boolean;          // Is this an AI player?
  aiType?: 'ultra' | 'openai' | 'gemini' | 'ollama';
  kills: number;           // Number of opponent tokens captured
  sixes: number;           // Number of 6s rolled
}

// --- Game Constants ---

export const GLOBAL_PATH_COORDS: { x: number; y: number }[] = [
  // RED QUADRANT (Bottom Left)
  { x: 6, y: 13 }, { x: 6, y: 12 }, { x: 6, y: 11 }, { x: 6, y: 10 }, { x: 6, y: 9 },
  { x: 5, y: 8 }, { x: 4, y: 8 }, { x: 3, y: 8 }, { x: 2, y: 8 }, { x: 1, y: 8 },
  { x: 0, y: 8 }, { x: 0, y: 7 }, { x: 0, y: 6 },
  // BLUE QUADRANT (Top Left)
  { x: 1, y: 6 }, { x: 2, y: 6 }, { x: 3, y: 6 }, { x: 4, y: 6 }, { x: 5, y: 6 },
  { x: 6, y: 5 }, { x: 6, y: 4 }, { x: 6, y: 3 }, { x: 6, y: 2 }, { x: 6, y: 1 },
  { x: 6, y: 0 }, { x: 7, y: 0 }, { x: 8, y: 0 },
  // YELLOW QUADRANT (Top Right)
  { x: 8, y: 1 }, { x: 8, y: 2 }, { x: 8, y: 3 }, { x: 8, y: 4 }, { x: 8, y: 5 },
  { x: 9, y: 6 }, { x: 10, y: 6 }, { x: 11, y: 6 }, { x: 12, y: 6 }, { x: 13, y: 6 },
  { x: 14, y: 6 }, { x: 14, y: 7 }, { x: 14, y: 8 },
  // GREEN QUADRANT (Bottom Right)
  { x: 13, y: 8 }, { x: 12, y: 8 }, { x: 11, y: 8 }, { x: 10, y: 8 }, { x: 9, y: 8 },
  { x: 8, y: 9 }, { x: 8, y: 10 }, { x: 8, y: 11 }, { x: 8, y: 12 }, { x: 8, y: 13 },
  { x: 8, y: 14 }, { x: 7, y: 14 }, { x: 6, y: 14 },
];

export const SAFE_SPOTS = [0, 8, 13, 14, 21, 26, 27, 34, 39, 40, 47];
export const VISIBLE_SAFE_SPOTS = [8, 21, 34, 47]; // Stars only
export const START_SPOTS = [0, 13, 26, 39];

export const HOME_PATHS: Record<PlayerColor, { x: number; y: number }[]> = {
  red: [{ x: 7, y: 13 }, { x: 7, y: 12 }, { x: 7, y: 11 }, { x: 7, y: 10 }, { x: 7, y: 9 }],
  green: [{ x: 13, y: 7 }, { x: 12, y: 7 }, { x: 11, y: 7 }, { x: 10, y: 7 }, { x: 9, y: 7 }],
  yellow: [{ x: 7, y: 1 }, { x: 7, y: 2 }, { x: 7, y: 3 }, { x: 7, y: 4 }, { x: 7, y: 5 }],
  blue: [{ x: 1, y: 7 }, { x: 2, y: 7 }, { x: 3, y: 7 }, { x: 4, y: 7 }, { x: 5, y: 7 }]
};

export const YARD_COORDS: Record<PlayerColor, { x: number, y: number }[]> = {
  red: [{ x: 1, y: 10 }, { x: 4, y: 10 }, { x: 1, y: 13 }, { x: 4, y: 13 }],
  blue: [{ x: 1, y: 1 }, { x: 4, y: 1 }, { x: 1, y: 4 }, { x: 4, y: 4 }],
  yellow: [{ x: 10, y: 1 }, { x: 13, y: 1 }, { x: 10, y: 4 }, { x: 13, y: 4 }],
  green: [{ x: 10, y: 10 }, { x: 13, y: 10 }, { x: 10, y: 13 }, { x: 13, y: 13 }]
};

export const PLAYERS_CONFIG: Record<PlayerColor, Omit<Player, 'tokens' | 'active'>> = {
  red: {
    id: 'red',
    name: 'Red',
    color: '#ef4444',
    darkColor: '#991b1b',
    bgClass: 'bg-red-500',
    textClass: 'text-red-500',
    borderClass: 'border-red-500',
    startPos: 0,
    kills: 0,
    sixes: 0
  },
  blue: {
    id: 'blue',
    name: 'Blue',
    color: '#3b82f6',
    darkColor: '#1e40af',
    bgClass: 'bg-blue-500',
    textClass: 'text-blue-500',
    borderClass: 'border-blue-500',
    startPos: 13,
    kills: 0,
    sixes: 0
  },
  yellow: {
    id: 'yellow',
    name: 'Yellow',
    color: '#eab308',
    darkColor: '#854d0e',
    bgClass: 'bg-yellow-500',
    textClass: 'text-yellow-500',
    borderClass: 'border-yellow-500',
    startPos: 26,
    kills: 0,
    sixes: 0
  },
  green: {
    id: 'green',
    name: 'Green',
    color: '#22c55e',
    darkColor: '#166534',
    bgClass: 'bg-green-500',
    textClass: 'text-green-500',
    borderClass: 'border-green-500',
    startPos: 39,
    kills: 0,
    sixes: 0
  },
};

// --- Game State Types ---

export interface OnlineGameState {
  gameState: GameState;
  players: Record<PlayerColor, Player>;
  activeTurnOrder: PlayerColor[];
  currentTurn: PlayerColor;
  diceValue: number;
  hasRolled: boolean;
  validMoves: number[];
  winner: PlayerColor | null;
  rankings: PlayerColor[];
  lastMessage: string | null;
}

export interface MoveResult {
  success: boolean;
  newGameState?: OnlineGameState;
  capturedToken?: { color: PlayerColor; tokenId: number };
  reachedHome?: boolean;
  gameOver?: boolean;
  error?: string;
}

export interface DiceRollResult {
  value: number;
  validMoves: number[];
  autoSkip: boolean;
}
