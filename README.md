# NGRX migration kit

AST-based CLI for migrating legacy NgRx actions, effects, reducers, and
selectors to functional APIs.

## Install

Install it into a project:

```bash
pnpm add -D @rc-df/ngrx-migration-kit
pnpm exec ngrx-migration-kit \
  --root src/app \
  --path store/actions
```

For a one-off run without adding it to `package.json`:

```bash
pnpm dlx @rc-df/ngrx-migration-kit \
  --root src/app \
  --path store/actions
```

Or install the CLI globally:

```bash
npm install --global @rc-df/ngrx-migration-kit
pnpm add --global @rc-df/ngrx-migration-kit
cd /path/to/your/angular-project
ngrx-migration-kit --root src/app --path store/actions
```

The package is project-agnostic. It scans TypeScript files under the root
provided by `--root`; it does not require Angular or NgRx to be installed in
the migration kit package itself. Configure authentication for the package
registry before installing it. Run the command from the target project's
directory so relative roots resolve correctly. For pnpm, the same `@rc-df`
scope mapping in `.npmrc` is used.

## Usage

Default mode is dry-run. Add `--apply` only after reviewing the report:

```bash
ngrx-migration-kit \
  --root src/app \
  --path store/actions/document.actions.ts \
  --apply
```

Useful flags:

- `--root <dir>`: directory tree to scan. Defaults to the current working directory.
- `--path <text>`: include matching relative paths or a specific file. Repeat for staged migration.
- `--apply`: write generated action creators and consumer rewrites.
- `--strict`: return non-zero when unsupported/default-risk diagnostics or stale class references remain.
- `--json`: emit machine-readable migration report.
- `--version`, `-v`: print the installed package version and exit.

The same flags work through the published `ngrx-migration-kit` binary or a
project-local package script.

Agent behavior:

- Converts `implements Action` classes to lower camelCase `createAction` creators.
- Converts constructor properties to typed `props`.
- Rewrites `new Action(...)`, generic `ofType<Action>(...)`, and direct named imports.
- Rewrites class action unions to `ReturnType<typeof creator>`.
- Converts complete switch-based reducers to `createReducer` with `on` handlers.
- Preserves grouped cases by passing multiple creators to one `on` handler.
- Treats `default: return state` as the native `createReducer` fallback.
- Discovers existing `createAction` creators so already-migrated action files can
  participate in reducer conversion.
- Rewrites reducer/selector action type references to `ReturnType<typeof creator>`.
- Preserves action type strings and payload field names.
- Reports constructor defaults and unsupported members for AI/manual review.
- Leaves a reducer unchanged and reports `unmapped-reducer-action` when any
  switch case cannot be resolved to a migrated creator; it never guesses.
- Writes nothing unless `--apply` is supplied. `--strict --apply` is atomic when blocking findings exist.

Start with one action/effect slice, run affected tests, then widen `--path`.

## Releases

Releases are managed by Release Please on pushes to `main`. Use conventional
commits (`feat`, `fix`, and `BREAKING CHANGE`) so Release Please can determine
the next version and generate the corresponding `CHANGELOG.md` entries. The
release pull request includes the updated changelog; merging it creates a
GitHub Release. Publishing to the configured npm registry is not part of this
workflow.
