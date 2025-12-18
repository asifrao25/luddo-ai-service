#!/bin/bash
# ========================================
# Luddo AI Service - Start Script
# ========================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_DIR="$(dirname "$SCRIPT_DIR")"
LOG_DIR="/Volumes/AI_SSD/ai-local/logs"
PID_FILE="$LOG_DIR/luddo-ai-service.pid"

# Ensure log directory exists
mkdir -p "$LOG_DIR"

# Check if already running
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Luddo AI Service is already running (PID: $PID)"
        exit 1
    else
        echo "Removing stale PID file..."
        rm "$PID_FILE"
    fi
fi

cd "$PROJECT_DIR"

# Install dependencies if needed
if [ ! -d "node_modules" ]; then
    echo "Installing dependencies..."
    npm install
fi

# Start the service
echo "Starting Luddo AI Service..."
echo "Logs: $LOG_DIR/luddo-ai-service.log"

# Run in foreground for debugging
if [ "$1" = "--foreground" ] || [ "$1" = "-f" ]; then
    npm run dev
else
    # Run as daemon
    nohup npm run dev > "$LOG_DIR/luddo-ai-service.log" 2>&1 &
    PID=$!
    echo "$PID" > "$PID_FILE"
    echo "Luddo AI Service started (PID: $PID)"
    echo "Check logs: tail -f $LOG_DIR/luddo-ai-service.log"
fi
