import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

export interface HardwareProfile {
  hostname: string;
  platform: 'darwin' | 'win32' | 'linux';
  arch: string;
  cpuModel: string;
  cpuCores: number;
  totalMemoryGB: number;
  freeMemoryGB: number;
  computeTier: 'HIGH_COMPUTE' | 'AUXILIARY_COMPUTE' | 'EDGE_WORKER';
  powerState: {
    isOnBattery: boolean;
    batteryPercent: number | null;
    isCharging: boolean;
    isLidClosed: boolean;
  };
  safetyFlags: {
    backpackRisk: boolean;
    thermalThrottlingRisk: boolean;
    canAcceptWorkload: boolean;
  };
}

export class HardwareProfiler {
  public static getProfile(): HardwareProfile {
    const platform = os.platform() as 'darwin' | 'win32' | 'linux';
    const cpus = os.cpus();
    const cpuModel = cpus.length > 0 ? cpus[0].model : 'Unknown';
    const totalMemoryGB = Math.round((os.totalmem() / (1024 ** 3)) * 10) / 10;
    const freeMemoryGB = Math.round((os.freemem() / (1024 ** 3)) * 10) / 10;
    const arch = os.arch();

    // Determine power & lid state
    const powerState = this.detectPowerAndLidState(platform);

    // Compute tier assessment
    let computeTier: 'HIGH_COMPUTE' | 'AUXILIARY_COMPUTE' | 'EDGE_WORKER' = 'AUXILIARY_COMPUTE';
    const isAppleSilicon = platform === 'darwin' && arch === 'arm64';
    const isIntelMac = platform === 'darwin' && arch === 'x64';

    if (isAppleSilicon && totalMemoryGB >= 16) {
      computeTier = 'HIGH_COMPUTE';
    } else if (isIntelMac) {
      computeTier = 'AUXILIARY_COMPUTE';
    } else if (totalMemoryGB >= 16) {
      computeTier = 'HIGH_COMPUTE';
    } else {
      computeTier = 'EDGE_WORKER';
    }

    // Safety Interlock: Backpack Risk = Lid Closed + On Battery
    const backpackRisk = powerState.isLidClosed && powerState.isOnBattery;
    const thermalThrottlingRisk = isIntelMac && (cpus.length <= 4 || totalMemoryGB < 16);
    const canAcceptWorkload = !backpackRisk;

    return {
      hostname: os.hostname(),
      platform,
      arch,
      cpuModel,
      cpuCores: cpus.length,
      totalMemoryGB,
      freeMemoryGB,
      computeTier,
      powerState,
      safetyFlags: {
        backpackRisk,
        thermalThrottlingRisk,
        canAcceptWorkload
      }
    };
  }

  private static detectPowerAndLidState(platform: string): HardwareProfile['powerState'] {
    let isOnBattery = false;
    let batteryPercent: number | null = null;
    let isCharging = false;
    let isLidClosed = false;

    if (platform === 'darwin') {
      try {
        const pmsetOutput = execSync('pmset -g batt', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
        isOnBattery = pmsetOutput.includes("Now drawing from 'Battery Power'");
        isCharging = pmsetOutput.includes("charging") || pmsetOutput.includes("AC Power");

        const match = pmsetOutput.match(/(\d+)%/);
        if (match) {
          batteryPercent = parseInt(match[1], 10);
        }

        // Check clamshell (lid closed) state
        try {
          const ioregOutput = execSync('ioreg -r -k AppleClamshellState -d 1', { encoding: 'utf8', timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] });
          isLidClosed = ioregOutput.includes('"AppleClamshellState" = Yes');
        } catch {
          isLidClosed = false;
        }
      } catch {
        // Fallback default
        isOnBattery = false;
        isCharging = true;
      }
    } else if (platform === 'win32') {
      try {
        const wmic = execSync('powershell -Command "Get-CimInstance -ClassName Win32_Battery | Select-Object -Property EstimatedChargeRemaining, BatteryStatus | ConvertTo-Json"', { encoding: 'utf8', timeout: 5000 });
        const data = JSON.parse(wmic);
        batteryPercent = data.EstimatedChargeRemaining;
        isOnBattery = data.BatteryStatus === 1; // 1 = Discharging
        isCharging = data.BatteryStatus === 2; // 2 = AC / Charging
      } catch {
        isOnBattery = false;
      }
    } else if (platform === 'linux') {
      return this.detectLinuxPowerAndLidState();
    }

    return {
      isOnBattery,
      batteryPercent,
      isCharging,
      isLidClosed
    };
  }

  private static detectLinuxPowerAndLidState(): HardwareProfile['powerState'] {
    let isOnBattery = false;
    let batteryPercent: number | null = null;
    let isCharging = false;
    let isLidClosed = false;

    try {
      const psRoot = '/sys/class/power_supply';
      if (fs.existsSync(psRoot)) {
        for (const name of fs.readdirSync(psRoot)) {
          const base = path.join(psRoot, name);
          const typePath = path.join(base, 'type');
          if (!fs.existsSync(typePath)) continue;
          const type = fs.readFileSync(typePath, 'utf8').trim();
          if (type !== 'Battery') continue;
          const statusPath = path.join(base, 'status');
          const capPath = path.join(base, 'capacity');
          if (fs.existsSync(statusPath)) {
            const status = fs.readFileSync(statusPath, 'utf8').trim();
            isOnBattery = status === 'Discharging';
            isCharging = status === 'Charging' || status === 'Full' || status === 'Not charging';
          }
          if (fs.existsSync(capPath)) {
            const cap = parseInt(fs.readFileSync(capPath, 'utf8').trim(), 10);
            if (!Number.isNaN(cap)) batteryPercent = cap;
          }
          break;
        }
      }
    } catch {
      // sysfs unavailable
    }

    try {
      const lidRoot = '/proc/acpi/button/lid';
      if (fs.existsSync(lidRoot)) {
        for (const name of fs.readdirSync(lidRoot)) {
          const stateFile = path.join(lidRoot, name, 'state');
          if (!fs.existsSync(stateFile)) continue;
          const state = fs.readFileSync(stateFile, 'utf8').toLowerCase();
          isLidClosed = state.includes('closed');
          break;
        }
      }
    } catch {
      // ACPI lid class unavailable
    }

    return {
      isOnBattery,
      batteryPercent,
      isCharging,
      isLidClosed
    };
  }
}
