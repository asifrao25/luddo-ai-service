#!/bin/bash
# Activate Luddo AI Expert Model
# Creates an enhanced model using base llama3.2:3b with training-informed prompts

set -e

MODEL_NAME="luddo-expert"
MODELFILE_PATH="/Volumes/AI_SSD/ai-local/data/training/modelfiles/luddo-expert.modelfile"
OLLAMA_MODELS="/Volumes/AI_SSD/ai-local/ollama/models"
SERVICE_DIR="/Volumes/AI_SSD/ai-local/luddo-ai-service"
CONFIG_FILE="/Volumes/AI_SSD/ai-local/data/config/service-config.json"

echo "=== Activating Luddo AI Expert Model ==="

# Check modelfile exists
if [ ! -f "$MODELFILE_PATH" ]; then
    echo "ERROR: Modelfile not found at $MODELFILE_PATH"
    exit 1
fi

# Ensure base model is available
echo "1. Ensuring base model llama3.2:3b is available..."
OLLAMA_MODELS="$OLLAMA_MODELS" /opt/homebrew/bin/ollama pull llama3.2:3b 2>/dev/null || true

# Create the expert model
echo "2. Creating luddo-expert model..."
OLLAMA_MODELS="$OLLAMA_MODELS" /opt/homebrew/bin/ollama create "$MODEL_NAME" -f "$MODELFILE_PATH"

echo "3. Verifying model..."
OLLAMA_MODELS="$OLLAMA_MODELS" /opt/homebrew/bin/ollama list | grep -i luddo

# Update config to use new model
echo "4. Updating service config..."
if [ -f "$CONFIG_FILE" ]; then
    # Use sed to update the defaultModel - macOS compatible
    sed -i '' 's/"defaultModel": "[^"]*"/"defaultModel": "luddo-expert"/' "$CONFIG_FILE"
    echo "   Config updated: defaultModel = luddo-expert"
fi

# Rebuild AI service
echo "5. Rebuilding AI service..."
cd "$SERVICE_DIR"
npm run build

# Restart AI service
echo "6. Restarting AI service..."
launchctl unload ~/Library/LaunchAgents/com.luddo.ai-service.plist 2>/dev/null || true
sleep 2
launchctl load ~/Library/LaunchAgents/com.luddo.ai-service.plist

echo "7. Waiting for service to start..."
sleep 3

# Verify service is running
if lsof -i :3010 > /dev/null 2>&1; then
    echo ""
    echo "=== SUCCESS ==="
    echo "Model '$MODEL_NAME' is now active!"
    echo "AI Service running on port 3010"
    echo ""
    echo "The model uses llama3.2:3b with enhanced strategic prompts"
    echo "based on analysis of your training simulations."
else
    echo ""
    echo "=== WARNING ==="
    echo "Service may not have started. Check: launchctl list | grep luddo"
fi
