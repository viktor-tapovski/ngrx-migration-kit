import ts from 'typescript';

export type DiagnosticCode =
  | 'constructor-default'
  | 'unsupported-action'
  | 'missing-action-type'
  | 'missing-action-import'
  | 'unsupported-reducer'
  | 'unmapped-reducer-action'
  | 'missing-reducer-action-import';

export interface MigrationDiagnostic {
  code: DiagnosticCode;
  filePath: string;
  action?: string;
  message: string;
}

function requiredParameterCount(parameters: ActionParameter[]): number {
  return parameters.filter((parameter, index) => {
    const hasEarlierDefault = parameters
      .slice(0, index + 1)
      .some((candidate) => candidate.hasDefault);
    return !parameter.optional && !hasEarlierDefault;
  }).length;
}

export interface SourceScan {
  classes: string[];
  constructorCalls: string[];
  genericOfType: string[];
}

export interface MigrationResult extends SourceScan {
  source: string;
  changed: boolean;
  diagnostics: MigrationDiagnostic[];
  actions: ActionMetadata[];
}

export interface ReducerMigrationResult {
  source: string;
  changed: boolean;
  diagnostics: MigrationDiagnostic[];
}

export interface ActionMetadata {
  className: string;
  creatorName: string;
  typeExpression: string;
  parameters: ActionParameter[];
}

interface ActionDefinition extends ActionMetadata {
  declaration: ts.ClassDeclaration;
  typeExpression: string;
}

export interface ActionParameter {
  name: string;
  type: string;
  optional: boolean;
  hasDefault: boolean;
}

interface TextEdit {
  start: number;
  end: number;
  text: string;
}

const ACTION_STORE_MODULE = '@ngrx/store';

export function scanSource(source: string, filePath = 'source.ts'): SourceScan {
  const sourceFile = parseSource(source, filePath);
  const classes = getActionClasses(sourceFile).flatMap((declaration) =>
    declaration.name ? [declaration.name.text] : [],
  );
  const constructorCalls = new Set<string>();
  const genericOfType = new Set<string>();

  visit(sourceFile, (node) => {
    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      constructorCalls.add(node.expression.text);
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'ofType'
    ) {
      for (const typeArgument of node.typeArguments ?? []) {
        if (
          ts.isTypeReferenceNode(typeArgument) &&
          ts.isIdentifier(typeArgument.typeName)
        ) {
          genericOfType.add(typeArgument.typeName.text);
        }
      }
    }
  });

  return {
    classes,
    constructorCalls: [...constructorCalls],
    genericOfType: [...genericOfType],
  };
}

export function migrateActionSource(
  source: string,
  filePath = 'source.ts',
): MigrationResult {
  const sourceFile = parseSource(source, filePath);
  const actionDeclarations = getActionClasses(sourceFile);
  const definitions: ActionDefinition[] = [];
  const diagnostics: MigrationDiagnostic[] = [];

  for (const declaration of actionDeclarations) {
    const name = declaration.name?.text;
    if (!name) {
      continue;
    }
    const typeProperty = declaration.members.find(
      (member): member is ts.PropertyDeclaration =>
        ts.isPropertyDeclaration(member) &&
        ts.isIdentifier(member.name) &&
        member.name.text === 'type',
    );

    if (!typeProperty?.initializer) {
      diagnostics.push({
        code: 'missing-action-type',
        filePath,
        action: name,
        message: `Action ${name} has no resolvable type property.`,
      });
      continue;
    }

    const constructor = declaration.members.find(ts.isConstructorDeclaration);
    const parameters = constructor
      ? constructor.parameters
          .filter(isParameterProperty)
          .map((parameter) => toActionParameter(parameter))
      : [];

    for (const parameter of parameters) {
      if (parameter.hasDefault) {
        diagnostics.push({
          code: 'constructor-default',
          filePath,
          action: name,
          message: `Action ${name}.${parameter.name} has a constructor default; migrate call sites with an explicit value.`,
        });
      }
    }

    if (
      declaration.members.some(
        (member) =>
          !ts.isPropertyDeclaration(member) &&
          !ts.isConstructorDeclaration(member),
      )
    ) {
      diagnostics.push({
        code: 'unsupported-action',
        filePath,
        action: name,
        message: `Action ${name} contains members unsupported by createAction migration.`,
      });
    }

    definitions.push({
      declaration,
      className: name,
      creatorName: toCamelCase(name),
      typeExpression: typeProperty.initializer.getText(sourceFile),
      parameters,
    });
  }

  const scan = scanSource(source, filePath);
  if (definitions.length === 0) {
    return { ...scan, source, changed: false, diagnostics, actions: [] };
  }

  const creatorNames = new Map(
    definitions.map(({ className, creatorName }) => [className, creatorName]),
  );
  const edits: TextEdit[] = definitions.map((definition) => ({
    start: definition.declaration.getStart(sourceFile),
    end: definition.declaration.end,
    text: renderAction(definition),
  }));

  for (const statement of sourceFile.statements) {
    if (
      !ts.isTypeAliasDeclaration(statement) ||
      !ts.isUnionTypeNode(statement.type)
    ) {
      continue;
    }

    const replacement = statement.type.types
      .map((member) => {
        const memberName = getSimpleTypeName(member);
        const creatorName = memberName
          ? creatorNames.get(memberName)
          : undefined;
        return creatorName
          ? `ReturnType<typeof ${creatorName}>`
          : member.getText(sourceFile);
      })
      .join(' | ');

    if (replacement !== statement.type.getText(sourceFile)) {
      edits.push({
        start: statement.type.getStart(sourceFile),
        end: statement.type.end,
        text: replacement,
      });
    }
  }

  const storeImport = sourceFile.statements.find(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === ACTION_STORE_MODULE,
  );

  if (!storeImport) {
    diagnostics.push({
      code: 'missing-action-import',
      filePath,
      message: `Could not update ${ACTION_STORE_MODULE} import.`,
    });
  } else {
    edits.push({
      start: storeImport.getStart(sourceFile),
      end: storeImport.end,
      text: renderStoreImport(storeImport),
    });
  }

  const migratedSource = applyEdits(source, edits);
  return {
    ...scan,
    source: migratedSource,
    changed: migratedSource !== source,
    diagnostics,
    actions: definitions.map(
      ({ className, creatorName, typeExpression, parameters }) => ({
        className,
        creatorName,
        typeExpression,
        parameters,
      }),
    ),
  };
}

export function discoverFunctionalActions(
  source: string,
  filePath = 'source.ts',
): ActionMetadata[] {
  const sourceFile = parseSource(source, filePath);
  const actions: ActionMetadata[] = [];

  visit(sourceFile, (node) => {
    if (!ts.isVariableDeclaration(node) || !ts.isIdentifier(node.name)) {
      return;
    }
    if (
      !node.initializer ||
      !ts.isCallExpression(node.initializer) ||
      !ts.isIdentifier(node.initializer.expression) ||
      node.initializer.expression.text !== 'createAction'
    ) {
      return;
    }

    const typeExpression = node.initializer.arguments[0]?.getText(sourceFile);
    if (!typeExpression) {
      return;
    }
    const propsArgument = node.initializer.arguments[1];
    const parameters =
      propsArgument &&
      ts.isCallExpression(propsArgument) &&
      ts.isIdentifier(propsArgument.expression) &&
      propsArgument.expression.text === 'props'
        ? toFunctionalParameters(propsArgument, sourceFile)
        : [];
    actions.push({
      className: node.name.text,
      creatorName: node.name.text,
      typeExpression,
      parameters,
    });
  });

  return actions;
}

export function rewriteConsumerSource(
  source: string,
  filePath: string,
  actions: ActionMetadata[],
): string {
  const sourceFile = parseSource(source, filePath);
  const actionMap = new Map(
    actions.map((action) => [action.className, action]),
  );
  const actionTypeMap = new Map(
    actions.map((action) => [action.typeExpression, action]),
  );
  const edits: TextEdit[] = [];

  visit(sourceFile, (node) => {
    if (ts.isCaseClause(node)) {
      const action = actionTypeMap.get(node.expression.getText(sourceFile));
      if (action) {
        edits.push({
          start: node.expression.getStart(sourceFile),
          end: node.expression.end,
          text: `${action.creatorName}.type`,
        });
      }
    }

    if (
      ts.isTypeReferenceNode(node) &&
      ts.isIdentifier(node.typeName) &&
      !isWithinOfTypeCall(node)
    ) {
      const action = actionMap.get(node.typeName.text);
      if (action) {
        edits.push({
          start: node.getStart(sourceFile),
          end: node.end,
          text: `ReturnType<typeof ${action.creatorName}>`,
        });
      }
    }

    if (ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const action = actionMap.get(node.expression.text);
      if (!action) {
        return;
      }

      const args = node.arguments ?? [];
      if (
        args.some(ts.isSpreadElement) ||
        args.length < requiredParameterCount(action.parameters) ||
        args.length > action.parameters.length
      ) {
        return;
      }

      const call =
        action.parameters.length === 0
          ? `${action.creatorName}()`
          : `${action.creatorName}({ ${args
              .map((argument, index) => {
                const parameter = action.parameters[index];
                const value = argument.getText(sourceFile);
                return parameter && value === parameter.name
                  ? parameter.name
                  : `${parameter?.name ?? `arg${index}`}: ${value}`;
              })
              .join(', ')} })`;
      edits.push({
        start: node.getStart(sourceFile),
        end: node.end,
        text: call,
      });
    }

    if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'ofType' &&
      node.typeArguments?.length
    ) {
      const creatorsFromArguments = node.arguments
        .map((argument) => {
          const action = actions.find(
            ({ typeExpression }) =>
              typeExpression === argument.getText(sourceFile),
          );
          return action?.creatorName;
        })
        .filter((creator): creator is string => !!creator);
      const creators =
        creatorsFromArguments.length === node.arguments.length &&
        creatorsFromArguments.length > 0
          ? creatorsFromArguments
          : node.typeArguments
              .map((typeArgument) => {
                const typeName = getSimpleTypeName(typeArgument);
                return typeName
                  ? actionMap.get(typeName)?.creatorName
                  : undefined;
              })
              .filter((creator): creator is string => !!creator);
      if (creators.length !== node.typeArguments.length) {
        return;
      }

      edits.push({
        start: node.getStart(sourceFile),
        end: node.end,
        text: `ofType(${creators.join(', ')})`,
      });
    }

    if (
      ts.isImportDeclaration(node) &&
      node.importClause &&
      node.importClause.namedBindings &&
      ts.isNamedImports(node.importClause.namedBindings)
    ) {
      const originalNames = node.importClause.namedBindings.elements.map(
        (element) => element.getText(sourceFile),
      );
      const names = node.importClause.namedBindings.elements.map((element) => {
        const action = !element.propertyName
          ? actionMap.get(element.name.text)
          : undefined;
        return action ? action.creatorName : element.getText(sourceFile);
      });
      const uniqueNames = [...new Set(names)];
      if (
        uniqueNames.join(',') !== names.join(',') ||
        originalNames.some((name, index) => name !== names[index])
      ) {
        edits.push({
          start: node.getStart(sourceFile),
          end: node.end,
          text: renderNamedImport(
            uniqueNames,
            node.moduleSpecifier.getText(sourceFile).slice(1, -1),
            node.importClause.name?.getText(sourceFile),
          ),
        });
      }
    }
  });

  return applyEdits(source, edits);
}

export function rewriteReducerSource(
  source: string,
  filePath: string,
  actions: ActionMetadata[],
): ReducerMigrationResult {
  const sourceFile = parseSource(source, filePath);
  const actionByType = new Map<string, ActionMetadata>();

  for (const action of actions) {
    actionByType.set(action.typeExpression, action);
    actionByType.set(`${action.creatorName}.type`, action);
  }

  const edits: TextEdit[] = [];
  const usedActions = new Map<string, ActionMetadata>();
  const diagnostics: MigrationDiagnostic[] = [];

  visit(sourceFile, (node) => {
    if (!ts.isFunctionDeclaration(node) || !node.body || !node.name) {
      return;
    }

    const switchStatement = node.body.statements.find(
      (statement): statement is ts.SwitchStatement =>
        ts.isSwitchStatement(statement) &&
        statement.expression.getText(sourceFile) ===
          `${getActionParameterName(node)}.type`,
    );
    if (!switchStatement) {
      return;
    }

    const initialState = getInitialState(node, sourceFile);
    if (!initialState) {
      diagnostics.push({
        code: 'unsupported-reducer',
        filePath,
        action: node.name.text,
        message: `Reducer ${node.name.text} must have a state parameter with a default initial state.`,
      });
      return;
    }

    const handlers: string[] = [];
    let pendingCases: ts.Expression[] = [];

    for (const clause of switchStatement.caseBlock.clauses) {
      if (ts.isDefaultClause(clause)) {
        if (
          pendingCases.length ||
          !isDefaultStateHandler(
            clause,
            sourceFile,
            getStateParameterName(node),
          )
        ) {
          diagnostics.push({
            code: 'unsupported-reducer',
            filePath,
            action: node.name.text,
            message: `Reducer ${node.name.text} has a default switch branch that cannot be represented by createReducer.`,
          });
        }
        pendingCases = [];
        continue;
      }

      pendingCases.push(clause.expression);
      if (!clause.statements.length) {
        continue;
      }

      const resolvedActions = pendingCases.map((expression) =>
        actionByType.get(expression.getText(sourceFile)),
      );
      if (resolvedActions.some((action) => action === undefined)) {
        diagnostics.push({
          code: 'unmapped-reducer-action',
          filePath,
          action: node.name.text,
          message: `Reducer ${node.name.text} contains a case without a migrated action creator.`,
        });
        return;
      }
      if (!containsReturnStatement(clause.statements)) {
        diagnostics.push({
          code: 'unsupported-reducer',
          filePath,
          action: node.name.text,
          message: `Reducer ${node.name.text} contains a case without a returned state.`,
        });
        return;
      }

      const mappedActions = resolvedActions.filter(
        (action): action is ActionMetadata => !!action,
      );
      const uniqueActions = [
        ...new Map(
          mappedActions.map((action) => [action.creatorName, action]),
        ).values(),
      ];
      uniqueActions.forEach((action) =>
        usedActions.set(action.creatorName, action),
      );
      handlers.push(
        renderReducerHandler(
          uniqueActions,
          clause.statements,
          sourceFile,
          getStateParameterName(node) ?? 'state',
          getActionParameterName(node) ?? 'action',
        ),
      );
      pendingCases = [];
    }

    if (pendingCases.length) {
      diagnostics.push({
        code: 'unsupported-reducer',
        filePath,
        action: node.name.text,
        message: `Reducer ${node.name.text} contains a fall-through case without a handler.`,
      });
      return;
    }

    const actionParameter = getActionParameterName(node);
    if (!actionParameter || !getStateParameterName(node) || !handlers.length) {
      diagnostics.push({
        code: 'unsupported-reducer',
        filePath,
        action: node.name.text,
        message: `Reducer ${node.name.text} does not contain a convertible action handler.`,
      });
      return;
    }

    const exportPrefix = node.modifiers?.some(
      (modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword,
    )
      ? 'export '
      : '';
    const reducer = `${exportPrefix}const ${node.name.text} = createReducer(\n  ${initialState},\n  ${handlers.join(',\n  ')},\n);`;
    edits.push({
      start: node.getStart(sourceFile),
      end: node.end,
      text: reducer,
    });
  });

  if (diagnostics.length || !edits.length) {
    return { source, changed: false, diagnostics };
  }

  let migratedSource = applyEdits(source, edits);
  const importResult = updateReducerImports(migratedSource, filePath, [
    ...usedActions.values(),
  ]);
  migratedSource = importResult.source;
  diagnostics.push(...importResult.diagnostics);

  if (diagnostics.length) {
    return { source, changed: false, diagnostics };
  }

  return {
    source: migratedSource,
    changed: migratedSource !== source,
    diagnostics,
  };
}

function getStateParameterName(
  declaration: ts.FunctionDeclaration,
): string | undefined {
  const parameter = declaration.parameters[0];
  return parameter && ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : undefined;
}

function getActionParameterName(
  declaration: ts.FunctionDeclaration,
): string | undefined {
  const parameter = declaration.parameters[1];
  return parameter && ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : undefined;
}

function getInitialState(
  declaration: ts.FunctionDeclaration,
  sourceFile: ts.SourceFile,
): string | undefined {
  const initializer = declaration.parameters[0]?.initializer;
  return initializer?.getText(sourceFile);
}

function renderReducerHandler(
  actions: ActionMetadata[],
  statements: readonly ts.Statement[],
  sourceFile: ts.SourceFile,
  stateName: string,
  actionName: string,
): string {
  const actionCreators = actions
    .map(({ creatorName }) => creatorName)
    .join(', ');
  const firstStatement = statements[0];

  if (statements.length === 1 && ts.isReturnStatement(firstStatement)) {
    const expressionNode = firstStatement.expression;
    const expression = expressionNode?.getText(sourceFile) ?? stateName;
    const arrowExpression =
      expressionNode && ts.isObjectLiteralExpression(expressionNode)
        ? `(${expression})`
        : expression;
    return `on(${actionCreators}, (${stateName}, ${actionName}) => ${arrowExpression})`;
  }

  const body = statements
    .map((statement) => {
      if (ts.isBlock(statement)) {
        return statement.statements
          .map((nested) => nested.getText(sourceFile))
          .join('\n');
      }
      return statement.getText(sourceFile);
    })
    .join('\n');
  return `on(${actionCreators}, (${stateName}, ${actionName}) => {\n    ${body}\n  })`;
}

function isDefaultStateHandler(
  clause: ts.DefaultClause,
  sourceFile: ts.SourceFile,
  stateName: string | undefined,
): boolean {
  if (!stateName) {
    return false;
  }
  const statements = clause.statements;
  if (statements.length === 1 && ts.isReturnStatement(statements[0])) {
    return statements[0].expression?.getText(sourceFile) === stateName;
  }
  if (statements.length === 1 && ts.isBlock(statements[0])) {
    const nested = statements[0].statements;
    return (
      nested.length === 1 &&
      ts.isReturnStatement(nested[0]) &&
      nested[0].expression?.getText(sourceFile) === stateName
    );
  }
  return false;
}

function containsReturnStatement(statements: readonly ts.Statement[]): boolean {
  return statements.some((statement) => {
    if (ts.isReturnStatement(statement)) {
      return true;
    }
    let found = false;
    visit(statement, (node) => {
      if (ts.isReturnStatement(node)) {
        found = true;
      }
    });
    return found;
  });
}

function updateReducerImports(
  source: string,
  filePath: string,
  usedActions: ActionMetadata[],
): { source: string; diagnostics: MigrationDiagnostic[] } {
  const sourceFile = parseSource(source, filePath);
  const diagnostics: MigrationDiagnostic[] = [];
  const edits: TextEdit[] = [];
  const storeImport = sourceFile.statements.find(
    (statement): statement is ts.ImportDeclaration =>
      ts.isImportDeclaration(statement) &&
      ts.isStringLiteral(statement.moduleSpecifier) &&
      statement.moduleSpecifier.text === ACTION_STORE_MODULE,
  );

  if (storeImport?.importClause?.namedBindings) {
    if (ts.isNamedImports(storeImport.importClause.namedBindings)) {
      const names = storeImport.importClause.namedBindings.elements.map(
        (element) => element.getText(sourceFile),
      );
      names.push('createReducer', 'on');
      edits.push({
        start: storeImport.getStart(sourceFile),
        end: storeImport.end,
        text: renderNamedImport(
          names,
          ACTION_STORE_MODULE,
          storeImport.importClause.name?.getText(sourceFile),
        ),
      });
    }
  } else if (!storeImport) {
    edits.push({
      start: 0,
      end: 0,
      text: `import { createReducer, on } from '${ACTION_STORE_MODULE}';\n`,
    });
  } else {
    diagnostics.push({
      code: 'unsupported-reducer',
      filePath,
      message: `Could not update the ${ACTION_STORE_MODULE} import for reducer migration.`,
    });
  }

  const usedByEnum = new Map<string, string[]>();
  for (const action of usedActions) {
    const enumName = action.typeExpression.split('.')[0];
    const creators = usedByEnum.get(enumName) ?? [];
    creators.push(action.creatorName);
    usedByEnum.set(enumName, creators);
  }

  const resolvedEnums = new Set<string>();
  for (const statement of sourceFile.statements) {
    if (
      !ts.isImportDeclaration(statement) ||
      !ts.isStringLiteral(statement.moduleSpecifier) ||
      !ts.isNamedImports(statement.importClause?.namedBindings)
    ) {
      continue;
    }
    const namedBindings = statement.importClause.namedBindings;
    const importedEnums = [...usedByEnum.keys()].filter((enumName) =>
      namedBindings.elements.some((element) => element.name.text === enumName),
    );
    if (!importedEnums.length) {
      continue;
    }

    importedEnums.forEach((enumName) => resolvedEnums.add(enumName));
    const names = namedBindings.elements
      .filter(
        (element) =>
          !usedByEnum.has(element.name.text) ||
          identifierIsUsedOutsideImport(
            sourceFile,
            statement,
            element.name.text,
          ),
      )
      .map((element) => element.getText(sourceFile));
    names.push(
      ...importedEnums.flatMap((enumName) => usedByEnum.get(enumName) ?? []),
    );
    edits.push({
      start: statement.getStart(sourceFile),
      end: statement.end,
      text: renderNamedImport(
        [...new Set(names)],
        statement.moduleSpecifier.getText(sourceFile).slice(1, -1),
        statement.importClause.name?.getText(sourceFile),
      ),
    });
  }

  for (const enumName of usedByEnum.keys()) {
    if (!resolvedEnums.has(enumName)) {
      diagnostics.push({
        code: 'missing-reducer-action-import',
        filePath,
        action: enumName,
        message: `Could not find the imported action type ${enumName} needed for reducer migration.`,
      });
    }
  }

  return {
    source: applyEdits(source, edits),
    diagnostics,
  };
}

function identifierIsUsedOutsideImport(
  sourceFile: ts.SourceFile,
  importDeclaration: ts.ImportDeclaration,
  identifier: string,
): boolean {
  let used = false;
  visit(sourceFile, (node) => {
    if (
      used ||
      (node.pos >= importDeclaration.pos &&
        node.end <= importDeclaration.end) ||
      !ts.isIdentifier(node) ||
      node.text !== identifier
    ) {
      return;
    }
    used = true;
  });
  return used;
}

function renderNamedImport(
  names: string[],
  moduleName: string,
  defaultImport?: string,
): string {
  const prefix = defaultImport ? `${defaultImport}, ` : '';
  return `import ${prefix}{ ${[...new Set(names)].join(', ')} } from '${moduleName}';`;
}

function parseSource(source: string, filePath: string): ts.SourceFile {
  return ts.createSourceFile(
    filePath,
    source,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
}

function getActionClasses(sourceFile: ts.SourceFile): ts.ClassDeclaration[] {
  return sourceFile.statements.filter(
    (statement): statement is ts.ClassDeclaration =>
      ts.isClassDeclaration(statement) &&
      !!statement.name &&
      statement.heritageClauses?.some(
        (clause) =>
          clause.token === ts.SyntaxKind.ImplementsKeyword &&
          clause.types.some(
            (type) =>
              ts.isIdentifier(type.expression) &&
              type.expression.text === 'Action',
          ),
      ),
  );
}

function toFunctionalParameters(
  propsCall: ts.CallExpression,
  sourceFile: ts.SourceFile,
): ActionParameter[] {
  const typeArgument = propsCall.typeArguments?.[0];
  if (!typeArgument || !ts.isTypeLiteralNode(typeArgument)) {
    return [];
  }

  return typeArgument.members.flatMap((member) => {
    if (!ts.isPropertySignature(member) || !member.type || !member.name) {
      return [];
    }
    return [
      {
        name: member.name.getText(sourceFile),
        type: member.type.getText(sourceFile),
        optional: !!member.questionToken,
        hasDefault: false,
      },
    ];
  });
}

function isParameterProperty(parameter: ts.ParameterDeclaration): boolean {
  return !!parameter.modifiers?.some((modifier) =>
    [
      ts.SyntaxKind.PublicKeyword,
      ts.SyntaxKind.PrivateKeyword,
      ts.SyntaxKind.ProtectedKeyword,
      ts.SyntaxKind.ReadonlyKeyword,
    ].includes(modifier.kind),
  );
}

function toActionParameter(
  parameter: ts.ParameterDeclaration,
): ActionParameter {
  const name = ts.isIdentifier(parameter.name)
    ? parameter.name.text
    : parameter.name.getText();
  const hasDefault = !!parameter.initializer;
  const type = parameter.type?.getText() ?? inferType(parameter.initializer);

  return {
    name,
    type,
    optional: !!parameter.questionToken || hasDefault,
    hasDefault,
  };
}

function inferType(initializer: ts.Expression | undefined): string {
  if (!initializer) {
    return 'unknown';
  }
  if (
    initializer.kind === ts.SyntaxKind.TrueKeyword ||
    initializer.kind === ts.SyntaxKind.FalseKeyword
  ) {
    return 'boolean';
  }
  if (ts.isNumericLiteral(initializer)) {
    return 'number';
  }
  if (
    ts.isStringLiteral(initializer) ||
    ts.isNoSubstitutionTemplateLiteral(initializer)
  ) {
    return 'string';
  }
  if (ts.isArrayLiteralExpression(initializer)) {
    return 'unknown[]';
  }
  return 'unknown';
}

function renderAction(definition: ActionDefinition): string {
  const creatorName = definition.creatorName;
  if (definition.parameters.length === 0) {
    return `export const ${creatorName} = createAction(${definition.typeExpression});`;
  }

  const fields = definition.parameters.map(({ name, type }, index) => {
    const optional =
      definition.parameters[index].optional ||
      definition.parameters
        .slice(0, index + 1)
        .some((parameter) => parameter.hasDefault);
    return `${name}${optional ? '?' : ''}: ${type}`;
  });
  const props =
    fields.length === 1 ? fields[0] : `\n    ${fields.join(';\n    ')};\n  `;
  return `export const ${creatorName} = createAction(\n  ${definition.typeExpression},\n  props<{ ${props} }>(),\n);`;
}

function renderStoreImport(importDeclaration: ts.ImportDeclaration): string {
  const namedBindings = importDeclaration.importClause?.namedBindings;
  const existing = ts.isNamedImports(namedBindings)
    ? namedBindings.elements
        .map((element) => element.name.text)
        .filter((name) => name !== 'Action')
    : [];
  const names = [...new Set(['createAction', 'props', ...existing])];
  return `import { ${names.join(', ')} } from '${ACTION_STORE_MODULE}';`;
}

function getSimpleTypeName(node: ts.TypeNode): string | undefined {
  return ts.isTypeReferenceNode(node) && ts.isIdentifier(node.typeName)
    ? node.typeName.text
    : undefined;
}

function applyEdits(source: string, edits: TextEdit[]): string {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (result, edit) =>
        `${result.slice(0, edit.start)}${edit.text}${result.slice(edit.end)}`,
      source,
    );
}

function visit(node: ts.Node, callback: (node: ts.Node) => void): void {
  callback(node);
  node.forEachChild((child) => visit(child, callback));
}

function isWithinOfTypeCall(node: ts.Node): boolean {
  let current = node.parent;
  while (current) {
    if (
      ts.isCallExpression(current) &&
      ts.isIdentifier(current.expression) &&
      current.expression.text === 'ofType'
    ) {
      return true;
    }
    current = current.parent;
  }
  return false;
}

function toCamelCase(name: string): string {
  return `${name.charAt(0).toLowerCase()}${name.slice(1)}`;
}
