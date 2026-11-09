import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { migrateProject } from "./project";

describe("migrateProject", () => {
  let rootDir: string;

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), "ngrx-migration-kit-"));
    mkdirSync(join(rootDir, "actions"));
    writeFileSync(
      join(rootDir, "actions", "load.actions.ts"),
      `
        import { Action } from '@ngrx/store';
        enum ActionTypes { Load = '[Test] Load' }
        export class Load implements Action {
          readonly type = ActionTypes.Load;
        }
      `,
    );
    writeFileSync(
      join(rootDir, "consumer.ts"),
      `
        import { Load } from './actions/load.actions';
        ofType<Load>(ActionTypes.Load);
        dispatch(new Load());
      `,
    );
    writeFileSync(
      join(rootDir, "reducer.ts"),
      `
        import { Load } from './actions/load.actions';
        switch (action.type) {
          case ActionTypes.Load:
            return action as Load;
        }
      `,
    );
    writeFileSync(
      join(rootDir, "selector.ts"),
      `
        import { Load } from './actions/load.actions';
        export const selectLoad = (action: Load) => action.type;
      `,
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it("explains that root must be a directory when given a file", () => {
    expect(() =>
      migrateProject({ rootDir: join(rootDir, "actions", "load.actions.ts") }),
    ).toThrow(/--root must be a directory.*--path/);
  });

  it("rewrites consumers outside filtered action paths", () => {
    const dryRun = migrateProject({
      rootDir,
      include: ["actions/load.actions.ts"],
    });

    expect(dryRun.filesChanged).toEqual(
      expect.arrayContaining([
        "actions/load.actions.ts",
        "consumer.ts",
        "reducer.ts",
        "selector.ts",
      ]),
    );
    expect(dryRun.filesChanged).toHaveLength(4);
    expect(dryRun.staleReferences).toEqual([]);
    expect(dryRun.applied).toBe(false);

    const applied = migrateProject({
      rootDir,
      include: ["actions/load.actions.ts"],
      apply: true,
      strict: true,
    });

    expect(applied.applied).toBe(true);
    expect(readFileSync(join(rootDir, "consumer.ts"), "utf8")).toContain(
      "dispatch(load());",
    );
    expect(readFileSync(join(rootDir, "reducer.ts"), "utf8")).toContain(
      "case load.type:",
    );
    expect(readFileSync(join(rootDir, "selector.ts"), "utf8")).toContain(
      "action: ReturnType<typeof load>",
    );
  });

  it("maps existing functional actions outside selected paths in reducers", () => {
    writeFileSync(
      join(rootDir, "auth.actions.ts"),
      `
        enum AuthActionTypes { SetStatus = '[Auth] Set status' }
        export const setAuthStatus = createAction(AuthActionTypes.SetStatus);
      `,
    );
    writeFileSync(
      join(rootDir, "auth.reducer.ts"),
      `
        import { setAuthStatus } from './auth.actions';
        const initialState = { status: 'initial' };
        export function authReducer(state = initialState, action: AuthActions) {
          switch (action.type) {
            case setAuthStatus.type:
              return { ...state, status: 'authenticated' };
            default:
              return state;
          }
        }
      `,
    );

    const result = migrateProject({
      rootDir,
      include: ["actions/load.actions.ts"],
    });

    expect(result.diagnostics).toEqual([]);
    expect(result.filesChanged).toContain("auth.reducer.ts");
  });

  it("converts a reducer switch after migrating its action file", () => {
    writeFileSync(
      join(rootDir, "reducer.ts"),
      `
        import { ActionTypes, Actions, Load } from './actions/load.actions';
        const initialState = { loaded: false };

        export function reducer(state = initialState, action: Actions) {
          switch (action.type) {
            case ActionTypes.Load:
              return { ...state, loaded: true };
            default:
              return state;
          }
        }
      `,
    );

    const result = migrateProject({
      rootDir,
      include: ["actions/load.actions.ts"],
      apply: true,
      strict: true,
    });

    expect(result.applied).toBe(true);
    const reducer = readFileSync(join(rootDir, "reducer.ts"), "utf8");
    expect(reducer).toContain("export const reducer = createReducer(");
    expect(reducer).toContain(
      "on(load, (state) => ({ ...state, loaded: true }))",
    );
  });
});
