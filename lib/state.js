import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { statePath } from './paths.js';

export const STATES = ['staged', 'installing', 'installed', 'configured', 'done', 'failed'];

const ALLOWED = {
  idle: ['staged'],
  staged: ['installing', 'failed'],
  installing: ['installed', 'failed'],
  installed: ['configured', 'failed'],
  configured: ['done', 'failed'],
  failed: ['installing', 'idle'],
  done: ['idle'],
};

export function transition(current, next) {
  const from = current || 'idle';
  const allowed = ALLOWED[from] || [];
  if (!allowed.includes(next)) throw new Error('illegal transition: ' + from + ' -> ' + next);
  return next;
}

export function readState(profileDir) {
  const file = statePath(profileDir);
  if (!existsSync(file)) return null;
  try {
    return JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

export function writeState(profileDir, patch) {
  const file = statePath(profileDir);
  const current = readState(profileDir) || { state: 'idle' };
  const next = { ...current, ...patch, updatedAt: new Date().toISOString() };
  if (patch.state) transition(current.state, patch.state);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(next, null, 2));
  return next;
}

export function clearState(profileDir) {
  const file = statePath(profileDir);
  if (existsSync(file)) rmSync(file, { force: true });
}
