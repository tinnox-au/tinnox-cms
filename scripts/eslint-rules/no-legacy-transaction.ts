// AG-3.1, SCR-34 (adoption plan section 2.1 B, steps 19 and 20): a change and its audit rows are
// one thing. changeOrg and changePreOrg of @tinnox/db take a callback that returns
// `{ value, audit }` and write the audit rows on the transaction of the change themselves;
// changeOrg runs nothing without the WritePermit of the role guard; readOrg is READ ONLY. The
// legacy API keeps the two apart: withOrg, withoutOrg and withResolvedOrg open a transaction that
// anything may be written on, with or without a role check, and auditScoped and auditUnscoped
// write an audit row by hand, on whatever handle they are given.
//
// Step 20 moved every file of the API and the offline tools to the new API, and since then the
// runtime entry of @tinnox/db no longer exports the legacy names: the new API is built on them
// inside packages/db/src, and tests reach them through '@tinnox/db/testing', which lint refuses
// outside a test (DB_ENTRIES in eslint.config.js). So an import from '@tinnox/db' fails to compile
// already; this rule refuses every other way a legacy name could come back into the API's source
// or the offline tools, with no file excepted.
//
// A use is: a legacy name imported or re-exported (under any local name, from any module); a
// call through a namespace or an object (`db.withOrg(...)`); and a call of a legacy name the
// file did not import (a wrapper of the file's own under that name, and a name taken from a
// dynamic import).
//
// Not seen, and left to review: a legacy function passed on as a value without a call
// (`const open = db.withOrg`), and a computed member (`db['withOrg'](...)`).
import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from './create-rule.ts';

/** The legacy names, each with what it is, for the message. */
const LEGACY: ReadonlyMap<string, string> = new Map([
  ['withOrg', 'opens a transaction that anything may be written on, with no role check'],
  ['withoutOrg', 'opens a transaction that anything may be written on, with no role check'],
  ['withResolvedOrg', 'opens a transaction that anything may be written on, with no role check'],
  ['auditScoped', 'writes an audit row by hand, on whatever transaction it is given'],
  ['auditUnscoped', 'writes an audit row by hand, on whatever transaction it is given'],
]);

const nameOf = (node: TSESTree.Identifier | TSESTree.StringLiteral): string =>
  node.type === AST_NODE_TYPES.Identifier ? node.name : node.value;

export default createRule<[], 'legacy'>({
  name: 'no-legacy-transaction',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow the legacy transaction API (withOrg and a hand-written audit call) in the API and the offline tools',
    },
    schema: [],
    messages: {
      legacy:
        '{{name}} is the legacy transaction API: it {{what}}. Use readOrg(pool, orgId, fn) for reads and changeOrg(pool, orgId, permit, fn) returning { value, audit } for changes; the permit comes from the role guard: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues it and checks the role again first. A change with no operator behind it gets its permit the same way: a player route calls changeAsDevice(ctx, request, device, fn) (apps/api/src/auth/device.ts), a job changeAsJob(pool, job, orgId, fn) (apps/api/src/jobs.ts), an offline tool changeOrgAsMigrator(pool, orgId, statement, fn) (@tinnox/db/migrate), and a refusal that changed nothing is written with recordRefusal(ctx, request, session, event) (apps/api/src/auth/refusal.ts). Before the organisation is known, use changePreOrg(pool, statement, fn), in the files of PRE_ORG_CHANGE_FILES (eslint.config.js) only. The wrapper writes the audit rows you return on the transaction of the change; a change that records nothing returns unaudited(reason) (all from @tinnox/db). The legacy names are for packages/db/src, which builds the new API on them, and for tests (@tinnox/db/testing).',
    },
  },
  defaultOptions: [],
  create(context) {
    const uses: { node: TSESTree.Node; name: string }[] = [];
    // Local names an import bound: a call of one is the same use as its import.
    const imported = new Set<string>();
    const calls: { node: TSESTree.Identifier; name: string }[] = [];

    return {
      ImportSpecifier(node) {
        const name = nameOf(node.imported);
        if (!LEGACY.has(name)) return;
        imported.add(node.local.name);
        uses.push({ node, name });
      },
      // `export { withOrg } from '@tinnox/db/testing'`: the file hands the legacy function on.
      ExportSpecifier(node) {
        if (node.parent.type !== AST_NODE_TYPES.ExportNamedDeclaration) return;
        if (node.parent.source === null) return;
        const name = nameOf(node.local);
        if (LEGACY.has(name)) uses.push({ node, name });
      },
      CallExpression(node) {
        const callee = node.callee;
        if (callee.type === AST_NODE_TYPES.Identifier) {
          if (LEGACY.has(callee.name)) calls.push({ node: callee, name: callee.name });
          return;
        }
        if (
          callee.type === AST_NODE_TYPES.MemberExpression &&
          !callee.computed &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          LEGACY.has(callee.property.name)
        ) {
          uses.push({ node: callee.property, name: callee.property.name });
        }
      },
      'Program:exit'() {
        for (const call of calls) if (!imported.has(call.node.name)) uses.push(call);
        for (const { node, name } of uses) {
          context.report({
            node,
            messageId: 'legacy',
            data: { name, what: LEGACY.get(name) ?? '' },
          });
        }
      },
    };
  },
});
