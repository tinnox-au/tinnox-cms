// AG-3.1, SCR-34 (adoption plan section 2.1 B, steps 19 and 20): a change and its audit rows are
// one thing. changeOrg and changePreOrg of @tinnox/db take a callback that returns
// `{ value, audit }` and write the audit rows on the transaction of the change themselves;
// changeOrg runs nothing without the WritePermit of the role guard; readOrg is READ ONLY. The
// legacy API keeps the two apart: withOrg, withoutOrg and withResolvedOrg open a transaction that
// anything may be written on, with or without a role check, and auditScoped and auditUnscoped
// write an audit row by hand, on whatever handle they are given. withOrgAllowed,
// withOrgDecisionAllowed and withOrgDecision are the API's wrappers for callbacks of that kind.
//
// The files that used the legacy API when the new one landed are listed in
// LEGACY_TRANSACTION_FILES of eslint.config.js, which gives them `listed: true`. The list only
// shrinks: step 20 moves one file at a time and removes it. So the rule reports two things:
//   - in a file that is not listed, every use of a legacy name: a new file starts on the new
//     API, and a file that has left the list does not go back;
//   - in a listed file, that it uses none any more: the entry is removed with the move, not
//     later.
//
// A use is: a legacy name imported or re-exported (under any local name, from any module); a
// call through a namespace or an object (`db.withOrg(...)`); and a call of a legacy name the
// file did not import (the wrapper's own module, where one wrapper calls the other, and a name
// taken from a dynamic import).
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
  ['withOrgAllowed', 'is for a callback that writes its audit rows by hand'],
  ['withOrgDecisionAllowed', 'is for a callback that writes its audit rows by hand'],
  ['withOrgDecision', 'is for a callback that writes its audit rows by hand'],
]);

type Options = [{ listed?: boolean }];

const nameOf = (node: TSESTree.Identifier | TSESTree.StringLiteral): string =>
  node.type === AST_NODE_TYPES.Identifier ? node.name : node.value;

export default createRule<Options, 'legacy' | 'stale'>({
  name: 'no-legacy-transaction',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow the legacy transaction API (withOrg and a hand-written audit call) outside the files that still use it, and a listed file that no longer does',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: { listed: { type: 'boolean' } },
      },
    ],
    defaultOptions: [{}],
    messages: {
      legacy:
        '{{name}} is the legacy transaction API: it {{what}}. Use readOrg(pool, orgId, fn) for reads and changeOrg(pool, orgId, permit, fn) returning { value, audit } for changes; the permit comes from the role guard: an operator route calls changeAsOperator(ctx, request, fn) (apps/api/src/auth/permissions.ts), which issues it and checks the role again first. A change with no operator behind it gets its permit the same way: a player route calls changeAsDevice(ctx, request, device, fn) (apps/api/src/auth/device.ts), a job changeAsJob(pool, job, orgId, fn) (apps/api/src/jobs.ts), an offline tool changeOrgAsMigrator(pool, orgId, statement, fn) (@tinnox/db/migrate), and a refusal that changed nothing is written with recordRefusal(ctx, request, session, event) (apps/api/src/auth/refusal.ts). Before the organisation is known, use changePreOrg(pool, statement, fn), in the files of PRE_ORG_CHANGE_FILES (eslint.config.js) only. The wrapper writes the audit rows you return on the transaction of the change; a change that records nothing returns unaudited(reason) (all from @tinnox/db). This file is not in LEGACY_TRANSACTION_FILES of eslint.config.js, and that list only shrinks: do not add to it.',
      stale:
        'This file no longer uses the legacy transaction API (withOrg, withoutOrg, withResolvedOrg, auditScoped, auditUnscoped, withOrgAllowed, withOrgDecisionAllowed, withOrgDecision): remove it from LEGACY_TRANSACTION_FILES in eslint.config.js. The list only shrinks, and an entry that stays would let the legacy API back into this file unseen.',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const listed = options.listed === true;
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
      // `export { withOrg } from '@tinnox/db'`: the file hands the legacy function on.
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
      'Program:exit'(program) {
        for (const call of calls) if (!imported.has(call.node.name)) uses.push(call);
        if (listed) {
          if (uses.length === 0) {
            // The first line, not the whole file.
            context.report({ loc: { line: 1, column: 0 }, node: program, messageId: 'stale' });
          }
          return;
        }
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
