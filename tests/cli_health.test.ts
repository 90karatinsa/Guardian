import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const execFileAsync = promisify(execFile);

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const projectRoot = path.resolve(__dirname, '..');

describe('GuardianCliHealthcheck', () => {
  it('returns JSON payload for --health', async () => {
    const cliPath = path.resolve(projectRoot, 'src/cli.ts');

    const { stdout } = await execFileAsync('pnpm', ['exec', 'tsx', cliPath, '--health'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        NODE_ENV: 'test'
      }
    });

    const payload = JSON.parse(stdout.trim());

    expect(payload.status).toBe('ok');
    expect(payload.state).toBeTypeOf('string');
    expect(payload.metrics).toBeDefined();
    expect(payload.application.name).toBe('guardian');
    expect(Array.isArray(payload.checks)).toBe(true);
    expect(payload.checks[0]).toHaveProperty('name');
  });
});
