#!/bin/bash
# ========================================
# Luddo AI Service - Status Script
# ========================================

LOG_DIR="/Volumes/AI_SSD/ai-local/logs"
PID_FILE="$LOG_DIR/luddo-ai-service.pid"
SERVICE_URL="http://localhost:3010"

echo "========================================="
echo "    LUDDO AI SERVICE STATUS"
echo "========================================="

# Check PID file
if [ -f "$PID_FILE" ]; then
    PID=$(cat "$PID_FILE")
    if ps -p "$PID" > /dev/null 2>&1; then
        echo "Process:     Running (PID: $PID)"
    else
        echo "Process:     Not running (stale PID file)"
    fi
else
    echo "Process:     Not running (no PID file)"
fi

# Check if port is in use
if lsof -i :3010 > /dev/null 2>&1; then
    echo "Port 3010:   In use"
else
    echo "Port 3010:   Available"
fi

# Check health endpoint
echo ""
echo "Health Check:"
HEALTH=$(curl -s "$SERVICE_URL/api/health" 2>/dev/null)
if [ $? -eq 0 ] && [ -n "$HEALTH" ]; then
    echo "$HEALTH" | jq . 2>/dev/null || echo "$HEALTH"
else
    echo "  Could not reach service at $SERVICE_URL"
fi

# Check launchd status
echo ""
echo "Launchd Service:"
if launchctl list | grep -q "com.luddo.ai-service"; then
    echo "  Status: Loaded"
else
    echo "  Status: Not loaded"
fi

echo ""
echo "Log Files:"
echo "  Output: $LOG_DIR/luddo-ai-service.log"
echo "  Error:  $LOG_DIR/luddo-ai-service.error.log"
echo ""
