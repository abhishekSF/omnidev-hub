import fs from 'node:fs';
import path from 'node:path';
import { RepositoryRegistry } from './repos/registry.js';
import { resolveDataDir } from './auth/token.js';

function usage(): void {
  console.error(`Usage:
  npx tsx src/cli.ts repo add <path>
  npx tsx src/cli.ts repo list
  npx tsx src/cli.ts repo remove <path>`);
  process.exit(1);
}

const [, , command, subcommand, target] = process.argv;
const dataDir = resolveDataDir();
RepositoryRegistry.setPersistFile(path.join(dataDir, 'repos.json'));
RepositoryRegistry.loadFromEnv();

if (command !== 'repo') {
  usage();
}

if (subcommand === 'add') {
  if (!target) usage();
  const resolved = path.resolve(target);
  if (!fs.existsSync(resolved)) {
    console.error(`Path does not exist: ${resolved}`);
    process.exit(1);
  }
  if (!RepositoryRegistry.register(resolved)) {
    console.error(`Failed to register repository: ${resolved}`);
    process.exit(1);
  }
  console.log(`Registered ${fs.realpathSync(resolved)}`);
  process.exit(0);
}

if (subcommand === 'remove') {
  if (!target) usage();
  RepositoryRegistry.unregister(target);
  console.log(`Removed ${target}`);
  process.exit(0);
}

if (subcommand === 'list') {
  const repos = RepositoryRegistry.getAllowedRepositories();
  if (repos.length === 0) {
    console.log('No repositories registered. Use: npx tsx src/cli.ts repo add <path>');
    process.exit(0);
  }
  for (const repo of repos) {
    console.log(repo);
  }
  process.exit(0);
}

usage();
