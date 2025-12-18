# Luddo AI Service - API Documentation

Complete API reference for building an iOS dashboard app to control AI game simulations, manage strategy tips, view metrics, and trigger model fine-tuning.

---

## Service Info

| Property | Value |
|----------|-------|
| Base URL | `http://localhost:3010` |
| Protocol | REST + WebSocket |
| Auth | API Key in header |
| Content-Type | `application/json` |

---

## Authentication

All endpoints (except `/api/health`) require an API key header:

```
X-API-Key: luddo-ai-2025-secret-key
```

Example:
```bash
curl -H "X-API-Key: luddo-ai-2025-secret-key" http://localhost:3010/api/tips
```

---

## Endpoints Overview

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/` | Service info |
| GET | `/api/health` | Health check (no auth) |
| GET | `/api/tips` | List all tips |
| POST | `/api/tips` | Create new tip |
| PUT | `/api/tips/:id` | Update tip |
| DELETE | `/api/tips/:id` | Delete tip |
| GET | `/api/tips/profiles` | List tip profiles |
| POST | `/api/simulation/start` | Start simulation batch |
| POST | `/api/simulation/stop` | Stop simulation |
| POST | `/api/simulation/pause` | Pause simulation |
| POST | `/api/simulation/resume` | Resume simulation |
| GET | `/api/simulation/status` | Current simulation status |
| GET | `/api/simulation/history` | Past simulation batches |
| GET | `/api/metrics/overview` | Dashboard metrics |
| GET | `/api/metrics/games` | Game history |
| GET | `/api/metrics/win-rates` | Win rate analytics |
| GET | `/api/metrics/learning-progress` | AI improvement over time |
| POST | `/api/training/generate-dataset` | Create training dataset |
| POST | `/api/training/start` | Start fine-tuning |
| GET | `/api/training/status/:id` | Training job status |
| GET | `/api/training/datasets` | List datasets |
| GET | `/api/models` | List available models |
| POST | `/api/models/switch` | Change active model |
| POST | `/api/ai/move` | Request AI move decision |
| GET | `/api/ai/status` | AI service status |
| WS | `/ws` | Real-time events |

---

## Detailed Endpoints

### Health Check

```
GET /api/health
```

No authentication required.

**Response:**
```json
{
  "status": "ok",
  "service": "luddo-ai-service",
  "version": "1.0.0",
  "uptime": 3600,
  "ollama": "connected",
  "timestamp": "2025-12-18T19:00:00.000Z"
}
```

---

### Tips Management

#### List All Tips

```
GET /api/tips
GET /api/tips?category=aggressive
GET /api/tips?active=true
```

**Response:**
```json
{
  "tips": [
    {
      "id": "tip_001",
      "category": "aggressive",
      "subcategory": "capture",
      "priority": 1,
      "content": "Always prioritize capturing opponent tokens when within striking distance (1-6 spaces behind). Captures send opponents back to yard and grant an extra turn.",
      "shortPrompt": "Capture when possible - maximum disruption to opponents",
      "weight": 1.5,
      "active": true,
      "createdAt": "2025-12-18T18:00:00.000Z"
    }
  ],
  "total": 10
}
```

#### Create Tip

```
POST /api/tips
```

**Request Body:**
```json
{
  "category": "aggressive",
  "subcategory": "capture",
  "priority": 1,
  "content": "Full explanation of the strategy tip",
  "shortPrompt": "Brief version for AI prompt injection",
  "weight": 1.0
}
```

**Response:**
```json
{
  "id": "tip_012",
  "message": "Tip created successfully"
}
```

#### Update Tip

```
PUT /api/tips/:id
```

**Request Body:**
```json
{
  "content": "Updated content",
  "active": false,
  "weight": 2.0
}
```

#### Delete Tip

```
DELETE /api/tips/:id
```

#### List Tip Profiles

```
GET /api/tips/profiles
```

**Response:**
```json
{
  "profiles": [
    {
      "id": "aggressive-v1",
      "name": "Aggressive Strategy",
      "description": "Prioritizes captures and blocking",
      "tipIds": ["tip_001", "tip_002", "tip_003"]
    },
    {
      "id": "defensive-v1",
      "name": "Defensive Strategy",
      "description": "Prioritizes safety and avoidance",
      "tipIds": ["tip_004", "tip_005", "tip_006"]
    },
    {
      "id": "balanced-v1",
      "name": "Balanced Strategy",
      "description": "Mix of aggressive and defensive",
      "tipIds": ["tip_001", "tip_004", "tip_007"]
    }
  ]
}
```

---

### Simulation Control

#### Start Simulation Batch

```
POST /api/simulation/start
```

**Request Body:**
```json
{
  "batchSize": 10,
  "speed": "fast",
  "aiModels": {
    "red": "llama3.2:3b",
    "blue": "llama3.2:3b",
    "yellow": "llama3.2:3b",
    "green": "llama3.2:3b"
  },
  "tipsProfile": "aggressive-v1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| batchSize | number | Yes | Number of games to simulate (1-100) |
| speed | string | Yes | `"fast"`, `"normal"`, or `"slow"` |
| aiModels | object | No | Model per player color |
| tipsProfile | string | No | Tips profile ID to apply |

**Response:**
```json
{
  "batchId": "batch_1766085368848_a03f48",
  "status": "started",
  "estimatedDuration": "30m"
}
```

#### Stop Simulation

```
POST /api/simulation/stop
```

**Request Body:**
```json
{
  "batchId": "batch_1766085368848_a03f48"
}
```

**Response:**
```json
{
  "message": "Batch stopped",
  "gamesCompleted": 7
}
```

#### Pause Simulation

```
POST /api/simulation/pause
```

**Request Body:**
```json
{
  "batchId": "batch_1766085368848_a03f48"
}
```

#### Resume Simulation

```
POST /api/simulation/resume
```

**Request Body:**
```json
{
  "batchId": "batch_1766085368848_a03f48"
}
```

**Response:**
```json
{
  "message": "Batch resumed",
  "gamesRemaining": 3
}
```

#### Get Simulation Status

```
GET /api/simulation/status
```

**Response:**
```json
{
  "isRunning": true,
  "currentBatch": {
    "id": "batch_1766085368848_a03f48",
    "status": "running",
    "config": {
      "batchSize": 10,
      "speed": "fast"
    },
    "startedAt": "2025-12-18T19:16:08.848Z",
    "gamesCompleted": 3,
    "totalGames": 10,
    "currentGame": {
      "id": "game_abc123",
      "turn": 156,
      "rankings": []
    }
  }
}
```

#### Get Simulation History

```
GET /api/simulation/history?limit=20&offset=0
```

**Response:**
```json
{
  "batches": [
    {
      "id": "batch_1766085368848_a03f48",
      "started_at": "2025-12-18T19:16:08.848Z",
      "ended_at": "2025-12-18T19:45:00.000Z",
      "status": "completed",
      "total_games": 10,
      "completed_games": 10,
      "config": {
        "batchSize": 10,
        "speed": "fast"
      }
    }
  ],
  "total": 5
}
```

---

### Metrics & Analytics

#### Overview Dashboard

```
GET /api/metrics/overview
```

**Response:**
```json
{
  "totalGames": 150,
  "simulationGames": 140,
  "humanGames": 10,
  "totalAIDecisions": 45000,
  "avgResponseTimeMs": 1200,
  "winRatesByModel": {
    "llama3.2:3b": 0.25,
    "qwen2.5:7b-instruct-q4_K_M": 0.28
  },
  "winRatesByColor": {
    "red": 0.26,
    "blue": 0.24,
    "yellow": 0.25,
    "green": 0.25
  },
  "capturesTotal": 2400,
  "avgTurnsPerGame": 380,
  "lastUpdated": "2025-12-18T19:30:00.000Z"
}
```

#### Game History

```
GET /api/metrics/games?type=simulation&limit=50&offset=0
```

**Query Parameters:**
| Param | Type | Description |
|-------|------|-------------|
| type | string | `"simulation"` or `"human_vs_ai"` |
| limit | number | Results per page (default 50) |
| offset | number | Pagination offset |

**Response:**
```json
{
  "games": [
    {
      "id": "game_abc123",
      "type": "simulation",
      "started_at": "2025-12-18T19:16:08.000Z",
      "ended_at": "2025-12-18T19:23:32.000Z",
      "duration_ms": 444000,
      "winner": "green",
      "total_turns": 445,
      "players": [
        {
          "color": "red",
          "is_ai": true,
          "ai_model": "llama3.2:3b",
          "final_rank": 2,
          "captures": 3
        }
      ]
    }
  ],
  "total": 150
}
```

#### Win Rate Analytics

```
GET /api/metrics/win-rates?groupBy=model
GET /api/metrics/win-rates?groupBy=color
GET /api/metrics/win-rates?groupBy=tipsProfile
```

**Response:**
```json
{
  "groupBy": "model",
  "data": [
    {
      "key": "llama3.2:3b",
      "wins": 35,
      "games": 140,
      "winRate": 0.25
    },
    {
      "key": "qwen2.5:7b-instruct-q4_K_M",
      "wins": 3,
      "games": 10,
      "winRate": 0.30
    }
  ]
}
```

#### Learning Progress

```
GET /api/metrics/learning-progress?days=30
```

**Response:**
```json
{
  "progress": [
    {
      "date": "2025-12-18",
      "winRate": 0.25,
      "avgResponseTime": 1200,
      "gamesPlayed": 10
    },
    {
      "date": "2025-12-17",
      "winRate": 0.23,
      "avgResponseTime": 1350,
      "gamesPlayed": 15
    }
  ]
}
```

---

### Training Pipeline

#### Generate Training Dataset

```
POST /api/training/generate-dataset
```

**Request Body:**
```json
{
  "source": "simulation",
  "dateRange": {
    "from": "2025-12-01",
    "to": "2025-12-18"
  },
  "filterBy": {
    "minConfidence": 0.7,
    "winnersOnly": true
  },
  "maxExamples": 5000
}
```

**Response:**
```json
{
  "datasetId": "dataset_20251218_abc123",
  "path": "/Volumes/AI_SSD/ai-local/data/training/datasets/dataset_20251218_abc123.jsonl",
  "examples": 4850,
  "sizeBytes": 2450000
}
```

#### Start Fine-Tuning

```
POST /api/training/start
```

**Request Body:**
```json
{
  "baseModel": "llama3.2:3b",
  "datasetId": "dataset_20251218_abc123",
  "outputModelName": "luddo-v1",
  "epochs": 3
}
```

**Response:**
```json
{
  "trainingId": "train_abc123",
  "status": "started",
  "message": "Fine-tuning started"
}
```

#### Get Training Status

```
GET /api/training/status/:trainingId
```

**Response:**
```json
{
  "id": "train_abc123",
  "status": "training",
  "progress": 65,
  "baseModel": "llama3.2:3b",
  "outputModel": "luddo-v1",
  "datasetSize": 4850,
  "epochs": 3,
  "currentEpoch": 2,
  "startedAt": "2025-12-18T20:00:00.000Z",
  "estimatedCompletion": "2025-12-18T21:30:00.000Z"
}
```

#### List Datasets

```
GET /api/training/datasets
```

**Response:**
```json
{
  "datasets": [
    {
      "id": "dataset_20251218_abc123",
      "createdAt": "2025-12-18T19:00:00.000Z",
      "examples": 4850,
      "source": "simulation",
      "sizeBytes": 2450000
    }
  ]
}
```

---

### Model Management

#### List Available Models

```
GET /api/models
```

**Response:**
```json
{
  "models": [
    {
      "name": "qwen2.5:7b-instruct-q4_K_M",
      "size": "4.4 GB",
      "quantization": "Q4_K_M",
      "purpose": "Human games (high quality)"
    },
    {
      "name": "llama3.2:3b",
      "size": "2.0 GB",
      "quantization": "Q4_0",
      "purpose": "Simulations (fast)"
    },
    {
      "name": "luddo-v1",
      "size": "2.1 GB",
      "quantization": "Q4_0",
      "purpose": "Fine-tuned for Luddo"
    }
  ],
  "activeModels": {
    "humanGames": "qwen2.5:7b-instruct-q4_K_M",
    "simulation": "llama3.2:3b"
  }
}
```

#### Switch Active Model

```
POST /api/models/switch
```

**Request Body:**
```json
{
  "purpose": "simulation",
  "model": "luddo-v1"
}
```

**Response:**
```json
{
  "message": "Model switched",
  "purpose": "simulation",
  "previousModel": "llama3.2:3b",
  "newModel": "luddo-v1"
}
```

---

### AI Move Selection

#### Request AI Move

```
POST /api/ai/move
```

Used by the game frontend to get intelligent move decisions.

**Request Body:**
```json
{
  "gameState": {
    "gameState": "playing",
    "currentTurn": "red",
    "activeTurnOrder": ["red", "blue", "yellow", "green"],
    "diceValue": 6,
    "hasRolled": true,
    "validMoves": [0, 1, 2, 3],
    "winner": null,
    "rankings": [],
    "lastMessage": null,
    "players": {
      "red": {
        "id": "red",
        "tokens": [
          {"id": 0, "color": "red", "position": -1, "stepCount": -1},
          {"id": 1, "color": "red", "position": 5, "stepCount": 5},
          {"id": 2, "color": "red", "position": -1, "stepCount": -1},
          {"id": 3, "color": "red", "position": -1, "stepCount": -1}
        ],
        "active": true,
        "startPos": 0
      },
      "blue": {
        "id": "blue",
        "tokens": [
          {"id": 0, "color": "blue", "position": 15, "stepCount": 2},
          {"id": 1, "color": "blue", "position": -1, "stepCount": -1},
          {"id": 2, "color": "blue", "position": -1, "stepCount": -1},
          {"id": 3, "color": "blue", "position": -1, "stepCount": -1}
        ],
        "active": true,
        "startPos": 13
      }
    }
  },
  "diceValue": 6,
  "validMoves": [0, 1, 2, 3],
  "aiType": "ultra",
  "tipsProfile": "aggressive-v1"
}
```

| Field | Type | Required | Description |
|-------|------|----------|-------------|
| gameState | object | Yes | Full game state |
| diceValue | number | Yes | Current dice roll (1-6) |
| validMoves | array | Yes | Token IDs that can move |
| aiType | string | No | `"ultra"`, `"ollama"` (default) |
| tipsProfile | string | No | Tips profile to apply |

**Response:**
```json
{
  "tokenId": 0,
  "reasoning": "Move the first token as it's in the yard and a 6 is rolled, allowing it to exit.",
  "confidence": 0.9,
  "model": "qwen2.5:7b-instruct-q4_K_M",
  "processingTimeMs": 1250
}
```

#### AI Service Status

```
GET /api/ai/status
```

**Response:**
```json
{
  "status": "ready",
  "ollama": {
    "connected": true,
    "models": ["qwen2.5:7b-instruct-q4_K_M", "llama3.2:3b"]
  }
}
```

---

## WebSocket Events

Connect to `ws://localhost:3010/ws?apiKey=luddo-ai-2025-secret-key`

### Event Types

#### simulation:progress

Sent periodically during simulation.

```json
{
  "event": "simulation:progress",
  "data": {
    "batchId": "batch_abc123",
    "gamesCompleted": 5,
    "totalGames": 10,
    "currentGame": {
      "id": "game_xyz",
      "turn": 234,
      "rankings": []
    }
  }
}
```

#### simulation:gameEnd

Sent when a game finishes.

```json
{
  "event": "simulation:gameEnd",
  "data": {
    "batchId": "batch_abc123",
    "gameId": "game_xyz",
    "winner": "green",
    "rankings": ["green", "red", "blue", "yellow"],
    "turns": 445
  }
}
```

#### simulation:batchEnd

Sent when entire batch completes.

```json
{
  "event": "simulation:batchEnd",
  "data": {
    "batchId": "batch_abc123",
    "summary": {
      "totalGames": 10,
      "gamesCompleted": 10,
      "duration": "28m 15s",
      "winsByColor": {
        "red": 3,
        "blue": 2,
        "yellow": 2,
        "green": 3
      }
    }
  }
}
```

#### training:progress

Sent during fine-tuning.

```json
{
  "event": "training:progress",
  "data": {
    "trainingId": "train_abc123",
    "progress": 65,
    "currentEpoch": 2,
    "totalEpochs": 3
  }
}
```

#### training:complete

Sent when training finishes.

```json
{
  "event": "training:complete",
  "data": {
    "trainingId": "train_abc123",
    "outputModel": "luddo-v1",
    "success": true
  }
}
```

---

## Error Responses

All errors follow this format:

```json
{
  "error": "Error type",
  "message": "Detailed error message"
}
```

### HTTP Status Codes

| Code | Meaning |
|------|---------|
| 200 | Success |
| 400 | Bad request (invalid params) |
| 401 | Unauthorized (missing/invalid API key) |
| 404 | Not found |
| 409 | Conflict (e.g., simulation already running) |
| 500 | Server error |

---

## Game State Reference

### Token Position Values

| Value | Meaning |
|-------|---------|
| -1 | In yard (not on board) |
| 0-51 | On main circular track |
| 100-104 | In home stretch |
| 99 | Finished (home) |

### Player Colors

`"red"`, `"blue"`, `"yellow"`, `"green"`

### Player Start Positions

| Color | Start Position |
|-------|---------------|
| red | 0 |
| blue | 13 |
| yellow | 26 |
| green | 39 |

### Safe Spots

- **Star spots** (visible): 8, 21, 34, 47
- **Start spots**: 0, 13, 26, 39

Tokens on safe spots cannot be captured.

---

## Rate Limits

| Endpoint | Limit |
|----------|-------|
| `/api/ai/move` | 10 req/sec |
| `/api/simulation/start` | 1 concurrent batch |
| `/api/training/start` | 1 concurrent job |
| All others | 100 req/sec |

---

## iOS App Suggested Screens

1. **Dashboard** - Overview metrics, current simulation status
2. **Simulations** - Start/stop/pause, view history, real-time progress
3. **Tips Manager** - CRUD tips, manage profiles
4. **Training** - Generate datasets, start fine-tuning, view progress
5. **Models** - List models, switch active model
6. **Settings** - API configuration, notifications

---

## Quick Start Examples

### Check Service Health
```bash
curl http://localhost:3010/api/health
```

### Start 5-Game Simulation
```bash
curl -X POST http://localhost:3010/api/simulation/start \
  -H "X-API-Key: luddo-ai-2025-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 5, "speed": "fast"}'
```

### Get All Tips
```bash
curl http://localhost:3010/api/tips \
  -H "X-API-Key: luddo-ai-2025-secret-key"
```

### Check Metrics
```bash
curl http://localhost:3010/api/metrics/overview \
  -H "X-API-Key: luddo-ai-2025-secret-key"
```
