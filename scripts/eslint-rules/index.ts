// The repository's own ESLint rules (adoption plan section 3.4, D16): one file per rule, each
// built with createRule and tested with ESLint's RuleTester in <rule>.test.ts beside it.
// eslint.config.js loads this file with `await import()`, after it has checked that this Node
// runs TypeScript files; index.test.ts fails when a rule file is missing here, has no test, or
// is enabled in no block of eslint.config.js.
import type { ESLint, Rule } from 'eslint';
import exchangeFiles from './exchange-files.ts';
import noLegacyTransaction from './no-legacy-transaction.ts';
import noNestedTransaction from './no-nested-transaction.ts';
import noQueryOffTransaction from './no-query-off-transaction.ts';
import noRawAuditInsert from './no-raw-audit-insert.ts';
import sqlFragments from './sql-fragments.ts';

// Each rule under its file's name; eslint.config.js enables it as tinnox/<name>.
const rules: Record<string, Rule.RuleModule> = {
  'exchange-files': exchangeFiles,
  'no-legacy-transaction': noLegacyTransaction,
  'no-nested-transaction': noNestedTransaction,
  'no-query-off-transaction': noQueryOffTransaction,
  'no-raw-audit-insert': noRawAuditInsert,
  'sql-fragments': sqlFragments,
};

export default { meta: { name: 'tinnox' }, rules } satisfies ESLint.Plugin;
