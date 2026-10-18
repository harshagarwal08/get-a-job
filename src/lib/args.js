import { parseArgs } from 'node:util';

// Thin wrapper over node:util parseArgs. `options` uses parseArgs option syntax.
export function parse(argv, options = {}, { allowPositionals = true } = {}) {
  const { values, positionals } = parseArgs({
    args: argv, options: { json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, ...options },
    allowPositionals, strict: true,
  });
  return { ...values, _: positionals };
}

export function out(data, asJson, human) {
  if (asJson) process.stdout.write(JSON.stringify(data, null, 2) + '\n');
  else process.stdout.write((typeof human === 'function' ? human(data) : String(human ?? JSON.stringify(data, null, 2))) + '\n');
}

export function fail(msg) {
  process.stderr.write(`error: ${msg}\n`);
  process.exit(1);
}
