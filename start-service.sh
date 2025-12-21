#!/bin/bash
# Luddo AI Service Startup Script

# Wait for SSD to be mounted (max 60 seconds)
for i in {1..60}; do
    if [ -d "/Volumes/AI_SSD/ai-local/luddo-ai-service" ]; then
        break
    fi
    sleep 1
done

if [ ! -d "/Volumes/AI_SSD/ai-local/luddo-ai-service" ]; then
    echo "ERROR: SSD not mounted after 60 seconds" >&2
    exit 1
fi

cd /Volumes/AI_SSD/ai-local/luddo-ai-service
export NODE_ENV=production
export PATH=/opt/homebrew/bin:$PATH

exec /opt/homebrew/bin/node dist/index.js
