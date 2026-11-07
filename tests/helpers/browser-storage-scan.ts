import ts from "typescript";

type BrowserValue = "root" | "storage" | "area";
const storageAreas = ["local", "sync", "session", "managed"];
const storageMethods = ["get", "getBytesInUse", "set", "remove", "clear", "setAccessLevel"];

function propertyName(node: ts.Expression): string | undefined {
  if (ts.isPropertyAccessExpression(node)) return node.name.text;
  if (!ts.isElementAccessExpression(node) || node.argumentExpression === undefined) return undefined;
  const argument = node.argumentExpression;
  return ts.isStringLiteralLike(argument) ? argument.text : undefined;
}

function expressionBase(node: ts.Expression): ts.Expression | undefined {
  return ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)
    ? node.expression
    : undefined;
}

function bindingPropertyName(element: ts.BindingElement): string | undefined {
  const property = element.propertyName ?? element.name;
  return ts.isIdentifier(property) || ts.isStringLiteralLike(property) ? property.text : undefined;
}

function memberType(value: BrowserValue, property: string | undefined): BrowserValue | undefined {
  if (value === "root" && property === "storage") return "storage";
  if (value === "storage" && storageAreas.includes(property ?? "")) return "area";
  return undefined;
}

export function findBrowserStorageReferences(source: string, filename: string): number[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const aliases = new Map<string, BrowserValue>([["chrome", "root"], ["browser", "root"]]);
  const findings = new Set<number>();

  const classify = (node: ts.Expression): BrowserValue | undefined => {
    if (ts.isParenthesizedExpression(node)) return classify(node.expression);
    if (ts.isIdentifier(node)) return aliases.get(node.text);
    const base = expressionBase(node);
    const property = propertyName(node);
    if (base === undefined || property === undefined) return undefined;
    const baseType = classify(base);
    if (baseType === "root" && property === "storage") return "storage";
    if (baseType === "storage" && storageAreas.includes(property)) return "area";
    return undefined;
  };

  const bind = (name: ts.BindingName, value: BrowserValue): boolean => {
    if (ts.isIdentifier(name)) {
      if (aliases.get(name.text) === value) return false;
      aliases.set(name.text, value);
      return true;
    }
    let changed = false;
    for (const element of name.elements) {
      if (ts.isOmittedExpression(element)) continue;
      const property = bindingPropertyName(element);
      const elementType = memberType(value, property);
      if (elementType !== undefined) changed = bind(element.name, elementType) || changed;
    }
    return changed;
  };

  let changed = true;
  while (changed) {
    changed = false;
    const visitAliases = (node: ts.Node): void => {
      if (ts.isVariableDeclaration(node) && node.initializer !== undefined) {
        const value = classify(node.initializer);
        if (value !== undefined) changed = bind(node.name, value) || changed;
      } else if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.EqualsToken) {
        const value = classify(node.right);
        if (value !== undefined && ts.isIdentifier(node.left)) {
          changed = bind(node.left, value) || changed;
        } else if (value !== undefined && ts.isObjectLiteralExpression(node.left)) {
          for (const property of node.left.properties) {
            if (ts.isShorthandPropertyAssignment(property)) {
              const assignedType = memberType(value, property.name.text);
              if (assignedType !== undefined) changed = bind(property.name, assignedType) || changed;
            }
          }
        }
      }
      ts.forEachChild(node, visitAliases);
    };
    visitAliases(file);
  }

  const visitReferences = (node: ts.Node): void => {
    if (ts.isExpression(node)) {
      const value = classify(node);
      if (value === "storage" || value === "area") {
        findings.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
      } else if (ts.isCallExpression(node)) {
        const base = expressionBase(node.expression);
        const method = propertyName(node.expression);
        if (base !== undefined && method !== undefined && storageMethods.includes(method) && classify(base) === "area") {
          findings.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
        }
      }
    }
    ts.forEachChild(node, visitReferences);
  };
  visitReferences(file);
  return [...findings].sort((left, right) => left - right);
}
