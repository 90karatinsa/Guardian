import { describe, it, expect, beforeEach, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildHealthPayloadMock: vi.fn(),
  buildReadinessPayloadMock: vi.fn(),
  resolveHealthExitCodeMock: vi.fn()
}));

vi.mock('../src/cli.js', () => ({
  buildHealthPayload: mocks.buildHealthPayloadMock,
  buildReadinessPayload: mocks.buildReadinessPayloadMock,
  resolveHealthExitCode: mocks.resolveHealthExitCodeMock
}));

import { runHealthcheck } from '../scripts/healthcheck.ts';

function createIo() {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return {
    streams: {
      stdout: {
        write(chunk: string | Uint8Array) {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          stdout.push(text);
          return true;
        }
      },
      stderr: {
        write(chunk: string | Uint8Array) {
          const text = typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
          stderr.push(text);
          return true;
        }
      }
    },
    stdout,
    stderr
  };
}

describe('HealthcheckCli', () => {
  beforeEach(() => {
    mocks.buildHealthPayloadMock.mockReset();
    mocks.buildReadinessPayloadMock.mockReset();
    mocks.resolveHealthExitCodeMock.mockReset();
  });

  it('HealthcheckReadyExitCodes', async () => {
    const first = createIo();
    mocks.buildHealthPayloadMock.mockResolvedValueOnce({ status: 'ok' });
    mocks.buildReadinessPayloadMock.mockReturnValueOnce({ ready: false, reason: 'db' });

    const notReadyExit = await runHealthcheck(['--ready', '--pretty'], first.streams);
    expect(notReadyExit).toBe(1);
    expect(first.stdout.join('')).toBe(`${JSON.stringify({ ready: false, reason: 'db' }, null, 2)}\n`);
    expect(first.stderr).toHaveLength(0);
    expect(mocks.buildHealthPayloadMock).toHaveBeenCalledTimes(1);
    expect(mocks.buildReadinessPayloadMock).toHaveBeenCalledWith({ status: 'ok' });

    const second = createIo();
    mocks.buildHealthPayloadMock.mockResolvedValueOnce({ status: 'ok' });
    mocks.buildReadinessPayloadMock.mockReturnValueOnce({ ready: true });

    const readyExit = await runHealthcheck(['--ready'], second.streams);
    expect(readyExit).toBe(0);
    expect(second.stdout.join('')).toBe(`${JSON.stringify({ ready: true })}\n`);

    const third = createIo();
    const invalidExit = await runHealthcheck(['--bogus'], third.streams);
    expect(invalidExit).toBe(1);
    expect(third.stderr.join('')).toContain('Unknown option: --bogus');
    expect(third.stdout.join('')).toContain('Guardian healthcheck helper');
    expect(mocks.buildHealthPayloadMock).toHaveBeenCalledTimes(2);
  });
});
