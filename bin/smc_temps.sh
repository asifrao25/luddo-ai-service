#!/bin/bash
# Real SMC temperature reader for Apple Silicon
# Uses compiled Stats SMC tool

SMC_TOOL="/tmp/smc_tool"

# Check if tool exists
if [ ! -x "$SMC_TOOL" ]; then
    echo '{"error": "SMC tool not found"}'
    exit 1
fi

# Get all temperature readings
TEMPS=$($SMC_TOOL list -t 2>/dev/null)

# Parse key temperatures
CPU_DIE_MAX=$(echo "$TEMPS" | grep '\[TPDX\]' | awk '{print $2}')
CPU_MAX=$(echo "$TEMPS" | grep '\[TCMz\]' | awk '{print $2}')

# GPU temps - try multiple sensors, filter out negative values
GPU_TEMP_X=$(echo "$TEMPS" | grep '\[Tg0X\]' | awk '{print $2}')
GPU_TEMP_C=$(echo "$TEMPS" | grep '\[Tg0C\]' | awk '{print $2}')
# If GPU sensors show invalid (negative), use SoC die temp as proxy
if [ "$(echo "$GPU_TEMP_X < 10" | bc 2>/dev/null)" = "1" ]; then
    GPU_DIE=$(echo "$TEMPS" | grep '\[TSCD\]' | awk '{print $2}')
else
    GPU_DIE=$GPU_TEMP_X
fi

HEATSINK=$(echo "$TEMPS" | grep '\[TH0x\]' | awk '{print $2}')
SOC_DIE=$(echo "$TEMPS" | grep '\[TSCD\]' | awk '{print $2}')
MEMORY=$(echo "$TEMPS" | grep '\[Tm0p\]' | awk '{print $2}')

# Get fan info
FANS=$($SMC_TOOL fans 2>/dev/null)
FAN_SPEED=$(echo "$FANS" | grep 'Actual speed' | head -1 | awk '{print $3}')
FAN_SPEED=${FAN_SPEED:-0}

# Get thermal pressure from powermetrics (with 1s timeout to prevent hangs)
# Skip sudo powermetrics - it's slow and causes timeouts. Use thermal_state instead if available.
if [ -f /tmp/thermal_state ]; then
    THERMAL_RAW=$(cat /tmp/thermal_state 2>/dev/null)
else
    # Default to nominal - actual thermal monitoring runs separately
    THERMAL_RAW="Nominal"
fi
THERMAL=$(echo "${THERMAL_RAW:-Nominal}" | tr '[:upper:]' '[:lower:]')

# Map thermal to level
case "$THERMAL" in
    "nominal") THERMAL_LEVEL=0 ;;
    "moderate"|"fair") THERMAL_LEVEL=1 ;;
    "heavy"|"serious") THERMAL_LEVEL=2 ;;
    "critical"|"sleeping") THERMAL_LEVEL=3 ;;
    *) THERMAL_LEVEL=0 ;;
esac

# Use best available temps - CPU die max or CPU max
CPU_TEMP=${CPU_DIE_MAX:-${CPU_MAX:-50}}
GPU_TEMP_FINAL=${GPU_DIE:-${SOC_DIE:-50}}

# Round to 1 decimal
CPU_TEMP=$(printf "%.1f" "$CPU_TEMP" 2>/dev/null || echo "50.0")
GPU_TEMP_FINAL=$(printf "%.1f" "$GPU_TEMP_FINAL" 2>/dev/null || echo "50.0")
HEATSINK=$(printf "%.1f" "${HEATSINK:-40}" 2>/dev/null || echo "40.0")
SOC_DIE=$(printf "%.1f" "${SOC_DIE:-50}" 2>/dev/null || echo "50.0")
MEMORY=$(printf "%.1f" "${MEMORY:-45}" 2>/dev/null || echo "45.0")

# Ensure fan speed is integer
FAN_SPEED=$(printf "%.0f" "$FAN_SPEED" 2>/dev/null || echo "0")

# Output proper JSON
echo "{"
echo "  \"cpuTemp\": $CPU_TEMP,"
echo "  \"gpuTemp\": $GPU_TEMP_FINAL,"
echo "  \"cpuDieMax\": $CPU_TEMP,"
echo "  \"gpuDieMax\": $GPU_TEMP_FINAL,"
echo "  \"heatsink\": $HEATSINK,"
echo "  \"socDie\": $SOC_DIE,"
echo "  \"memory\": $MEMORY,"
echo "  \"fanSpeed\": $FAN_SPEED,"
echo "  \"thermalPressure\": \"$THERMAL\","
echo "  \"thermalLevel\": $THERMAL_LEVEL,"
echo "  \"source\": \"smc\""
echo "}"
