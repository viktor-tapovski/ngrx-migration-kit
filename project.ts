import { readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import {
  ActionMetadata,
  discoverFunctionalActions,
  migrateActionSource,
  MigrationDiagnostic,
  rewriteReducerSource,
  rewriteConsumerSource,
  scanSource,
} from './migrator';

export interface ProjectMigrationOptions {
  rootDir: string;
  include?: string[];
  apply?: boolean;
  strict?: boolean;
}

export interface ProjectMigrationResult {
  filesScanned: number;
  filesChanged: string[];
  actions: ActionMetadata[];
  diagnostics: MigrationDiagnostic[];
  staleReferences: Array<{
    filePath: string;
    classes: string[];
    constructorCalls: string[];
    genericOfType: string[];
  }>;
  applied: boolean;
}

export function migrateProject(
  options: ProjectMigrationOptions,
): ProjectMigrationResult {
  const allFiles = collectTypeScriptFiles(options.rootDir);
  const actionFiles = allFiles.filter((filePath) =>
    matchesInclude(filePath, options.rootDir, options.include),
  );
  const sourceByFile = new Map(
    allFiles.map((filePath) => [filePath, readFileSync(filePath, 'utf8')]),
  );
  const migratedSources = new Map<string, string>();
  const actions: ActionMetadata[] = [];
  const diagnostics: MigrationDiagnostic[] = [];

  for (const filePath of actionFiles) {
    const source = sourceByFile.get(filePath);
    if (source === undefined) {
      continue;
    }
    const result = migrateActionSource(source, filePath);
    const functionalActions = discoverFunctionalActions(source, filePath);
    const migratedActionTypes = new Set(
      result.actions.map((action) => action.typeExpression),
    );
    const discoveredActions = functionalActions.filter(
      (action) => !migratedActionTypes.has(action.typeExpression),
    );
    const allActions = [...result.actions, ...discoveredActions];
    if (!allActions.length) {
      continue;
    }
    migratedSources.set(filePath, result.source);
    actions.push(...allActions);
    diagnostics.push(...result.diagnostics);
  }

  const actionClassNames = new Set(actions.map((action) => action.className));
  const proposedByFile = new Map<string, string>();
  const filesChanged: string[] = [];

  for (const [filePath, source] of sourceByFile) {
    const migratedSource = migratedSources.get(filePath) ?? source;
    const reducerResult = rewriteReducerSource(
      migratedSource,
      filePath,
      actions,
    );
    diagnostics.push(...reducerResult.diagnostics);
    const proposedSource = rewriteConsumerSource(
      reducerResult.source,
      filePath,
      actions,
    );
    proposedByFile.set(filePath, proposedSource);
    if (proposedSource !== source) {
      filesChanged.push(relative(options.rootDir, filePath));
    }
  }

  const staleReferences = [];
  for (const [filePath, source] of proposedByFile) {
    const scan = scanSource(source, filePath);
    const staleClasses = scan.classes.filter((name) =>
      actionClassNames.has(name),
    );
    const staleConstructors = scan.constructorCalls.filter((name) =>
      actionClassNames.has(name),
    );
    const staleOfType = scan.genericOfType.filter((name) =>
      actionClassNames.has(name),
    );
    if (staleClasses.length || staleConstructors.length || staleOfType.length) {
      staleReferences.push({
        filePath: relative(options.rootDir, filePath),
        classes: staleClasses,
        constructorCalls: staleConstructors,
        genericOfType: staleOfType,
      });
    }
  }

  const blockingDiagnostics = diagnostics.filter(
    ({ code }) =>
      code === 'unsupported-action' ||
      code === 'missing-action-type' ||
      code === 'missing-action-import' ||
      code === 'unsupported-reducer' ||
      code === 'unmapped-reducer-action' ||
      code === 'missing-reducer-action-import',
  );
  const canApply =
    options.apply &&
    (!options.strict ||
      (!blockingDiagnostics.length && !staleReferences.length));

  if (canApply) {
    for (const [filePath, source] of proposedByFile) {
      if (source !== sourceByFile.get(filePath)) {
        writeFileSync(filePath, source);
      }
    }
  }

  return {
    filesScanned: allFiles.length,
    filesChanged,
    actions,
    diagnostics,
    staleReferences,
    applied: !!canApply,
  };
}

function collectTypeScriptFiles(rootDir: string): string[] {
  const files: string[] = [];
  const entries = readdirSync(rootDir, { withFileTypes: true });

  for (const entry of entries) {
    if (['node_modules', 'dist', '.angular'].includes(entry.name)) {
      continue;
    }
    const filePath = join(rootDir, entry.name);
    if (entry.isDirectory()) {
      files.push(...collectTypeScriptFiles(filePath));
    } else if (entry.isFile() && filePath.endsWith('.ts')) {
      files.push(filePath);
    }
  }

  return files;
}

function matchesInclude(
  filePath: string,
  rootDir: string,
  include: string[] | undefined,
): boolean {
  if (!include?.length) {
    return true;
  }
  const relativePath = relative(rootDir, filePath);
  return include.some(
    (pattern) =>
      relativePath === pattern ||
      relativePath.includes(pattern) ||
      filePath.includes(pattern),
  );
}
