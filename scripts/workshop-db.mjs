#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const action = process.argv[2];
const database = process.argv[3];
const allowed = /^auction_part_[1-8]$/;

if (!allowed.test(database ?? '')) {
  console.error('Expected a workshop database name from auction_part_1 through auction_part_8.');
  process.exit(1);
}

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const composeFile = path.join(repoRoot, 'docker-compose.yml');

function compose(args) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    stdio: 'inherit',
    shell: false,
  });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

function composeCapture(args) {
  const result = spawnSync('docker', ['compose', '-f', composeFile, ...args], {
    encoding: 'utf8',
    shell: false,
  });
  if (result.status !== 0) {
    if (result.stderr) process.stderr.write(result.stderr);
    process.exit(result.status ?? 1);
  }
  return result.stdout ?? '';
}

function ensurePostgres() {
  compose(['up', '-d', '--wait', 'postgres']);
}

if (action === 'up') {
  ensurePostgres();
  const exists = composeCapture([
    'exec',
    '-T',
    'postgres',
    'psql',
    '-U',
    'auction',
    '-d',
    'postgres',
    '-tAc',
    `SELECT 1 FROM pg_database WHERE datname = '${database}'`,
  ]).trim();
  if (exists !== '1') {
    compose(['exec', '-T', 'postgres', 'createdb', '-U', 'auction', database]);
  }
} else if (action === 'drop') {
  ensurePostgres();
  compose(['exec', '-T', 'postgres', 'dropdb', '-U', 'auction', '--if-exists', '--force', database]);
} else {
  console.error('Usage: node workshop-db.mjs {up|drop} auction_part_N');
  process.exit(1);
}
