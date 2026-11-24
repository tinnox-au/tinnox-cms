// AG-3.1, D25: the audit-insert rule against fixture code. It reads text only, so one tester
// without type information is enough. The message is pinned word for word (D16): it is what an
// author reads, and it must name what to use instead.
import { RuleTester } from 'eslint';
import tseslint from 'typescript-eslint';
import { describe, it } from 'vitest';
import rule from './no-raw-audit-insert.ts';

// ESLint looks for global describe and it, which the unit project does not define. itOnly stays
// unset: a focused case is a red run (U-15).
RuleTester.describe = describe;
RuleTester.it = it;

const tester = new RuleTester({ languageOptions: { parser: tseslint.parser } });

const MESSAGE =
  'Do not write an audit row with a statement of your own: return the event from the change it records, as { value, audit }, and changeOrg or changePreOrg (or the wrapper the route calls: changeAsOperator, changeAsDevice, changeAsJob, changeOrgAsMigrator) writes it on the transaction of that change. The event is an AuditInput, so the action is a member of AUDIT_ACTIONS and the detail has the shape AuditEventShapes gives it (packages/contracts/src/audit.ts); add the action or the field there first. A refusal with no change to pair with is auditStandalone(pool, event).';

// One whole statement, as eslint.config.js names provisioning's: anchored at both ends.
const EXPIRY = [
  {
    allowed: [
      {
        sql: "^\\s*WITH closed AS \\(UPDATE member_invite SET status = 'expired' RETURNING id\\)\\s+INSERT INTO public\\.audit_event \\(action\\) SELECT 'invite\\.cancel' FROM closed\\s*$",
        reason: 'a set-based expiry and its audit rows in one statement (fixture)',
      },
    ],
  },
];
const EXPIRY_STATEMENT = `
  WITH closed AS (UPDATE member_invite SET status = 'expired' RETURNING id)
  INSERT INTO public.audit_event (action) SELECT 'invite.cancel' FROM closed
`;

describe('no-raw-audit-insert (AG-3.1, D25)', { timeout: 30_000 }, () => {
  tester.run('no-raw-audit-insert', rule, {
    valid: [
      {
        name: 'the audit writers, and reading the audit log',
        code: `
          await auditScoped(tx, event);
          await auditUnscoped(tx, event);
          await tx.query('SELECT id, action FROM audit_event WHERE org_id = app_org_id()');
        `,
      },
      {
        name: 'an insert into another table, and a table whose name only starts the same',
        code: `
          await tx.query('INSERT INTO folder (org_id, name) VALUES (app_org_id(), $1)', [name]);
          await tx.query('INSERT INTO audit_event_archive (id) VALUES ($1)', [id]);
          await tx.query('INSERT INTO "audit_event_archive" (id) VALUES ($1)', [id]);
          await tx.query(\`INSERT INTO \${SCHEMA}.audit_event_archive (id) VALUES ($1)\`, [id]);
        `,
      },
      {
        name: 'a sentence about the table, and a comment that shows the statement',
        code: `
          // INSERT INTO audit_event is for auditScoped alone.
          export const NOTE = 'audit_event takes INSERT and SELECT only';
        `,
      },
      {
        name: 'the statement the options name, written whole as a template with nothing interpolated',
        code: `await tx.query(\`${EXPIRY_STATEMENT}\`, [staff]);`,
        options: EXPIRY,
      },
    ],
    invalid: [
      {
        name: 'the insert as a string, with and without the schema, in any case',
        code: `
          await tx.query("INSERT INTO audit_event (org_id, action) VALUES (app_org_id(), 'x.y')");
          await tx.query("insert into public.audit_event (action) values ('x.y')");
          await tx.query('INSERT  INTO\\n public . audit_event (action) VALUES ($1)', [action]);
        `,
        errors: [{ message: MESSAGE }, { message: MESSAGE }, { message: MESSAGE }],
      },
      {
        name: 'the insert with the table or the schema quoted, and with another schema',
        code: `
          await tx.query('INSERT INTO "audit_event" (action) VALUES ($1)', [action]);
          await tx.query('INSERT INTO public."audit_event" (action) VALUES ($1)', [action]);
          await tx.query('INSERT INTO "public" . "audit_event" (action) VALUES ($1)', [action]);
          await tx.query('INSERT INTO other.audit_event (action) VALUES ($1)', [action]);
        `,
        errors: [
          { message: MESSAGE },
          { message: MESSAGE },
          { message: MESSAGE },
          { message: MESSAGE },
        ],
      },
      {
        name: 'the insert in a template whose schema is interpolated, quoted or not',
        code: `
          await tx.query(\`INSERT INTO \${SCHEMA}.audit_event (action) VALUES ($1)\`, [action]);
          await tx.query(\`INSERT INTO "\${SCHEMA}"."audit_event" (action) VALUES ($1)\`, [action]);
        `,
        errors: [{ message: MESSAGE }, { message: MESSAGE }],
      },
      {
        name: 'the insert in a template, in a constant and behind the sql tag',
        code: `
          const WRITE = \`INSERT INTO audit_event (\${COLUMNS}) VALUES ($1)\`;
          await tx.query(\`WITH done AS (DELETE FROM folder RETURNING id)
            INSERT INTO audit_event (action) SELECT 'folder.delete' FROM done\`);
          export const fragment = sql\`INSERT INTO audit_event (action) VALUES ($1)\`;
        `,
        errors: [{ message: MESSAGE }, { message: MESSAGE }, { message: MESSAGE }],
      },
      {
        name: 'a statement the options do not name, and the named one with something added',
        code: `
          await tx.query("INSERT INTO public.audit_event (action) VALUES ('invite.cancel')");
          await tx.query(\`${EXPIRY_STATEMENT}; INSERT INTO public.audit_event (action) VALUES ('x.y')\`);
        `,
        options: EXPIRY,
        errors: [{ message: MESSAGE }, { message: MESSAGE }],
      },
      {
        name: 'the named statement with a value interpolated: an entry takes text from the source only',
        code: `await tx.query(\`
          WITH closed AS (UPDATE member_invite SET status = 'expired' RETURNING id)
          INSERT INTO public.audit_event (action) SELECT '\${action}' FROM closed
        \`);`,
        options: EXPIRY,
        errors: [{ message: MESSAGE }],
      },
    ],
  });
});
