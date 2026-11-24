// AG-3.1, AG-3.3 (adoption plan section 2.1, step 17; D25): an audit row is written by the audit
// writers of packages/db/src/sec.ts and by nothing else. They take the event as an AuditInput,
// whose action is a member of the AuditAction union and whose detail has the closed shape of
// that action, and they take a Tx, so the row commits with the change it records. A statement
// that inserts into audit_event itself has none of that: any action, any detail, any handle.
//
// Reported: a string, or the text of a template, that holds `INSERT INTO audit_event` (with or
// without a schema, either name quoted or not), wherever it is written: the argument of query(),
// a constant, a fragment. A template is read with each interpolation as a placeholder name too,
// so `INSERT INTO ${SCHEMA}.audit_event` is seen.
//
// `allowed` lists the statements that may stay, each with its reason. A statement is taken only
// when it is written whole, as a string literal or a template with nothing interpolated, and the
// entry's pattern matches its text; eslint.config.js gives the entries to the one file that
// needs them, so an entry opens nothing else in that file.
//
// Not seen, and left to review: the table's own name put together at run time or interpolated
// ('INSERT INTO ' + table, `INSERT INTO ${TABLE}`), a comment between INTO and the name,
// an insert through a writable view or a function, and SQL files (migrations are held by
// `npm run check:migrations`; the incident scripts under scripts/*.sql are run by hand).
import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from './create-rule.ts';

// The schema, when there is one, may be any name: only public holds audit_event, and an
// interpolated schema is read as a placeholder name. The lookahead, not \b, ends the name, so
// that a closing quote is allowed and audit_event_archive is not taken.
const AUDIT_INSERT =
  /\bINSERT\s+INTO\s+(?:"?[a-z_][a-z0-9_$]*"?\s*\.\s*)?"?audit_event"?(?![a-z0-9_$])/i;
/** What an interpolation stands for when a template is read whole: a name. */
const PLACEHOLDER = 'interpolated';

interface Allowed {
  /** A regular expression (source) the whole statement must match. */
  readonly sql: string;
  /** Why this statement writes its audit rows itself. */
  readonly reason: string;
}
type Options = [{ allowed?: readonly Allowed[] }];

export default createRule<Options, 'rawInsert'>({
  name: 'no-raw-audit-insert',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a statement that writes audit_event rows itself, outside the audit writers of packages/db/src/sec.ts',
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
      rawInsert:
        'Do not write an audit row with a statement of your own: return the event from the change it records, as { value, audit }, and changeOrg or changePreOrg (or the wrapper the route calls: changeAsOperator, changeAsDevice, changeAsJob, changeOrgAsMigrator) writes it on the transaction of that change. The event is an AuditInput, so the action is a member of AUDIT_ACTIONS and the detail has the shape AuditEventShapes gives it (packages/contracts/src/audit.ts); add the action or the field there first. A refusal with no change to pair with is auditStandalone(pool, event).',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const allowed = (options.allowed ?? []).map((entry) => new RegExp(entry.sql));
    const isAllowed = (statement: string): boolean =>
      allowed.some((pattern) => pattern.test(statement));

    return {
      Literal(node: TSESTree.Literal) {
        if (typeof node.value !== 'string' || !AUDIT_INSERT.test(node.value)) return;
        if (isAllowed(node.value)) return;
        context.report({ node, messageId: 'rawInsert' });
      },
      TemplateLiteral(node: TSESTree.TemplateLiteral) {
        const texts = node.quasis.map((quasi) => quasi.value.cooked ?? quasi.value.raw);
        const inserts =
          AUDIT_INSERT.test(texts.join(PLACEHOLDER)) ||
          texts.some((text) => AUDIT_INSERT.test(text));
        if (!inserts) return;
        // Only a template with nothing interpolated is a whole statement an entry can name.
        const [whole] = texts;
        if (node.expressions.length === 0 && whole !== undefined && isAllowed(whole)) return;
        context.report({
          node: node.parent.type === AST_NODE_TYPES.TaggedTemplateExpression ? node.parent : node,
          messageId: 'rawInsert',
        });
      },
    };
  },
});
