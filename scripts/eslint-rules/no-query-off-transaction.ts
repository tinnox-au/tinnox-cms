// AG-2.1 (adoption plan sections 2.4 and 3.2): in the API and the offline tools a statement is
// sent only on a transaction handle: the `tx` that the callback of readOrg or changeOrg
// receives, or that enterOrg returns inside changePreOrg. A statement on anything else runs
// outside a transaction: on the pool or a pooled client with no organisation set, so row-level
// security shows a tenant read nothing and nobody notices; on the handle of poolAsTx as a
// statement of its own, which is for the typed sec.* wrappers of packages/db/src/sec.ts only.
//
// With type information the receiver is judged by its type: it must carry the mark of a
// transaction handle (packages/db/src/tx.ts, which only run() makes), or the mark of the handle
// asDefiner gives its work (packages/db/src/definer.ts), on which an offline tool reads across
// organisations as tinnox_definer (D25). So a pool passed under the name `tx`, a pooled client,
// an Autocommit and a value typed `any` are all reported. A PreOrgTx carries the mark too, but
// it has no query: the type checker refuses that call (adoption plan step 18), so this rule need
// not. Without type information (a file linted outside a TypeScript project) the rule falls back
// to the name: the receiver must be an identifier called `tx`.
//
// `allowed` lists statements that may be sent off a transaction, each with its reason: the
// statement must be a string literal that the entry's pattern matches. eslint.config.js gives the
// entries to the one file that needs them.
//
// Not seen, and left to review: query taken off the handle before it is called
// (`const { query } = pool`, `pool.query.bind(pool)`), and a computed member name that is not a
// literal (`pool[name](...)`).
import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from './create-rule.ts';
import { brandReader } from './typed.ts';

const TX = { symbol: 'inTransaction', file: 'packages/db/src/tx.ts' } as const;
const DEFINER = { symbol: 'asTheDefiner', file: 'packages/db/src/definer.ts' } as const;

interface Allowed {
  /** A regular expression (source) the statement text must match. */
  readonly sql: string;
  /** Why this statement may run off a transaction, and which step removes the entry. */
  readonly reason: string;
}
type Options = [{ allowed?: readonly Allowed[] }];

function isQueryMember(node: TSESTree.MemberExpression): boolean {
  return node.computed
    ? node.property.type === AST_NODE_TYPES.Literal && node.property.value === 'query'
    : node.property.type === AST_NODE_TYPES.Identifier && node.property.name === 'query';
}

export default createRule<Options, 'offTransaction'>({
  name: 'no-query-off-transaction',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow query() on anything but a transaction handle (an OrgTx of @tinnox/db, or the handle of asDefiner) in the API and the offline tools',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          allowed: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['sql', 'reason'],
              properties: {
                sql: { type: 'string', minLength: 1 },
                reason: { type: 'string', minLength: 20 },
              },
            },
          },
        },
      },
    ],
    defaultOptions: [{}],
    messages: {
      offTransaction:
        'Do not call query() on {{receiver}}: only a transaction handle with an organisation takes a statement (the tx that the callback of readOrg or changeOrg receives, or that enterOrg returns inside changePreOrg). On the pool, a pooled client or the handle of poolAsTx the statement runs outside any transaction and with no organisation. Use readOrg(pool, orgId, (tx) => tx.query(...)) for a read, changeAsOperator(ctx, request, fn) from apps/api/src/auth/permissions.ts for an operator change, a typed sec.* wrapper from @tinnox/db (add it to packages/db/src/sec.ts if it is missing), or ping(pool) for a liveness probe. An offline tool that reads across organisations sends the statement on the handle asDefiner gives its work (@tinnox/db/migrate).',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const isTx = brandReader(context, TX);
    const isDefiner = brandReader(context, DEFINER);
    const allowed = (options.allowed ?? []).map((entry) => new RegExp(entry.sql));

    function onTransaction(receiver: TSESTree.Expression): boolean {
      if (isTx !== undefined && isDefiner !== undefined) {
        return isTx(receiver) || isDefiner(receiver);
      }
      return receiver.type === AST_NODE_TYPES.Identifier && receiver.name === 'tx';
    }

    function isAllowed(statement: TSESTree.CallExpressionArgument | undefined): boolean {
      return (
        statement?.type === AST_NODE_TYPES.Literal &&
        typeof statement.value === 'string' &&
        allowed.some((pattern) => pattern.test(String(statement.value)))
      );
    }

    return {
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type !== AST_NODE_TYPES.MemberExpression || !isQueryMember(callee)) return;
        if (onTransaction(callee.object) || isAllowed(node.arguments[0])) return;
        context.report({
          node: callee,
          messageId: 'offTransaction',
          data: { receiver: context.sourceCode.getText(callee.object).replace(/\s+/g, ' ') },
        });
      },
    };
  },
});
