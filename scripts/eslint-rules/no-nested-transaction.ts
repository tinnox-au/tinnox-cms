// U-3 (adoption plan sections 2.4 and 3.4): no transaction is opened inside another's callback.
// withOrg, withoutOrg and withResolvedOrg each take their own pooled connection, so a second one
// inside the first commits or rolls back on its own: an audit row can commit while the change it
// records rolls back, the inner statements do not see the outer's uncommitted rows, and the
// outer holds a connection while it waits for the inner (with every connection held that way,
// the pool never answers). run() in packages/db/src/tx.ts refuses the same thing at run time on
// any path; this rule reports the cases that can be read from one file:
//   - a call inside the callback given to one of the functions of OPENERS, and
//   - a call inside a function that takes a transaction handle (a parameter typed Tx).
// A handle that may be absent (`tx?: Tx`, `tx: Tx | undefined`, `Tx | null`) or is wrapped
// (`Readonly<Tx>`, `NonNullable<Tx>`) is still a handle.
// Not seen, and left to the runtime guard: a helper that opens the transaction itself and is
// called from a callback (the helper's own file looks innocent), and a handle that reaches the
// function untyped, inside an object (`{ tx }: { tx: Tx }`), or in a union with another type
// (`Tx | Pool`, which may be no handle at all).
import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from './create-rule.ts';

// The functions of @tinnox/db that take a connection of their own (packages/db/src/tx.ts:
// poolAsTx runs each statement as its own transaction), and the API's wrappers around withOrg
// (apps/api/src/auth/permissions.ts, apps/api/src/db-helpers.ts). A new wrapper joins this list.
const OPENERS: ReadonlySet<string> = new Set([
  'withOrg',
  'withoutOrg',
  'withResolvedOrg',
  'poolAsTx',
  'withOrgAllowed',
  'withOrgDecision',
  'withOrgDecisionAllowed',
]);

// The types of a transaction handle: a function that takes one runs inside a transaction.
const HANDLE_TYPES: ReadonlySet<string> = new Set(['Tx']);

type FunctionNode =
  TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration | TSESTree.FunctionExpression;

// Wrappers that leave a handle a handle.
const TRANSPARENT: ReadonlySet<string> = new Set(['Readonly', 'NonNullable']);

function isNullish(node: TSESTree.TypeNode): boolean {
  return (
    node.type === AST_NODE_TYPES.TSUndefinedKeyword || node.type === AST_NODE_TYPES.TSNullKeyword
  );
}

function nameOfType(node: TSESTree.TypeNode | undefined): string | undefined {
  if (node?.type === AST_NODE_TYPES.TSUnionType) {
    // `Tx | undefined` is `tx?: Tx` written out. With any other member the value may be no
    // handle, and the function may rightly open a transaction then: left to run().
    const named = node.types.filter((member) => !isNullish(member));
    return named.length === 1 ? nameOfType(named[0]) : undefined;
  }
  if (node?.type !== AST_NODE_TYPES.TSTypeReference) return undefined;
  if (node.typeName.type === AST_NODE_TYPES.Identifier) {
    return TRANSPARENT.has(node.typeName.name)
      ? nameOfType(node.typeArguments?.params[0])
      : node.typeName.name;
  }
  // A namespace import: db.Tx.
  return node.typeName.type === AST_NODE_TYPES.TSQualifiedName
    ? node.typeName.right.name
    : undefined;
}

/** The handle parameter of `node` as written (`tx: Tx`), if it has one. */
function handleParameter(node: FunctionNode): string | undefined {
  for (const written of node.params) {
    // A default value or a parameter property wraps the name.
    const param =
      written.type === AST_NODE_TYPES.AssignmentPattern
        ? written.left
        : written.type === AST_NODE_TYPES.TSParameterProperty
          ? written.parameter
          : written;
    if (param.type !== AST_NODE_TYPES.Identifier) continue;
    const type = nameOfType(param.typeAnnotation?.typeAnnotation);
    if (type !== undefined && HANDLE_TYPES.has(type)) return `${param.name}: ${type}`;
  }
  return undefined;
}

export default createRule({
  name: 'no-nested-transaction',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow opening a database transaction inside the callback of another, or inside a function that takes a transaction handle',
    },
    schema: [],
    messages: {
      nested:
        '{{opener}}() is called inside {{outer}}, where a transaction is already open. This opens a second transaction on another connection that commits independently. Pass the outer tx to the helper: give it a `tx: Tx` parameter (from @tinnox/db) and run the statements on that; work that must commit on its own goes after the outer call has returned.',
    },
  },
  create(context) {
    // Local names of the openers: their own, and any they are imported under.
    const openers = new Map<string, string>([...OPENERS].map((name) => [name, name]));
    // One entry per enclosing function: what makes it run inside a transaction, if anything.
    const enclosing: (string | undefined)[] = [];

    function openerOf(callee: TSESTree.Expression): string | undefined {
      if (callee.type === AST_NODE_TYPES.Identifier) return openers.get(callee.name);
      // A namespace or an object that carries the function: db.withOrg(...).
      if (
        callee.type === AST_NODE_TYPES.MemberExpression &&
        callee.property.type === AST_NODE_TYPES.Identifier
      ) {
        return callee.computed || !OPENERS.has(callee.property.name)
          ? undefined
          : callee.property.name;
      }
      return undefined;
    }

    function transactionOf(node: FunctionNode): string | undefined {
      const parent = node.parent;
      if (
        node.type !== AST_NODE_TYPES.FunctionDeclaration &&
        parent.type === AST_NODE_TYPES.CallExpression &&
        parent.arguments.includes(node)
      ) {
        const opener = openerOf(parent.callee);
        // poolAsTx takes no callback.
        if (opener !== undefined && opener !== 'poolAsTx') return `the callback of ${opener}()`;
      }
      const handle = handleParameter(node);
      return handle === undefined
        ? undefined
        : `a function that takes a transaction handle (${handle})`;
    }

    return {
      ImportSpecifier(node) {
        const imported =
          node.imported.type === AST_NODE_TYPES.Identifier ? node.imported.name : undefined;
        if (imported !== undefined && OPENERS.has(imported)) openers.set(node.local.name, imported);
      },
      ':function'(node: FunctionNode) {
        enclosing.push(transactionOf(node));
      },
      ':function:exit'() {
        enclosing.pop();
      },
      CallExpression(node) {
        const opener = openerOf(node.callee);
        if (opener === undefined) return;
        const outer = enclosing.findLast((entry) => entry !== undefined);
        if (outer === undefined) return;
        context.report({ node: node.callee, messageId: 'nested', data: { opener, outer } });
      },
    };
  },
});
