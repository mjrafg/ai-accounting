/**
 * Owner-controlled runtime settings.
 *
 * The web toggle for automatic production deployment lives here — persisted
 * outside git, written atomically, read at DECISION TIME by the orchestrator so
 * a change takes effect immediately with no daemon-reload and no restart.
 *
 * AI_V2_HOLD_DEPLOY stays as the boot/compatibility DEFAULT only: it seeds the
 * value when no persisted owner setting exists. Once the owner has touched the
 * toggle, the persisted setting wins — including across restarts and reboots.
 *
 * This is deliberately NOT a generic settings/env editor. It knows exactly one
 * setting; the browser cannot write arbitrary keys through it.
 */
import * as fs from 'fs';
import * as path from 'path';
import { STATE_ROOT } from './store';

export interface DeploymentSettings {
  automaticProductionDeployment: boolean;
  /** Where the current value came from — for the diagnostics line in the UI. */
  source: 'persisted' | 'env-default';
  updatedAt?: string;
  updatedBy?: string;
}

const FILE = () => path.join(STATE_ROOT, 'settings.json');

function envDefault(): boolean {
  // HOLD=1 → automatic deployment OFF. HOLD=0/unset → ON.
  return process.env.AI_V2_HOLD_DEPLOY !== '1';
}

function readFileSettings(): Record<string, unknown> | null {
  try { return JSON.parse(fs.readFileSync(FILE(), 'utf8')); } catch { return null; }
}

export function getDeploymentSettings(): DeploymentSettings {
  const f = readFileSettings();
  if (f && typeof f.automaticProductionDeployment === 'boolean') {
    return {
      automaticProductionDeployment: f.automaticProductionDeployment,
      source: 'persisted',
      updatedAt: typeof f.updatedAt === 'string' ? f.updatedAt : undefined,
      updatedBy: typeof f.updatedBy === 'string' ? f.updatedBy : undefined,
    };
  }
  return { automaticProductionDeployment: envDefault(), source: 'env-default' };
}

/** The single question the orchestrator asks before every automatic deploy. */
export function automaticDeploymentEnabled(): boolean {
  return getDeploymentSettings().automaticProductionDeployment;
}

/** Atomic persist (tmp + rename). Returns the previous and new values. */
export function setAutomaticDeployment(value: boolean, by: string):
  { from: boolean; to: boolean } {
  const before = getDeploymentSettings().automaticProductionDeployment;
  const existing = readFileSettings() ?? {};
  const next = {
    ...existing,
    automaticProductionDeployment: value,
    updatedAt: new Date().toISOString(),
    updatedBy: by,
  };
  fs.mkdirSync(path.dirname(FILE()), { recursive: true });
  const tmp = `${FILE()}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(next, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, FILE());
  return { from: before, to: value };
}
