// U-3 (adoption plan sections 2.4 and 3.4): no transaction is opened inside another's callback.
// withOrg, withoutOrg and withResolvedOrg each take their own pooled connection (and so do
// readOrg, changeOrg and changePreOrg, which are the same transactions), so a second one
// inside the first commits or rolls back on its own: an audit row can commit while the change it
// records rolls back, the inner statements do not see the outer's uncommitted rows, and the
// outer holds a connection while it waits for the inner (with every connection held that way,
// the pool never answers). run() in packages/db/src/tx.ts refuses the same thing at run time on
// any path; this rule reports the cases that can be read from one file:
//   - a call inside the callback given to one of the functions of OPENERS, and
//   - a call inside a function that takes a transaction handle (a parameter typed OrgTx,
//     OrgReadTx, PreOrgTx, Tx, or DefinerTx, the handle asDefiner gives its work), or typed by a
//     type parameter whose constraint names one (`<T extends OrgReadTx>(tx: T)`, as the lock-flag
//     loaders of apps/api/src/publishing.ts are written).
// A handle that may be absent (`tx?: OrgTx`, `tx: OrgTx | undefined`, `OrgTx | null`) or is
// wrapped (`Readonly<OrgTx>`, `NonNullable<OrgTx>`) is still a handle.
// Not seen, and left to the runtime guard: a helper that opens the transaction itself and is
// called from a callback (the helper's own file looks innocent), and a handle that reaches the
// function untyped, inside an object (`{ tx }: { tx: OrgTx }`), or in a union with another type
// (`OrgTx | Pool`, which may be no handle at all).
import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from './create-rule.ts';

// The functions of @tinnox/db that take a connection of their own (packages/db/src/tx.ts:
// poolAsTx runs each statement as its own transaction, and so do auditStandalone and
// sessionRevokeUnaudited of packages/db/src/sec.ts, which take the pool; readOrg of tx.ts, and
// changeOrg and changePreOrg of packages/db/src/change.ts, changeOrgAsMigrator of the migrate
// entry), and the API's wrappers around them (apps/api/src/auth/permissions.ts, refusal.ts and
// device.ts there, apps/api/src/jobs.ts, apps/api/src/db-helpers.ts). A new wrapper joins this
// list.
const OPENERS: ReadonlySet<string> = new Set([
  'withOrg',
  'withoutOrg',
  'withResolvedOrg',
  'readOrg',
  'changeOrg',
  'changePreOrg',
  'poolAsTx',
  'auditStandalone',
  'sessionRevokeUnaudited',
  'changeAsOperator',
  'changeAsDevice',
  'changeAsJob',
  'changeOrgAsMigrator',
  'recordRefusal',
  'withOrgAllowed',
  'withOrgDecision',
  'withOrgDecisionAllowed',
]);

// The openers that take no callback: a function passed to one of them is not inside a transaction.
const WITHOUT_CALLBACK: ReadonlySet<string> = new Set([
  'poolAsTx',
  'auditStandalone',
  'sessionRevokeUnaudited',
  'recordRefusal',
]);

// The openers that take the pool and no tx. "Give the helper a tx parameter" does not fit them,
// so each has a message that names the function doing the same work on the outer tx (plan
// section 3.4).
const BY_NAME: ReadonlyMap<string, 'standaloneAudit' | 'unauditedRevoke' | 'refusal'> = new Map([
  ['auditStandalone', 'standaloneAudit'],
  ['sessionRevokeUnaudited', 'unauditedRevoke'],
  ['recordRefusal', 'refusal'],
]);

// The types of a transaction handle (packages/db/src/tx.ts and definer.ts): a function that
// takes one runs inside a transaction.
const HANDLE_TYPES: ReadonlySet<string> = new Set([
  'OrgTx',
  'OrgReadTx',
  'PreOrgTx',
  'Tx',
  'DefinerTx',
]);

type FunctionNode =
  TSESTree.ArrowFunctionExpression | TSESTree.FunctionDeclaration | TSESTree.FunctionExpression;

// Wrappers that leave a handle a handle.
const TRANSPARENT: ReadonlySet<string> = new Set(['Readonly', 'NonNullable']);

function isNullish(node: TSESTree.TypeNode): boolean {
  return (
    node.type === AST_NODE_TYPES.TSUndefinedKeyword || node.type === AST_NODE_TYPES.TSNullKeyword
  );
}

// The type parameters in scope, by name, with the constraint each was declared with.
type Constraints = ReadonlyMap<string, TSESTree.TypeNode | undefined>;

function nameOfType(
  node: TSESTree.TypeNode | undefined,
  constraints: Constraints = new Map(),
): string | undefined {
  if (node?.type === AST_NODE_TYPES.TSUnionType) {
    // `OrgTx | undefined` is `tx?: OrgTx` written out. With any other member the value may be no
    // handle, and the function may rightly open a transaction then: left to run().
    const named = node.types.filter((member) => !isNullish(member));
    return named.length === 1 ? nameOfType(named[0], constraints) : undefined;
  }
  if (node?.type !== AST_NODE_TYPES.TSTypeReference) return undefined;
  if (node.typeName.type === AST_NODE_TYPES.Identifier) {
    const name = node.typeName.name;
    if (constraints.has(name)) {
      // `tx: T` with `T extends OrgReadTx`: whatever T is, it is a handle. The parameter is
      // looked up without itself, so `T extends Box<T>` cannot loop.
      const rest = new Map(constraints);
      rest.delete(name);
      return nameOfType(constraints.get(name), rest);
    }
    return TRANSPARENT.has(name) ? nameOfType(node.typeArguments?.params[0], constraints) : name;
  }
  // A namespace import: db.OrgTx.
  return node.typeName.type === AST_NODE_TYPES.TSQualifiedName
    ? node.typeName.right.name
    : undefined;
}

/** The type parameters of `node` and of the functions around it; the nearest wins a name. */
function constraintsOf(node: FunctionNode, ancestors: readonly TSESTree.Node[]): Constraints {
  const constraints = new Map<string, TSESTree.TypeNode | undefined>();
  for (const at of [node, ...ancestors.toReversed()]) {
    if (
      at.type !== AST_NODE_TYPES.ArrowFunctionExpression &&
      at.type !== AST_NODE_TYPES.FunctionDeclaration &&
      at.type !== AST_NODE_TYPES.FunctionExpression
    ) {
      continue;
    }
    for (const param of at.typeParameters?.params ?? []) {
      if (!constraints.has(param.name.name)) constraints.set(param.name.name, param.constraint);
    }
  }
  return constraints;
}

/** The handle parameter of `node` as written (`tx: OrgTx`), if it has one. */
function handleParameter(
  node: FunctionNode,
  ancestors: readonly TSESTree.Node[],
): string | undefined {
  const constraints = constraintsOf(node, ancestors);
  for (const written of node.params) {
    // A default value or a parameter property wraps the name.
    const param =
      written.type === AST_NODE_TYPES.AssignmentPattern
        ? written.left
        : written.type === AST_NODE_TYPES.TSParameterProperty
          ? written.parameter
          : written;
    if (param.type !== AST_NODE_TYPES.Identifier) continue;
    const annotation = param.typeAnnotation?.typeAnnotation;
    const type = nameOfType(annotation, constraints);
    if (type === undefined || !HANDLE_TYPES.has(type)) continue;
    // A type parameter is named with its constraint, so the message says why it is a handle.
    const asWritten = nameOfType(annotation);
    return asWritten !== undefined && asWritten !== type && constraints.has(asWritten)
      ? `${param.name}: ${asWritten} extends ${type}`
      : `${param.name}: ${type}`;
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
        '{{opener}}() is called inside {{outer}}, where a transaction is already open. This opens a second transaction on another connection that commits independently. Pass the outer tx to the helper: give it a `tx: OrgTx` parameter (from @tinnox/db) and run the statements on that; work that must commit on its own goes after the outer call has returned.',
      standaloneAudit:
        '{{opener}}() is called inside {{outer}}, where a transaction is already open. This opens a second transaction on another connection that commits independently. Write the event on the outer transaction instead: inside changeOrg or changePreOrg, return it as { value, audit } and the wrapper writes it there; in a file of LEGACY_TRANSACTION_FILES (eslint.config.js), auditUnscoped(tx, event), or auditScoped(tx, event) when the outer transaction is withOrg (both from @tinnox/db). auditStandalone is only for a refusal that no transaction carries: call it after the outer call has returned or thrown.',
      unauditedRevoke:
        '{{opener}}() is called inside {{outer}}, where a transaction is already open. This opens a second transaction on another connection that commits independently. End the session on the outer tx instead: sessionRevoke(tx, idHash) (from @tinnox/db), with its audit row on the same tx. sessionRevokeUnaudited is only for the sign-out fallback: call it after the outer call has returned or thrown.',
      refusal:
        '{{opener}}() is called inside {{outer}}, where a transaction is already open. This opens a second transaction on another connection that commits independently. A refusal that commits with what the outer transaction wrote is returned from it, as { value: refuse(error), audit: event } (refuse from apps/api/src/db-helpers.ts): the wrapper writes the event there. recordRefusal is for a refusal that changed nothing: throw the refusal, and call it after the outer call has rolled back (SCR-32).',
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
        if (opener !== undefined && !WITHOUT_CALLBACK.has(opener)) {
          return `the callback of ${opener}()`;
        }
      }
      const handle = handleParameter(node, context.sourceCode.getAncestors(node));
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
        context.report({
          node: node.callee,
          messageId: BY_NAME.get(opener) ?? 'nested',
          data: { opener, outer },
        });
      },
    };
  },
});
