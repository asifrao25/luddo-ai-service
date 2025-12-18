#!/bin/bash
# ========================================
# Luddo AI Service - Install LaunchAgent
# ========================================

set -e

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PLIST_SOURCE="$SCRIPT_DIR/com.luddo.ai-service.plist"
PLIST_DEST="$HOME/Library/LaunchAgents/com.luddo.ai-service.plist"
LOG_DIR="/Volumes/AI_SSD/ai-local/logs"

echo "Installing Luddo AI Service LaunchAgent..."

# Create log directory
mkdir -p "$LOG_DIR"

# Unload existing service if present
if launchctl list | grep -q "com.luddo.ai-service"; then
    echo "Unloading existing service..."
    launchctl unload "$PLIST_DEST" 2>/dev/null || true
fi

# Copy plist to LaunchAgents
echo "Copying plist to ~/Library/LaunchAgents/"
cp "$PLIST_SOURCE" "$PLIST_DEST"

# Load the service
echo "Loading service..."
launchctl load "$PLIST_DEST"

# Check if loaded successfully
sleep 2
if launchctl list | grep -q "com.luddo.ai-service"; then
    echo ""
    echo "SUCCESS: Luddo AI Service installed and started!"
    echo ""
    echo "Commands:"
    echo "  Stop:     launchctl unload $PLIST_DEST"
    echo "  Start:    launchctl load $PLIST_DEST"
    echo "  Logs:     tail -f $LOG_DIR/luddo-ai-service.log"
    echo "  Status:   $SCRIPT_DIR/status.sh"
else
    echo "ERROR: Failed to load service"
    exit 1
fi
