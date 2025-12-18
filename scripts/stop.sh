#!/bin/bash
# ========================================
# Luddo AI Service - Stop Script
# ========================================

LOG_DIR="/Volumes/AI_SSD/ai-local/logs"
PID_FILE="$LOG_DIR/luddo-ai-service.pid"

if [ ! -f "$PID_FILE" ]; then
    echo "Luddo AI Service is not running (no PID file)"
    exit 0
fi

PID=$(cat "$PID_FILE")

if ! ps -p "$PID" > /dev/null 2>&1; then
    echo "Luddo AI Service is not running (stale PID file)"
    rm "$PID_FILE"
    exit 0
fi

echo "Stopping Luddo AI Service (PID: $PID)..."
kill "$PID"

# Wait for process to terminate
for i in {1..10}; do
    if ! ps -p "$PID" > /dev/null 2>&1; then
        echo "Service stopped"
        rm "$PID_FILE"
        exit 0
    fi
    sleep 1
done

# Force kill if still running
echo "Force killing service..."
kill -9 "$PID" 2>/dev/null
rm "$PID_FILE"
echo "Service stopped"
