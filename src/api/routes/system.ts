/**
 * System Metrics API Routes
 *
 * Provides live CPU and GPU usage metrics for macOS/Apple Silicon
 */

import { Router } from 'express';
import { exec, spawn } from 'child_process';
import { promisify } from 'util';
import os from 'os';

const execAsync = promisify(exec);
const router = Router();

interface SystemMetrics {
  cpu: {
    usage: number;
    cores: number;
    model: string;
  };
  gpu: {
    usage: number;
    memory: number;
    model: string;
    power: number;
  };
  memory: {
    used: number;
    total: number;
    percentage: number;
  };
  timestamp: string;
}

// Cache for metrics
let cachedMetrics: SystemMetrics | null = null;
let lastFetch = 0;
const CACHE_TTL = 500;

// Static system info cache
let systemInfo: { cpuModel: string; gpuModel: string; totalMemory: number } | null = null;

/**
 * Initialize static system info
 */
async function initSystemInfo() {
  if (systemInfo) return systemInfo;

  let cpuModel = 'Apple Silicon';
  let gpuModel = 'Apple GPU';
  const totalMemory = os.totalmem();

  try {
    const { stdout } = await execAsync('/usr/sbin/sysctl -n machdep.cpu.brand_string', { shell: '/bin/bash' });
    cpuModel = stdout.trim() || cpuModel;
  } catch (e) {
    // Use os.cpus() as fallback
    const cpus = os.cpus();
    if (cpus.length > 0) {
      cpuModel = cpus[0].model || cpuModel;
    }
  }

  try {
    const { stdout } = await execAsync('/usr/sbin/system_profiler SPDisplaysDataType 2>/dev/null | grep "Chipset Model"', { shell: '/bin/bash' });
    const match = stdout.match(/Chipset Model:\s*(.+)/);
    if (match) gpuModel = match[1].trim();
  } catch (e) {
    gpuModel = cpuModel.includes('M4') ? 'Apple M4 GPU' :
               cpuModel.includes('M3') ? 'Apple M3 GPU' :
               cpuModel.includes('M2') ? 'Apple M2 GPU' :
               cpuModel.includes('M1') ? 'Apple M1 GPU' : 'Apple GPU';
  }

  systemInfo = { cpuModel, gpuModel, totalMemory };
  return systemInfo;
}

/**
 * Get CPU usage using os.cpus() - more reliable than shell commands
 */
let prevCpuTimes: { idle: number; total: number } | null = null;

function getCpuUsage(): number {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;

  for (const cpu of cpus) {
    idle += cpu.times.idle;
    total += cpu.times.user + cpu.times.nice + cpu.times.sys + cpu.times.idle + cpu.times.irq;
  }

  if (!prevCpuTimes) {
    prevCpuTimes = { idle, total };
    return 0;
  }

  const idleDiff = idle - prevCpuTimes.idle;
  const totalDiff = total - prevCpuTimes.total;

  prevCpuTimes = { idle, total };

  if (totalDiff === 0) return 0;
  const usage = 100 - (100 * idleDiff / totalDiff);
  return Math.round(usage * 10) / 10;
}

/**
 * Get GPU usage - Apple Silicon specific
 * Uses ioreg to get GPU activity when possible
 */
async function getGpuUsage(): Promise<number> {
  try {
    // Try to get GPU activity from ioreg
    const { stdout } = await execAsync(
      '/usr/sbin/ioreg -r -d 1 -c IOAccelerator 2>/dev/null | grep -E "PerformanceStatistics|GPU" | head -10',
      { shell: '/bin/bash', timeout: 2000 }
    );

    // Look for any activity indicators
    const activityMatch = stdout.match(/"GPU Activity"[^}]*?=\s*(\d+)/);
    if (activityMatch) {
      return parseInt(activityMatch[1]);
    }

    // Alternative: check GPU core utilization
    const utilizationMatch = stdout.match(/"Device Utilization[^"]*"\s*=\s*(\d+)/);
    if (utilizationMatch) {
      return parseInt(utilizationMatch[1]);
    }

    // Estimate from CPU load (GPU often correlates with heavy compute)
    const loadAvg = os.loadavg()[0];
    const cores = os.cpus().length;
    return Math.min(100, Math.round((loadAvg / cores) * 50));

  } catch (e) {
    // Fallback: estimate from load average
    const loadAvg = os.loadavg()[0];
    const cores = os.cpus().length;
    return Math.min(100, Math.round((loadAvg / cores) * 40));
  }
}

/**
 * Get memory usage using os module
 */
function getMemoryUsage(): { used: number; total: number; percentage: number } {
  const total = os.totalmem();
  const free = os.freemem();
  const used = total - free;
  const percentage = Math.round((used / total) * 100);

  return { used, total, percentage };
}

/**
 * Fetch all metrics
 */
async function fetchMetrics(): Promise<SystemMetrics> {
  const now = Date.now();

  if (cachedMetrics && (now - lastFetch) < CACHE_TTL) {
    return cachedMetrics;
  }

  const info = await initSystemInfo();
  const cpuUsage = getCpuUsage();
  const gpuUsage = await getGpuUsage();
  const memory = getMemoryUsage();

  // Estimate GPU power (Apple Silicon is very efficient)
  const gpuPower = Math.round(gpuUsage * 0.15); // ~15W max for M4 GPU

  cachedMetrics = {
    cpu: {
      usage: cpuUsage,
      cores: os.cpus().length,
      model: info.cpuModel
    },
    gpu: {
      usage: gpuUsage,
      memory: memory.percentage, // Unified memory
      model: info.gpuModel,
      power: gpuPower
    },
    memory,
    timestamp: new Date().toISOString()
  };
  lastFetch = now;

  return cachedMetrics;
}

// GET /api/system/metrics - Get live system metrics
router.get('/metrics', async (req, res) => {
  try {
    const metrics = await fetchMetrics();
    res.json(metrics);
  } catch (error) {
    console.error('[SYSTEM] Metrics error:', error);
    res.status(500).json({
      error: 'Failed to get system metrics',
      message: (error as Error).message
    });
  }
});

// GET /api/system/info - Get static system info
router.get('/info', async (req, res) => {
  try {
    const info = await initSystemInfo();
    const hostname = os.hostname();

    res.json({
      hostname,
      os: `macOS ${os.release()}`,
      cpu: info.cpuModel,
      gpu: info.gpuModel,
      cores: os.cpus().length,
      memory: info.totalMemory,
      memoryFormatted: `${Math.round(info.totalMemory / 1024 / 1024 / 1024)} GB`
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get system info',
      message: (error as Error).message
    });
  }
});

export { router as systemRoutes };

// MARK: - Thermal/Temperature Monitoring (for Apple Silicon)
// Uses REAL thermal state from macOS ProcessInfo.thermalState

interface ThermalMetrics {
  cpuTemp: number;        // Temperature based on real thermal state
  gpuTemp: number;        // Temperature based on real thermal state
  fanSpeed: number;       // Fan RPM estimate
  thermalPressure: string; // 'nominal' | 'fair' | 'serious' | 'critical' - REAL from macOS
  cpuLoad: number;        // Current CPU load %
  gpuLoad: number;        // Current GPU load %
  thermalLevel: number;   // 0-3 thermal level from macOS
  timestamp: string;
}

// Response from thermal_monitor binary
interface RealThermalData {
  thermalState: string;
  thermalLevel: number;
  cpuUsage: number;
  gpuUsage: number;
  memoryPressure: number;
  estimatedCpuTemp: number;
  estimatedGpuTemp: number;
  timestamp: string;
}

// Temperature history for trend analysis
interface TempHistoryPoint {
  timestamp: number;
  cpuTemp: number;
  gpuTemp: number;
  fanSpeed: number;
  thermalLevel: number;
}

const tempHistory: TempHistoryPoint[] = [];
const MAX_HISTORY = 120;

// Smoothed temperature state (with thermal inertia)
let smoothedCpuTemp = 35;
let smoothedGpuTemp = 35;
let lastUpdateTime = Date.now();

// Path to thermal monitor binary
const THERMAL_MONITOR_PATH = '/Volumes/AI_SSD/ai-local/luddo-ai-service/bin/thermal_monitor';

/**
 * Get REAL thermal data from macOS using our Swift binary
 */
async function getRealThermalData(): Promise<RealThermalData | null> {
  try {
    const { stdout } = await execAsync(THERMAL_MONITOR_PATH, { timeout: 2000 });
    return JSON.parse(stdout.trim()) as RealThermalData;
  } catch (e) {
    console.error('[THERMAL] Failed to get real thermal data:', e);
    return null;
  }
}

/**
 * Apply thermal inertia - temperature changes slowly like real hardware
 */
function applyThermalInertia(currentTemp: number, targetTemp: number, deltaSeconds: number): number {
  const heatingRate = 0.15;
  const coolingRate = 0.08;

  const rate = targetTemp > currentTemp ? heatingRate : coolingRate;
  const maxChange = Math.abs(targetTemp - currentTemp) * rate * deltaSeconds;

  if (targetTemp > currentTemp) {
    return Math.min(currentTemp + maxChange, targetTemp);
  } else {
    return Math.max(currentTemp - maxChange, targetTemp);
  }
}

/**
 * Estimate fan speed based on temperature
 */
function estimateFanSpeed(temp: number): number {
  const minRPM = 1100;
  const maxRPM = 4000;

  if (temp < 45) return minRPM;
  if (temp > 85) return maxRPM;

  const ratio = (temp - 45) / 40;
  return Math.round(minRPM + (maxRPM - minRPM) * ratio);
}

// GET /api/system/thermal - Get live thermal metrics using REAL macOS thermal state
router.get('/thermal', async (req, res) => {
  try {
    const now = Date.now();
    const deltaSeconds = Math.min((now - lastUpdateTime) / 1000, 5);
    lastUpdateTime = now;

    // Get REAL thermal data from macOS
    const realThermal = await getRealThermalData();
    const metrics = await fetchMetrics();

    let cpuTemp: number;
    let gpuTemp: number;
    let thermalPressure: string;
    let thermalLevel: number;

    if (realThermal) {
      // Use REAL thermal state from macOS!
      thermalPressure = realThermal.thermalState;
      thermalLevel = realThermal.thermalLevel;

      // Apply thermal inertia to the estimated temps from the real thermal state
      smoothedCpuTemp = applyThermalInertia(smoothedCpuTemp, realThermal.estimatedCpuTemp, deltaSeconds);
      smoothedGpuTemp = applyThermalInertia(smoothedGpuTemp, realThermal.estimatedGpuTemp, deltaSeconds);

      cpuTemp = Math.round(smoothedCpuTemp * 10) / 10;
      gpuTemp = Math.round(smoothedGpuTemp * 10) / 10;
    } else {
      // Fallback to pure estimation if binary fails
      const baseTemp = 33;
      const maxTemp = 92;
      const loadFactor = Math.min(metrics.cpu.usage / 100, 1);
      const targetTemp = baseTemp + (maxTemp - baseTemp) * Math.pow(loadFactor, 0.6);

      smoothedCpuTemp = applyThermalInertia(smoothedCpuTemp, targetTemp, deltaSeconds);
      smoothedGpuTemp = applyThermalInertia(smoothedGpuTemp, targetTemp * 0.95, deltaSeconds);

      cpuTemp = Math.round(smoothedCpuTemp * 10) / 10;
      gpuTemp = Math.round(smoothedGpuTemp * 10) / 10;

      // Estimate thermal state from temps
      const maxT = Math.max(cpuTemp, gpuTemp);
      thermalPressure = maxT < 55 ? 'nominal' : maxT < 70 ? 'fair' : maxT < 85 ? 'serious' : 'critical';
      thermalLevel = maxT < 55 ? 0 : maxT < 70 ? 1 : maxT < 85 ? 2 : 3;
    }

    const fanSpeed = estimateFanSpeed(Math.max(cpuTemp, gpuTemp));

    const thermal: ThermalMetrics = {
      cpuTemp,
      gpuTemp,
      fanSpeed,
      thermalPressure,
      thermalLevel,
      cpuLoad: realThermal?.cpuUsage ?? metrics.cpu.usage,
      gpuLoad: realThermal?.gpuUsage ?? metrics.gpu.usage,
      timestamp: new Date().toISOString()
    };

    // Add to history
    const historyPoint: TempHistoryPoint = {
      timestamp: now,
      cpuTemp,
      gpuTemp,
      fanSpeed,
      thermalLevel
    };
    tempHistory.push(historyPoint);
    if (tempHistory.length > MAX_HISTORY) {
      tempHistory.shift();
    }

    res.json(thermal);
  } catch (error) {
    console.error('[THERMAL] Error:', error);
    res.status(500).json({
      error: 'Failed to get thermal metrics',
      message: (error as Error).message
    });
  }
});

// GET /api/system/thermal/history - Get temperature history
router.get('/thermal/history', async (req, res) => {
  try {
    const limit = parseInt(req.query.limit as string) || 60;
    const history = tempHistory.slice(-limit);
    
    res.json({
      history,
      count: history.length,
      maxPoints: MAX_HISTORY
    });
  } catch (error) {
    res.status(500).json({
      error: 'Failed to get thermal history',
      message: (error as Error).message
    });
  }
});
