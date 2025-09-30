import path from 'node:path';
import process from 'node:process';
import { buildHealthPayload, buildReadinessPayload, resolveHealthExitCode } from '../src/cli.js';
import { getIntegrationManifest } from '../src/app.js';

type Writable = Pick<NodeJS.WritableStream, 'write'>;

type IoStreams = {
  stdout: Writable;
  stderr: Writable;
};

function printUsage(target: Writable) {
  const manifest = getIntegrationManifest();
  target.write(
    [
      'Guardian healthcheck helper',
      '',
      'Usage:',
      '  pnpm exec tsx scripts/healthcheck.ts [--ready] [--pretty]',
      '',
      'Options:',
      '  --ready        Emit readiness payload instead of full health snapshot',
      '  --health       Force health payload output (default)',
      '  --pretty       Pretty-print JSON output with indentation',
      '  -h, --help     Show this help message',
      '',
      `Docker HEALTHCHECK: ${manifest.docker.healthcheck}`,
      `Docker readiness: ${manifest.docker.readyCommand}`,
      `systemd health command: ${manifest.systemd.healthCommand}`,
      `systemd readiness command: ${manifest.systemd.readyCommand}`
    ].join('\n') + '\n'
  );
}

type Mode = 'health' | 'ready';

type ParsedArgs = {
  mode: Mode;
  pretty: boolean;
  help: boolean;
  errors: string[];
};

function parseArgs(argv: string[]): ParsedArgs {
  const parsed: ParsedArgs = { mode: 'health', pretty: false, help: false, errors: [] };
  for (const token of argv) {
    if (!token) {
      continue;
    }
    switch (token) {
      case '--ready':
      case 'ready':
        parsed.mode = 'ready';
        break;
      case '--health':
      case 'health':
        parsed.mode = 'health';
        break;
      case '--pretty':
      case '-p':
        parsed.pretty = true;
        break;
      case '--help':
      case '-h':
        parsed.help = true;
        break;
      case '--json':
      case '-j':
        // JSON is the only output format, so ignore aliases for compatibility.
        break;
      default:
        parsed.errors.push(`Unknown option: ${token}`);
        break;
    }
  }
  return parsed;
}

export async function runHealthcheck(argv: string[], streams: IoStreams = {
  stdout: process.stdout,
  stderr: process.stderr
}): Promise<number> {
  const args = parseArgs(argv);
  if (args.help) {
    if (args.errors.length > 0) {
      args.errors.forEach(error => {
        streams.stderr.write(`${error}\n`);
      });
      return 1;
    }
    printUsage(streams.stdout);
    return 0;
  }

  if (args.errors.length > 0) {
    args.errors.forEach(error => {
      streams.stderr.write(`${error}\n`);
    });
    printUsage(streams.stdout);
    return 1;
  }

  const health = await buildHealthPayload();
  if (args.mode === 'ready') {
    const readiness = buildReadinessPayload(health);
    const output = args.pretty ? JSON.stringify(readiness, null, 2) : JSON.stringify(readiness);
    streams.stdout.write(`${output}\n`);
    return readiness.ready ? 0 : 1;
  }

  const output = args.pretty ? JSON.stringify(health, null, 2) : JSON.stringify(health);
  streams.stdout.write(`${output}\n`);
  return resolveHealthExitCode(health.status);
}

const scriptName = path.basename(process.argv[1] ?? '');

if (scriptName === 'healthcheck.ts' || scriptName === 'healthcheck.js') {
  runHealthcheck(process.argv.slice(2)).then(code => {
    process.exitCode = code;
  }).catch(error => {
    process.stderr.write(`Healthcheck failed: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
