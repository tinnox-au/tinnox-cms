// Every rule of the plugin is built with this (D16), so each has a name, typed options and
// message ids, and a pointer to its own file, where the comment says why the rule exists.
import { ESLintUtils } from '@typescript-eslint/utils';
import type { Rule } from 'eslint';

const typedRule = ESLintUtils.RuleCreator((name) => `scripts/eslint-rules/${name}.ts`);

/**
 * A rule written against typescript-eslint's types (the syntax tree with its TypeScript nodes),
 * returned as the rule type of ESLint itself. They are one object at run time, but
 * typescript-eslint declares a narrower context than ESLint's RuleDefinition, so ESLint's
 * RuleTester and its config type refuse the typed rule as it is. This is the one place that
 * says they are the same.
 */
export function createRule<Options extends readonly unknown[], MessageIds extends string>(
  rule: Readonly<ESLintUtils.RuleWithMetaAndName<Options, MessageIds>>,
): Rule.RuleModule {
  return typedRule(rule) as unknown as Rule.RuleModule;
}
