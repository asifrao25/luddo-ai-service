#!/bin/bash
# Real metrics from powermetrics

# Get powermetrics data (single sample, 100ms)
DATA=$(sudo /usr/bin/powermetrics -n 1 -i 100 --samplers cpu_power,gpu_power,thermal -f text 2>/dev/null)

# Parse CPU power (mW)
CPU_POWER=$(echo "$DATA" | grep "^CPU Power:" | awk '{print $3}')

# Parse GPU power (mW)
GPU_POWER=$(echo "$DATA" | grep "^GPU Power:" | head -1 | awk '{print $3}')

# Parse GPU active residency (real GPU usage %)
GPU_ACTIVE=$(echo "$DATA" | grep "GPU HW active residency:" | awk '{print $4}' | tr -d '%')

# Parse GPU idle residency
GPU_IDLE=$(echo "$DATA" | grep "GPU idle residency:" | awk '{print $3}' | tr -d '%')

# Parse thermal pressure
THERMAL=$(echo "$DATA" | grep "Current pressure level:" | awk '{print $4}')

# Calculate GPU usage (100 - idle)
if [ -n "$GPU_IDLE" ]; then
    GPU_USAGE=$(echo "100 - $GPU_IDLE" | bc)
else
    GPU_USAGE=${GPU_ACTIVE:-0}
fi

# Estimate temps from power (more accurate than from load)
# M4 Max TDP ~40W CPU, ~50W GPU
CPU_POWER_NUM=${CPU_POWER:-0}
GPU_POWER_NUM=${GPU_POWER:-0}

# Temperature estimation based on power draw
# Base temp ~35C, max around 95-100C at full power
CPU_TEMP=$(echo "scale=1; 35 + ($CPU_POWER_NUM / 40000) * 60" | bc)
GPU_TEMP=$(echo "scale=1; 35 + ($GPU_POWER_NUM / 50000) * 65" | bc)

# Clamp temps to reasonable ranges
CPU_TEMP=$(echo "if($CPU_TEMP > 100) 100 else if($CPU_TEMP < 30) 30 else $CPU_TEMP" | bc)
GPU_TEMP=$(echo "if($GPU_TEMP > 105) 105 else if($GPU_TEMP < 30) 30 else $GPU_TEMP" | bc)

# Map thermal pressure to level
case "$THERMAL" in
    "Nominal") THERMAL_LEVEL=0 ;;
    "Moderate"|"Fair") THERMAL_LEVEL=1 ;;
    "Heavy"|"Serious") THERMAL_LEVEL=2 ;;
    "Critical"|"Sleeping") THERMAL_LEVEL=3 ;;
    *) THERMAL_LEVEL=0 ;;
esac

# Output JSON
echo "{"
echo "  \"cpuPower\": ${CPU_POWER_NUM:-0},"
echo "  \"gpuPower\": ${GPU_POWER_NUM:-0},"
echo "  \"gpuUsage\": ${GPU_USAGE:-0},"
echo "  \"cpuTemp\": ${CPU_TEMP:-35},"
echo "  \"gpuTemp\": ${GPU_TEMP:-35},"
echo "  \"thermalPressure\": \"${THERMAL:-Nominal}\","
echo "  \"thermalLevel\": $THERMAL_LEVEL"
echo "}"
