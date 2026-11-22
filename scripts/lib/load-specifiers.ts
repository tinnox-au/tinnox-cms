// The module specifiers a file loads at run time with import() or require() (LINT-1).
// no-restricted-imports sees only static imports and re-exports, so
// scripts/lib/import-boundaries-lint.test.ts lints each of these as a static import against the
// config the file resolves to. Read from the syntax tree, so a specifier written inside a string
// or a comment (a lint fixture) is not a load.
import ts from 'typescript';

function scriptKind(path: string): ts.ScriptKind {
  if (path.endsWith('.tsx')) return ts.ScriptKind.TSX;
  if (/\.[cm]?js$/.test(path)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

/** The text of a string literal, or of a template with no expression; undefined otherwise. */
function literalText(node: ts.Node | undefined): string | undefined {
  return node !== undefined &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
    ? node.text
    : undefined;
}

/**
 * Every literal specifier of `import('...')`, ``import(`...`)`` with no expression and
 * `require('...')` in `text`, in source order. A computed specifier (import(name)) cannot be read
 * and is left out, as lint leaves it to review.
 */
export function loadSpecifiers(path: string, text: string): string[] {
  const source = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, false, scriptKind(path));
  const found: string[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node)) {
      const isImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';
      const specifier = isImport || isRequire ? literalText(node.arguments[0]) : undefined;
      if (specifier !== undefined) found.push(specifier);
    }
    ts.forEachChild(node, visit);
  };
  visit(source);
  return found;
}
