# Luddo AI Simulation System - Setup Guide

Complete setup documentation for the Luddo AI learning and simulation system.

---

## System Overview

```
┌─────────────────────────────────────────────────────────────┐
│                    LUDDO AI SYSTEM                          │
├─────────────────────────────────────────────────────────────┤
│                                                             │
│   ┌─────────────┐     ┌─────────────┐     ┌─────────────┐  │
│   │   Luddo     │────▶│  AI Service │────▶│   Ollama    │  │
│   │   Game      │     │  Port 3010  │     │  Port 11434 │  │
│   │  (Frontend) │◀────│  (Backend)  │◀────│   (LLM)     │  │
│   └─────────────┘     └─────────────┘     └─────────────┘  │
│                              │                              │
│                              ▼                              │
│                       ┌─────────────┐                       │
│                       │   SQLite    │                       │
│                       │  + JSON     │                       │
│                       │  Storage    │                       │
│                       └─────────────┘                       │
│                                                             │
└─────────────────────────────────────────────────────────────┘
```

---

## Directory Structure

```
/Volumes/AI_SSD/ai-local/
├── luddo-ai-service/           # Node.js AI service
│   ├── src/
│   │   ├── index.ts            # Express server (Port 3010)
│   │   ├── api/routes/         # REST endpoints
│   │   ├── services/           # Business logic
│   │   │   ├── AIPlayerService.ts
│   │   │   ├── SimulationService.ts
│   │   │   ├── TipsService.ts
│   │   │   ├── TrainingService.ts
│   │   │   ├── MetricsService.ts
│   │   │   └── OllamaService.ts
│   │   ├── simulation/         # Game runner
│   │   ├── prompts/            # LLM prompts
│   │   └── shared/             # Game logic (copied from luddo)
│   ├── scripts/
│   │   ├── start.sh            # Start service
│   │   ├── stop.sh             # Stop service
│   │   ├── status.sh           # Check status
│   │   └── install-service.sh  # Install LaunchAgent
│   ├── luddo-api.md            # Full API documentation
│   └── package.json
│
├── data/
│   ├── tips/tips.json          # Strategy tips (10 pre-loaded)
│   ├── games/simulations/      # Game transcripts
│   ├── training/datasets/      # JSONL training data
│   └── metrics/metrics.db      # SQLite analytics
│
└── logs/
    ├── luddo-ai-service.log
    └── luddo-ai-service.error.log
```

---

## Prerequisites

### 1. Ollama (Required)
```bash
# Install Ollama
brew install ollama

# Pull required models
ollama pull qwen2.5:7b-instruct-q4_K_M   # For human games (higher quality)
ollama pull llama3.2:3b                   # For simulations (faster)

# Verify Ollama is running
curl http://localhost:11434/api/tags
```

### 2. Node.js (Required)
```bash
# Check Node.js version (requires 18+)
node --version

# If not installed
brew install node
```

### 3. External SSD (Recommended)
The system is designed to run from `/Volumes/AI_SSD/ai-local/` to:
- Keep large model outputs off main drive
- Store game transcripts and training data
- Preserve data across system updates

---

## Installation

### Step 1: Clone/Copy AI Service
```bash
# Service should already be at:
/Volumes/AI_SSD/ai-local/luddo-ai-service/
```

### Step 2: Install Dependencies
```bash
cd /Volumes/AI_SSD/ai-local/luddo-ai-service
npm install
```

### Step 3: Start the Service
```bash
# Development mode (with hot reload)
npm run dev

# Or use the start script
./scripts/start.sh

# Check status
./scripts/status.sh
```

### Step 4: Verify Service
```bash
# Health check
curl http://localhost:3010/api/health

# Expected response:
{
  "status": "ok",
  "service": "luddo-ai-service",
  "version": "1.0.0",
  "ollama": "connected"
}
```

---

## Configuration

### Service Config
Location: `/Volumes/AI_SSD/ai-local/data/config/service-config.json`

```json
{
  "server": {
    "port": 3010,
    "host": "0.0.0.0",
    "apiKeyRequired": true
  },
  "auth": {
    "apiKey": "luddo-ai-2025-secret-key"
  },
  "ollama": {
    "baseUrl": "http://localhost:11434",
    "defaultModel": "qwen2.5:7b-instruct-q4_K_M",
    "simulationModel": "llama3.2:3b"
  }
}
```

### Frontend Config
Add to `luddo/.env`:
```bash
VITE_AI_SERVICE_URL=http://localhost:3010
VITE_AI_SERVICE_KEY=luddo-ai-2025-secret-key
VITE_AI_SERVICE_ENABLED=true
```

---

## Running Simulations

### Via API (for iOS Dashboard)
```bash
# Start a 10-game simulation batch
curl -X POST http://localhost:3010/api/simulation/start \
  -H "X-API-Key: luddo-ai-2025-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 10, "speed": "fast"}'

# Check progress
curl http://localhost:3010/api/simulation/status \
  -H "X-API-Key: luddo-ai-2025-secret-key"

# Stop simulation
curl -X POST http://localhost:3010/api/simulation/stop \
  -H "X-API-Key: luddo-ai-2025-secret-key" \
  -d '{"batchId": "batch_xxx"}'
```

### Via Game Frontend (Spectator Mode)
1. Start Luddo game: `cd luddo && npm run dev`
2. Click "Play Against AI"
3. Select "Spectator" mode (purple button)
4. Click "WATCH AI BATTLE"
5. Watch 4 AI players compete with intelligent LLM moves

---

## Auto-Start (LaunchAgent)

### Install
```bash
/Volumes/AI_SSD/ai-local/luddo-ai-service/scripts/install-service.sh
```

### Manual Control
```bash
# Stop
launchctl unload ~/Library/LaunchAgents/com.luddo.ai-service.plist

# Start
launchctl load ~/Library/LaunchAgents/com.luddo.ai-service.plist

# Check status
launchctl list | grep luddo
```

### Uninstall
```bash
launchctl unload ~/Library/LaunchAgents/com.luddo.ai-service.plist
rm ~/Library/LaunchAgents/com.luddo.ai-service.plist
```

---

## API Endpoints Summary

| Endpoint | Method | Description |
|----------|--------|-------------|
| `/api/health` | GET | Health check (no auth) |
| `/api/ai/move` | POST | Get AI move decision |
| `/api/simulation/start` | POST | Start simulation batch |
| `/api/simulation/status` | GET | Current status |
| `/api/simulation/stop` | POST | Stop batch |
| `/api/tips` | GET/POST | Manage strategy tips |
| `/api/metrics/overview` | GET | Dashboard stats |
| `/api/training/start` | POST | Start fine-tuning |
| `/api/models` | GET | List Ollama models |
| `/ws` | WebSocket | Real-time events |

Full API documentation: `luddo-api.md`

---

## Strategy Tips

Pre-loaded tips in `/Volumes/AI_SSD/ai-local/data/tips/tips.json`:

### Aggressive (3 tips)
- Capture opponents within 6 spaces
- Block opponent paths to home stretch
- Race multiple tokens when ahead

### Defensive (4 tips)
- Move to safe spots when threatened
- Spread tokens to minimize capture risk
- Prioritize home stretch entry
- Keep one token in yard as backup

### Situational (3 tips)
- Opening: Get 2-3 tokens out quickly
- Midgame: Balance offense and defense
- Endgame: Rush closest tokens home

---

## Ports Used

| Port | Service | Notes |
|------|---------|-------|
| 3010 | Luddo AI Service | Main API |
| 11434 | Ollama | LLM inference |
| 3000 | Luddo Game (dev) | Frontend |

**Avoided Ports** (hormonology backend):
- 3001: Visitor Tracker
- 3002: Testimonials Service
- 3003: System Monitor

---

## Troubleshooting

### Service Won't Start
```bash
# Check if port is in use
lsof -i :3010

# Check logs
tail -f /Volumes/AI_SSD/ai-local/logs/luddo-ai-service.log
```

### Ollama Not Connected
```bash
# Check Ollama status
curl http://localhost:11434/api/tags

# Start Ollama if needed
ollama serve
```

### AI Moves Slow
- Simulation uses `llama3.2:3b` (fast, ~1s per move)
- Human games use `qwen2.5:7b` (smarter, ~5-10s per move)
- Check Ollama GPU utilization

### Database Errors
```bash
# Reset metrics database
rm /Volumes/AI_SSD/ai-local/data/metrics/metrics.db
# Service will recreate on next start
```

---

## Quick Commands

```bash
# Start AI service
cd /Volumes/AI_SSD/ai-local/luddo-ai-service && npm run dev

# Check service health
curl http://localhost:3010/api/health

# Run quick simulation (1 game)
curl -X POST http://localhost:3010/api/simulation/start \
  -H "X-API-Key: luddo-ai-2025-secret-key" \
  -H "Content-Type: application/json" \
  -d '{"batchSize": 1, "speed": "fast"}'

# View metrics
curl http://localhost:3010/api/metrics/overview \
  -H "X-API-Key: luddo-ai-2025-secret-key"

# List tips
curl http://localhost:3010/api/tips \
  -H "X-API-Key: luddo-ai-2025-secret-key"
```

---

## Files Modified in Luddo Game

1. **`src/services/AIService.ts`** (NEW)
   - Client for AI service API
   - Fallback heuristics if service unavailable

2. **`src/screens/AIPlayPage.tsx`** (MODIFIED)
   - Added Spectator Mode toggle
   - All 4 AI players supported
   - Purple "WATCH AI BATTLE" button

3. **`index.tsx`** (MODIFIED)
   - `handleAIMovePhase` now calls AI service
   - Logs AI decisions in dev mode

4. **`.env.example`** (MODIFIED)
   - Added AI service config variables

---

## Performance Notes

- **Simulation Speed**: ~1 move/second with llama3.2:3b
- **Game Duration**: 300-500 turns typical
- **Batch of 10 games**: ~30-60 minutes
- **Storage**: ~50KB per game transcript

---

## Security

- API key required for all endpoints (except health)
- Default key: `luddo-ai-2025-secret-key`
- Change in production via config file
- CORS allows all origins (for iOS app)
