// What the rules that read types share: how to ask whether a value has one of the marked types
// of packages/db. Those types carry a property keyed by a `unique symbol` that their module does
// not export (Tx in src/tx.ts, SqlFragment in src/sql.ts), so "has that property, declared in
// that file" is the same question the type checker asks, and it holds for a subtype, an
// intersection and a generic parameter bounded by the type, which a comparison of names would
// miss.
import type { TSESLint, TSESTree } from '@typescript-eslint/utils';
import type ts from 'typescript';

export interface Brand {
  /** The name of the `unique symbol` constant that keys the marking property. */
  readonly symbol: string;
  /** The file that declares it, from the repository root. */
  readonly file: string;
}

function hasBrand(checker: ts.TypeChecker, type: ts.Type, brand: Brand): boolean {
  // Every member of a union must be marked: `Tx | Pool` may be no transaction at all.
  if (type.isUnion()) return type.types.every((member) => hasBrand(checker, member, brand));
  // A type parameter has the properties of its bound.
  const known = checker.getBaseConstraintOfType(type) ?? type;
  return checker.getPropertiesOfType(known).some(
    (property) =>
      // The checker names a property keyed by a unique symbol `__@<constant>@<id>`.
      property.getName().startsWith(`__@${brand.symbol}@`) &&
      (property.declarations ?? []).some((declaration) =>
        declaration.getSourceFile().fileName.replaceAll('\\', '/').endsWith(`/${brand.file}`),
      ),
  );
}

/**
 * A function that says whether an expression has the marked type, or undefined when the file is
 * linted without type information (a fixture, a .mjs file): the rule then falls back to what it
 * can read from the syntax.
 */
export function brandReader(
  context: Readonly<TSESLint.RuleContext<string, readonly unknown[]>>,
  brand: Brand,
): ((node: TSESTree.Expression) => boolean) | undefined {
  // Read straight from the source code object: getParserServices of typescript-eslint throws for
  // a file another parser read, and such a file is only one more case with no type information.
  const services = context.sourceCode.parserServices;
  const program = services?.program ?? undefined;
  const nodes = services?.esTreeNodeToTSNodeMap;
  if (program === undefined || nodes === undefined) return undefined;
  const checker = program.getTypeChecker();
  return (node) => hasBrand(checker, checker.getTypeAtLocation(nodes.get(node)), brand);
}
