import {
  discoverFunctionalActions,
  migrateActionSource,
  rewriteConsumerSource,
  rewriteReducerSource,
  scanSource,
} from "./migrator";

const documentActions = `
import { Document } from '@app/shared/model';
import { Action } from '@ngrx/store';

enum DocumentActionTypes {
  GetDocuments = '[Document] Get Documents',
  GetDocumentsSuccess = '[Document] Get Documents Success',
}

export class GetDocuments implements Action {
  public readonly type = DocumentActionTypes.GetDocuments;
}

export class GetDocumentsSuccess implements Action {
  public readonly type = DocumentActionTypes.GetDocumentsSuccess;
  constructor(public documents: Document[]) {}
}

export type DocumentActions = GetDocuments | GetDocumentsSuccess;
`;

describe("ngrx migration kit", () => {
  it("converts class actions and action unions to function creators", () => {
    const result = migrateActionSource(documentActions, "document.actions.ts");

    expect(result.source).toContain(
      "import { createAction, props } from '@ngrx/store';",
    );
    expect(result.source).toContain(
      "export const getDocuments = createAction(DocumentActionTypes.GetDocuments);",
    );
    expect(result.source).toContain("props<{ documents: Document[] }>(),");
    expect(result.source).toContain(
      "ReturnType<typeof getDocuments> | ReturnType<typeof getDocumentsSuccess>",
    );
    expect(result.classes).toEqual(["GetDocuments", "GetDocumentsSuccess"]);
    expect(result.diagnostics).toEqual([]);
  });

  it("reports constructor defaults that need call-site review", () => {
    const source = `
      import { Action } from '@ngrx/store';
      enum ActionTypes { Load = '[Test] Load' }
      export class Load implements Action {
        readonly type = ActionTypes.Load;
        constructor(public withSpinner = false) {}
      }
    `;

    const result = migrateActionSource(source, "test.actions.ts");

    expect(result.diagnostics).toEqual([
      expect.objectContaining({
        code: "constructor-default",
        action: "Load",
      }),
    ]);
    expect(result.source).toContain("withSpinner?: boolean");
  });

  it("preserves omitted parameters after a constructor default", () => {
    const source = `
      import { Action } from '@ngrx/store';
      enum ActionTypes { Load = '[Test] Load' }
      export class Load implements Action {
        readonly type = ActionTypes.Load;
        constructor(
          public required: string,
          public withDefault = false,
          public afterDefault: string,
        ) {}
      }
    `;

    const migrated = migrateActionSource(source, "test.actions.ts");

    expect(migrated.source).toContain("withDefault?: boolean");
    expect(migrated.source).toContain("afterDefault?: string");
    expect(
      rewriteConsumerSource(
        'dispatch(new Load("value"));',
        "consumer.ts",
        migrated.actions,
      ),
    ).toContain('dispatch(load({ required: "value" }));');
  });

  it("detects stale class construction and generic ofType references", () => {
    const result = scanSource(
      `
        ofType<Load>(ActionTypes.Load);
        dispatch(new Load());
      `,
      "test.effects.ts",
    );

    expect(result.genericOfType).toEqual(["Load"]);
    expect(result.constructorCalls).toEqual(["Load"]);
  });

  it("rewrites constructors and generic ofType calls in consumers", () => {
    const result = rewriteConsumerSource(
      `
        ofType<GetDocuments>(DocumentActionTypes.GetDocuments);
        ofType<GetDocuments>(DocumentActionTypes.CreateDocument);
        dispatch(new GetDocuments());
        dispatch(new CreateDocument(metadata, formData));
      `,
      "document.effects.ts",
      [
        {
          className: "GetDocuments",
          creatorName: "getDocuments",
          typeExpression: "DocumentActionTypes.GetDocuments",
          parameters: [],
        },
        {
          className: "CreateDocument",
          creatorName: "createDocument",
          typeExpression: "DocumentActionTypes.CreateDocument",
          parameters: [
            {
              name: "metadata",
              type: "CreateDocumentMetaData",
              optional: false,
              hasDefault: false,
            },
            {
              name: "documentData",
              type: "FormData",
              optional: false,
              hasDefault: false,
            },
          ],
        },
        {
          className: "GetDocumentsSuccess",
          creatorName: "getDocumentsSuccess",
          typeExpression: "DocumentActionTypes.GetDocumentsSuccess",
          parameters: [
            {
              name: "documents",
              type: "Document[]",
              optional: false,
              hasDefault: false,
            },
          ],
        },
      ],
    );

    expect(result).toContain("ofType(getDocuments);");
    expect(result).toContain("ofType(createDocument);");
    expect(result).toContain("dispatch(getDocuments());");
    expect(result).toContain(
      "dispatch(createDocument({ metadata, documentData: formData }));",
    );
  });

  it("rewrites reducer cases and selector action types", () => {
    const result = rewriteConsumerSource(
      `
        import { GetDocumentsSuccess } from './document.actions';
        switch (action.type) {
          case DocumentActionTypes.GetDocumentsSuccess:
            return action as GetDocumentsSuccess;
        }
      `,
      "document.reducers.ts",
      [
        {
          className: "GetDocumentsSuccess",
          creatorName: "getDocumentsSuccess",
          typeExpression: "DocumentActionTypes.GetDocumentsSuccess",
          parameters: [],
        },
      ],
    );

    expect(result).toContain("case getDocumentsSuccess.type:");
    expect(result).toContain(
      "return action as ReturnType<typeof getDocumentsSuccess>;",
    );
    expect(result).toContain(
      "import { getDocumentsSuccess } from './document.actions';",
    );
  });

  it("converts switch reducers to createReducer and on handlers", () => {
    const result = rewriteReducerSource(
      `
        import { ActionTypes, Actions } from './actions';
        import { createReducer } from '@ngrx/store';
        const initialState = { loading: false, value: 0 };

        export function reducer(
          state = initialState,
          action: Actions,
        ) {
          switch (action.type) {
            case ActionTypes.Load:
              return { ...state, loading: true };
            case ActionTypes.LoadSuccess: {
              return { ...state, value: action.value };
            }
            default:
              return state;
          }
        }
      `,
      "reducer.ts",
      [
        {
          className: "Load",
          creatorName: "load",
          typeExpression: "ActionTypes.Load",
          parameters: [],
        },
        {
          className: "LoadSuccess",
          creatorName: "loadSuccess",
          typeExpression: "ActionTypes.LoadSuccess",
          parameters: [
            {
              name: "value",
              type: "number",
              optional: false,
              hasDefault: false,
            },
          ],
        },
      ],
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.source).toContain("export const reducer = createReducer(");
    expect(result.source).toContain(
      "on(load, (state, action) => ({ ...state, loading: true }))",
    );
    expect(result.source).toContain("on(loadSuccess, (state, action) => {");
    expect(result.source).toContain(
      "import { Actions, load, loadSuccess } from './actions';",
    );
    expect(result.source).toContain("createReducer, on");
  });

  it("reports unmapped switch cases without changing the reducer", () => {
    const source = `
      const initialState = {};
      export function reducer(state = initialState, action: Actions) {
        switch (action.type) {
          case KnownActionTypes.Load:
            return state;
          case UnknownActionTypes.Other:
            return state;
          default:
            return state;
        }
      }
    `;

    const result = rewriteReducerSource(source, "reducer.ts", [
      {
        className: "Load",
        creatorName: "load",
        typeExpression: "KnownActionTypes.Load",
        parameters: [],
      },
    ]);

    expect(result.source).toBe(source);
    expect(result.diagnostics).toEqual([
      expect.objectContaining({ code: "unmapped-reducer-action" }),
    ]);
  });

  it("updates one action import once when cases use multiple action enums", () => {
    const result = rewriteReducerSource(
      `
        import { FirstActionTypes, SecondActionTypes } from './actions';
        const initialState = {};
        export function reducer(state = initialState, action: Actions) {
          switch (action.type) {
            case FirstActionTypes.Load:
              return state;
            case SecondActionTypes.Save:
              return state;
            default:
              return state;
          }
        }
      `,
      "reducer.ts",
      [
        {
          className: "Load",
          creatorName: "load",
          typeExpression: "FirstActionTypes.Load",
          parameters: [],
        },
        {
          className: "Save",
          creatorName: "save",
          typeExpression: "SecondActionTypes.Save",
          parameters: [],
        },
      ],
    );

    expect(result.diagnostics).toEqual([]);
    expect(result.source).toContain("import { load, save } from './actions';");
    expect(result.source).toContain("export const reducer = createReducer(");
  });

  it("discovers existing functional action creators for reducer migration", () => {
    expect(
      discoverFunctionalActions(
        `
          export const load = createAction(
            ActionTypes.Load,
            props<{ requestId: string; retry?: boolean }>(),
          );
        `,
        "actions.ts",
      ),
    ).toEqual([
      {
        className: "load",
        creatorName: "load",
        typeExpression: "ActionTypes.Load",
        parameters: [
          {
            name: "requestId",
            type: "string",
            optional: false,
            hasDefault: false,
          },
          {
            name: "retry",
            type: "boolean",
            optional: true,
            hasDefault: false,
          },
        ],
      },
    ]);
  });
});
