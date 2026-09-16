#!/usr/bin/env node

import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { migrateProject } from './project';

export interface CliOptions {
  rootDir: string;
  include: string[];
  apply: boolean;
  strict: boolean;
  json: boolean;
  version: boolean;
}

export function runCli(
  args: string[] = process.argv.slice(2),
  workingDirectory = process.cwd(),
): number {
  const options = parseArgs(args, workingDirectory);
  if (options.version) {
    console.info(readPackageVersion());
    return 0;
  }

  const result = migrateProject(options);

  if (options.json) {
    console.info(JSON.stringify(result, null, 2));
  } else {
    console.info(`Scanned ${result.filesScanned} TypeScript files.`);
    console.info(`Found ${result.actions.length} action definitions.`);
    console.info(`Changed ${result.filesChanged.length} files.`);
    console.info(
      result.applied ? 'Applied changes.' : 'Dry run; no files written.',
    );

    for (const diagnostic of result.diagnostics) {
      console.info(
        `[${diagnostic.code}] ${diagnostic.filePath}${
          diagnostic.action ? `:${diagnostic.action}` : ''
        } ${diagnostic.message}`,
      );
    }
    for (const stale of result.staleReferences) {
      console.info(`[stale-reference] ${stale.filePath}`);
    }
  }

  return options.strict &&
    (result.diagnostics.length || result.staleReferences.length)
    ? 1
    : 0;
}

export function parseArgs(
  args: string[],
  workingDirectory = process.cwd(),
): CliOptions {
  const options: CliOptions = {
    rootDir: resolve(workingDirectory, 'src/app'),
    include: [],
    apply: false,
    strict: false,
    json: false,
    version: false,
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === '--root' && args[index + 1]) {
      options.rootDir = resolve(workingDirectory, args[++index]);
    } else if (arg === '--path' && args[index + 1]) {
      options.include.push(args[++index]);
    } else if (arg === '--apply') {
      options.apply = true;
    } else if (arg === '--strict') {
      options.strict = true;
    } else if (arg === '--json') {
      options.json = true;
    } else if (arg === '--version' || arg === '-v') {
      options.version = true;
    }
  }

  return options;
}

function readPackageVersion(): string {
  const packagePaths = [
    resolve(__dirname, 'package.json'),
    resolve(__dirname, '..', 'package.json'),
  ];
  const packagePath = packagePaths.find((path) => existsSync(path));
  if (!packagePath) {
    throw new Error('Unable to locate the ngrx-migration-kit package.json.');
  }

  const packageJson: unknown = JSON.parse(readFileSync(packagePath, 'utf8'));
  if (
    typeof packageJson !== 'object' ||
    packageJson === null ||
    !('version' in packageJson) ||
    typeof packageJson.version !== 'string'
  ) {
    throw new Error(`Invalid package metadata in ${packagePath}.`);
  }
  return packageJson.version;
}

if (require.main === module) {
  process.exitCode = runCli();
}
