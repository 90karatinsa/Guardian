import process from 'node:process';
import { buildHealthPayload, buildReadinessPayload, resolveHealthExitCode } from '../src/cli.js';

function printUsage() {
  process.stdout.write(
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
      '  -h, --help     Show this help message'
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

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help) {
    if (args.errors.length > 0) {
      args.errors.forEach(error => {
        process.stderr.write(`${error}\n`);
      });
      process.exitCode = 1;
      return;
    }
    printUsage();
    return;
  }

  if (args.errors.length > 0) {
    args.errors.forEach(error => {
      process.stderr.write(`${error}\n`);
    });
    printUsage();
    process.exitCode = 1;
    return;
  }

  const health = await buildHealthPayload();
  if (args.mode === 'ready') {
    const readiness = buildReadinessPayload(health);
    const output = args.pretty ? JSON.stringify(readiness, null, 2) : JSON.stringify(readiness);
    process.stdout.write(`${output}\n`);
    process.exitCode = readiness.ready ? 0 : 1;
    return;
  }

  const output = args.pretty ? JSON.stringify(health, null, 2) : JSON.stringify(health);
  process.stdout.write(`${output}\n`);
  process.exitCode = resolveHealthExitCode(health.status);
}

main().catch(error => {
  process.stderr.write(`Healthcheck failed: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
