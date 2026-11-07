import ts from "typescript";

const browserRoots = new Set(["chrome", "browser"]);
const globalHolders = new Set(["globalThis", "window", "self"]);

function isAmbientDeclaration(declaration: ts.Declaration): boolean {
  let node: ts.Node | undefined = declaration;
  while (node && !ts.isSourceFile(node)) {
    if (ts.isVariableStatement(node)) {
      return node.modifiers?.some((modifier) => modifier.kind === ts.SyntaxKind.DeclareKeyword) === true;
    }
    node = node.parent;
  }
  return false;
}

function isReferenceIdentifier(node: ts.Identifier): boolean {
  const parent = node.parent;
  if (ts.isPropertyAccessExpression(parent) && parent.name === node) return false;
  if (ts.isBindingElement(parent) && parent.propertyName === node) return false;
  if (ts.isShorthandPropertyAssignment(parent)) return true;
  if ("name" in parent && parent.name === node) return false;
  if (ts.isLabeledStatement(parent) || ts.isBreakStatement(parent) || ts.isContinueStatement(parent)) return false;
  return true;
}

function isRuntimeIdentityReference(node: ts.Identifier): boolean {
  const parent = node.parent;
  return ts.isTypeOfExpression(parent)
    || (ts.isPropertyAccessExpression(parent) && parent.expression === node && parent.name.text === "runtime");
}

function unwrap(node: ts.Expression): ts.Expression {
  while (ts.isParenthesizedExpression(node) || ts.isAsExpression(node) || ts.isTypeAssertionExpression(node)
    || ts.isNonNullExpression(node) || ts.isSatisfiesExpression(node)) {
    node = node.expression;
  }
  return node;
}

function isPureTypePosition(node: ts.Node): boolean {
  // ExpressionWithTypeArguments is also used for executable class heritage
  // and instantiation expressions. Its kind alone cannot decide erasure.
  if (ts.isExpressionWithTypeArguments(node)) return ts.isPartOfTypeNode(node);
  return ts.isTypeNode(node) || ts.isInterfaceDeclaration(node) || ts.isTypeAliasDeclaration(node)
    || ts.isTypeParameterDeclaration(node)
    || (ts.isImportDeclaration(node) && node.importClause?.isTypeOnly === true)
    || (ts.isExportDeclaration(node) && node.isTypeOnly)
    || (ts.isImportEqualsDeclaration(node) && node.isTypeOnly)
    || (ts.isImportSpecifier(node) && node.isTypeOnly)
    || (ts.isExportSpecifier(node) && node.isTypeOnly);
}

function isCapturedValue(node: ts.Identifier): boolean {
  let value: ts.Node = node;
  let parent = value.parent;
  while ((ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isTypeAssertionExpression(parent)
    || ts.isNonNullExpression(parent) || ts.isSatisfiesExpression(parent)) && parent.expression === value) {
    value = parent;
    parent = value.parent;
  }
  // All initializer-bearing nodes count, including parameters, binding
  // defaults, class fields and object properties, not just local variables.
  return ("initializer" in parent && parent.initializer === value)
    || (ts.isShorthandPropertyAssignment(parent) && parent.objectAssignmentInitializer === value)
    || (ts.isBinaryExpression(parent) && parent.operatorToken.kind === ts.SyntaxKind.EqualsToken && parent.right === value);
}

// Architecture guard, deliberately NOT taint/dataflow analysis. An unshadowed
// browser root is forbidden outside preferences.ts even when merely aliased or
// passed to another function (except direct runtime/typeof identity checks).
// Assignments/callbacks cannot erase that evidence.
// The compiler binder owns lexical/var/loop/named-function shadowing; no type
// evaluation, alias fixed point, or simulated execution is performed here.
export function findBrowserStorageReferences(source: string, filename: string): number[] {
  const file = ts.createSourceFile(filename, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const host: ts.CompilerHost = {
    getSourceFile: (name) => name === filename ? file : undefined,
    getDefaultLibFileName: () => "lib.d.ts",
    writeFile: () => { throw new Error("Privacy scanner must not emit files"); },
    getCurrentDirectory: () => "",
    getDirectories: () => [],
    fileExists: (name) => name === filename,
    readFile: (name) => name === filename ? source : undefined,
    getCanonicalFileName: (name) => name,
    useCaseSensitiveFileNames: () => true,
    getNewLine: () => "\n",
  };
  const checker = ts.createProgram([filename], { noLib: true, noResolve: true, allowJs: true }, host).getTypeChecker();
  const findings = new Set<number>();
  const report = (node: ts.Node): void => {
    findings.add(file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1);
  };
  const isAmbient = (node: ts.Identifier): boolean => {
    const symbol = ts.isShorthandPropertyAssignment(node.parent) && node.parent.name === node
      ? checker.getShorthandAssignmentValueSymbol(node.parent)
      : checker.getSymbolAtLocation(node);
    return !symbol || symbol.declarations?.every(isAmbientDeclaration) === true;
  };
  const nodes: ts.Node[] = [file];
  while (nodes.length > 0) {
    const node = nodes.pop();
    if (!node) break;
    if (isPureTypePosition(node)) continue;
    if (ts.isIdentifier(node) && browserRoots.has(node.text) && isReferenceIdentifier(node)
      && !isRuntimeIdentityReference(node) && isAmbient(node)) {
      report(node);
    }
    if (ts.isPropertyAccessExpression(node) && browserRoots.has(node.name.text)) {
      let base = unwrap(node.expression);
      while (ts.isPropertyAccessExpression(base) && globalHolders.has(base.name.text)) {
        base = unwrap(base.expression);
      }
      if (ts.isIdentifier(base) && globalHolders.has(base.text) && isAmbient(base)) report(node);
    }
    if (ts.isIdentifier(node) && globalHolders.has(node.text) && isCapturedValue(node) && isAmbient(node)) report(node);
    // Exact root strings are conservative evidence too (constant/computed
    // global lookups). Ordinary "chrome.storage" text and comments are not.
    if (ts.isStringLiteralLike(node) && browserRoots.has(node.text)) report(node);
    ts.forEachChild(node, (child) => { nodes.push(child); });
  }
  return [...findings].sort((left, right) => left - right);
}
