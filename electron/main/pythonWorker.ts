import { spawn } from 'node:child_process';
import { app } from 'electron';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import type { PhotoAnalysis } from '../shared/types';

function pythonBin(): string {
  const root = app.getAppPath();
  const local = join(root, '.venv', 'bin', 'python');
  return existsSync(local) ? local : 'python3';
}

function workerPath(): string {
  const root = app.getAppPath();
  return join(root, 'python', 'worker.py');
}

async function runWorker<T>(args: string[]): Promise<T> {
  return new Promise((resolve, reject) => {
    const child = spawn(pythonBin(), [workerPath(), ...args], {
      cwd: app.getAppPath(),
      stdio: ['ignore', 'pipe', 'pipe']
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });
    child.on('error', reject);
    child.on('close', (code) => {
      const line = stdout.trim().split('\n').at(-1);
      if (!line) {
        reject(new Error(stderr || `Python worker exited with code ${code}`));
        return;
      }
      try {
        const payload = JSON.parse(line);
        if (!payload.ok) {
          reject(new Error(payload.error || stderr || 'Python worker failed'));
          return;
        }
        resolve(payload.result as T);
      } catch (error) {
        reject(new Error(`Invalid Python worker output: ${String(error)} ${stderr}`));
      }
    });
  });
}

export async function makePythonPreview(input: string, preview: string, thumb: string): Promise<{
  width: number;
  height: number;
}> {
  return runWorker([
    'preview',
    '--input',
    input,
    '--preview',
    preview,
    '--thumb',
    thumb,
    '--preview-side',
    '1800',
    '--thumb-side',
    '360'
  ]);
}

export async function analyzeWithPython(input: string): Promise<Omit<PhotoAnalysis, 'photoId'>> {
  return runWorker(['analyze', '--input', input]);
}

export function pythonSetupHint(): string {
  return 'Python AI worker dependencies are missing. Run: python3 -m venv .venv && .venv/bin/pip install -r python/requirements.txt';
}
