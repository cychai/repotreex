import ts from "typescript";

type BrowserValue = "root" | "storage" | "area" | "method";
type Scope = Map<string, BrowserValue | null>;

const storageAreas = new Set(["local", "sync", "session", "managed"]);
const storageMethods = new Set(["get", "getBytesInUse", "set", "remove", "clear", "setAccessLevel"]);

function unwrap(node: ts.Expression): ts.Expression {
  if (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node) || ts.isNonNullExpression(node)) {
    return unwrap(node.expression);
  }
  return node;
}

function memberType(base: BrowserValue, property: string | undefined): BrowserValue | undefined {
  if (base === "root" && property === "storage") return "storage";
  if (base === "storage" && storageAreas.has(property ?? "")) return "area";
  if (base === "area" && storageMethods.has(property ?? "")) return "method";
  return undefined;
}

export function findBrowserStorageReferences(source: string, filename: string): number[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const findings = new Set<number>();
  const scopes: Scope[] = [new Map()];
  const constants: Map<string, string>[] = [new Map()];
  const ambientRoots = new Set<string>();

  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement) || (statement.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) !== true)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && (declaration.name.text === "chrome" || declaration.name.text === "browser")) {
        ambientRoots.add(declaration.name.text);
      }
    }
  }

  const resolveIdentifier = (name: string): BrowserValue | undefined => {
    for (let index = scopes.length - 1; index >= 0; index -= 1) {
      if (scopes[index].has(name)) return scopes[index].get(name) ?? undefined;
    }
    return name === "chrome" || name === "browser" ? "root" : undefined;
  };

  const resolveConstant = (name: string): string | undefined => {
    for (let index = constants.length - 1; index >= 0; index -= 1) {
      if (constants[index].has(name)) return constants[index].get(name);
      if (scopes[index].has(name)) return undefined;
    }
    return undefined;
  };

  const staticProperty = (node: ts.Expression): string | undefined => {
    const value = unwrap(node);
    if (ts.isStringLiteralLike(value)) return value.text;
    if (ts.isIdentifier(value)) return resolveConstant(value.text);
    return undefined;
  };

  const expressionType = (node: ts.Expression): BrowserValue | undefined => {
    const value = unwrap(node);
    if (ts.isIdentifier(value)) return resolveIdentifier(value.text);
    if (ts.isPropertyAccessExpression(value)) {
      const base = expressionType(value.expression);
      return base === undefined ? undefined : memberType(base, value.name.text);
    }
    if (ts.isElementAccessExpression(value) && value.argumentExpression) {
      const base = expressionType(value.expression);
      return base === undefined ? undefined : memberType(base, staticProperty(value.argumentExpression));
    }
    return undefined;
  };

  const bindingProperty = (element: ts.BindingElement): string | undefined => {
    const property = element.propertyName ?? element.name;
    return ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined;
  };

  const bind = (name: ts.BindingName, value: BrowserValue | undefined, scope: Scope): void => {
    if (ts.isIdentifier(name)) {
      scope.set(name.text, value ?? null);
      return;
    }
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const nested = value === undefined ? undefined : memberType(value, bindingProperty(element));
      bind(element.name, nested, scope);
    }
  };

  const assign = (node: ts.Expression, value: BrowserValue | undefined): void => {
    const target = unwrap(node);
    if (ts.isIdentifier(target)) {
      for (let index = scopes.length - 1; index >= 0; index -= 1) {
        if (scopes[index].has(target.text)) {
          scopes[index].set(target.text, value ?? null);
          return;
        }
      }
      scopes.at(-1)?.set(target.text, value ?? null);
      return;
    }
    if (!ts.isObjectLiteralExpression(target)) return;
    for (const property of target.properties) {
      if (ts.isShorthandPropertyAssignment(property)) {
        assign(property.name, value === undefined ? undefined : memberType(value, property.name.text));
      } else if (ts.isPropertyAssignment(property)) {
        const key = ts.isIdentifier(property.name) || ts.isStringLiteralLike(property.name) ? property.name.text : undefined;
        assign(property.initializer, value === undefined ? undefined : memberType(value, key));
      }
    }
  };

  const report = (node: ts.Node): void => {
    findings.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  };

  const currentScope = (): Scope => scopes[scopes.length - 1];
  const currentConstants = (): Map<string, string> => constants[constants.length - 1];

  const visit = (node: ts.Node): void => {
    if (ts.isFunctionLike(node)) {
      scopes.push(new Map());
      constants.push(new Map());
      for (const parameter of node.parameters) bind(parameter.name, undefined, currentScope());
      if ("body" in node && node.body) visit(node.body);
      scopes.pop();
      constants.pop();
      return;
    }
    if (ts.isBlock(node)) {
      scopes.push(new Map());
      constants.push(new Map());
      for (const statement of node.statements) visit(statement);
      scopes.pop();
      constants.pop();
      return;
    }
    if (ts.isVariableDeclaration(node)) {
      const value = node.initializer ? expressionType(node.initializer) : undefined;
      if (!(ts.isIdentifier(node.name) && ambientRoots.has(node.name.text) && node.initializer === undefined)) {
        bind(node.name, value, currentScope());
      }
      if (node.initializer && ts.isIdentifier(node.name) && ts.isStringLiteralLike(unwrap(node.initializer))) {
        currentConstants().set(node.name.text, (unwrap(node.initializer) as ts.StringLiteralLike).text);
      }
      if (value === "storage" || value === "area" || value === "method") report(node);
      if (node.initializer) visit(node.initializer);
      return;
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
      const value = expressionType(node.right);
      assign(node.left, value);
      if (value === "storage" || value === "area" || value === "method") report(node);
      visit(node.right);
      return;
    }
    if (ts.isExpression(node)) {
      const value = expressionType(node);
      if (value === "storage" || value === "area" || value === "method") report(node);
    }
    ts.forEachChild(node, visit);
  };

  for (const statement of file.statements) visit(statement);
  return [...findings].sort((left, right) => left - right);
}
