// OTH-12 (adoption plan sections 3.2 and 3.4): SQL is parameterised and never built from a value.
// The statement given to query() is text from the source: a string literal, or a template that
// interpolates only
//   - an UPPER_CASE constant of the module (declared with `const` at the top level, or imported
//     under that name), such as a column list, or
//   - a SqlFragment (packages/db/src/sql.ts), which only sql`...`, sqlParameter and joinSql
//     make, for text that is put together at run time (a clause that is only sometimes there,
//     one of two fixed table names, a list of conditions).
// Everything else is a parameter ($1, $2). The same holds for the statement as a whole when it is
// not written at the call (`tx.query(text)`): otherwise the template would only have to move to
// a variable first. And it holds inside the sql`...` tag, whose parameter type a value typed
// `any` would pass.
//
// A SqlFragment is recognised by its type, so `join.table` and `parameter(value)` pass. A choice
// (`lock ? FOR_SHARE : NO_LOCK`) passes when both branches would; as the whole statement, a string
// literal or a template that would pass is a branch too (`lock ? 'SELECT ... FOR SHARE' :
// 'SELECT ...'`, CHK-8), while inside a template a choice of literals is still reported, so that
// text chosen at run time is a SqlFragment. Without type information (a
// file linted outside a TypeScript project) only the constants are recognised, and anything else
// is reported.
//
// `passThrough` names the local identifiers a file may hand to query() as the whole statement:
// for the two places in packages/db that pass on text another file wrote (eslint.config.js gives
// each its reason).
//
// Not seen, and left to review: a constant whose own initialiser is built from a value (it has
// to be UPPER_CASE and at module level, where no request exists), `as never`, and query taken
// off the handle before it is called (`const { query } = tx`, `tx.query.bind(tx)`,
// `tx.query.call(tx, text)`, `tx.query.apply(tx, [text])`).
import { AST_NODE_TYPES, TSESLint, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from './create-rule.ts';
import { brandReader } from './typed.ts';

const SQL_FRAGMENT = { symbol: 'sqlFragmentBrand', file: 'packages/db/src/sql.ts' } as const;
const CONSTANT_NAME = /^[A-Z][A-Z0-9_]*$/;

type Options = [{ passThrough?: readonly string[] }];

/** True when a computed member name is the text 'query': `x['query']` or ``x[`query`]``. */
export function isQueryKey(key: TSESTree.Node): boolean {
  if (key.type === AST_NODE_TYPES.Literal) return key.value === 'query';
  return (
    key.type === AST_NODE_TYPES.TemplateLiteral &&
    key.expressions.length === 0 &&
    key.quasis[0]?.value.cooked === 'query'
  );
}

function isQueryCall(node: TSESTree.CallExpression): boolean {
  const callee = node.callee;
  if (callee.type !== AST_NODE_TYPES.MemberExpression) return false;
  return callee.computed
    ? isQueryKey(callee.property)
    : callee.property.type === AST_NODE_TYPES.Identifier && callee.property.name === 'query';
}

/** True when `variable` is a top-level `const` or an import. */
function isModuleConstant(variable: TSESLint.Scope.Variable): boolean {
  const { ScopeType, DefinitionType } = TSESLint.Scope;
  if (variable.scope.type !== ScopeType.module && variable.scope.type !== ScopeType.global) {
    return false;
  }
  return variable.defs.some((definition) => {
    if (definition.type === DefinitionType.ImportBinding) return true;
    return (
      definition.type === DefinitionType.Variable &&
      definition.parent.type === AST_NODE_TYPES.VariableDeclaration &&
      definition.parent.kind === 'const'
    );
  });
}

export default createRule<Options, 'interpolation' | 'statement'>({
  name: 'sql-fragments',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Require the text given to query() to be written in the source: only UPPER_CASE module constants and SqlFragments may be interpolated',
    },
    schema: [
      {
        type: 'object',
        additionalProperties: false,
        properties: {
          passThrough: { type: 'array', items: { type: 'string', minLength: 1 } },
        },
      },
    ],
    defaultOptions: [{}],
    messages: {
      interpolation:
        'SQL text may interpolate only an UPPER_CASE module constant or a SqlFragment, and `{{text}}` is neither. Pass a value as a parameter ($1, $2; see OrgTx in packages/db/src/tx.ts). For fixed text chosen at run time make a SqlFragment with sql`...`, sqlParameter(position) or joinSql(parts, separator) from @tinnox/db (packages/db/src/sql.ts).',
      statement:
        'The statement given to query() must be text from the source: a string literal, a template, an UPPER_CASE module constant or a SqlFragment, and `{{text}}` is none of these. Write the statement at the call and pass values as parameters ($1, $2; see OrgTx in packages/db/src/tx.ts); for fixed text chosen at run time make a SqlFragment with sql`...`, sqlParameter(position) or joinSql(parts, separator) from @tinnox/db (packages/db/src/sql.ts).',
    },
  },
  defaultOptions: [{}],
  create(context, [options]) {
    const isFragment = brandReader(context, SQL_FRAGMENT);
    const passThrough = new Set(options.passThrough ?? []);

    function isConstant(node: TSESTree.Identifier): boolean {
      if (!CONSTANT_NAME.test(node.name)) return false;
      const reference = context.sourceCode
        .getScope(node)
        .references.find((candidate) => candidate.identifier === node);
      const variable = reference?.resolved ?? undefined;
      return variable !== undefined && isModuleConstant(variable);
    }

    /** True when `node` is fixed SQL text by the rules above. */
    function isFixedText(node: TSESTree.Expression): boolean {
      if (node.type === AST_NODE_TYPES.Identifier && isConstant(node)) return true;
      if (isFragment?.(node) === true) return true;
      // A choice between two things that may each be interpolated.
      return (
        node.type === AST_NODE_TYPES.ConditionalExpression &&
        isFixedText(node.consequent) &&
        isFixedText(node.alternate)
      );
    }

    /**
     * True when `node`, as the whole statement, is text from the source: what isFixedText takes,
     * a string literal, a template that interpolates only that, or a choice between two of these
     * (CHK-8: `lock ? 'SELECT ... FOR SHARE' : 'SELECT ...'`, which the message allows).
     */
    function isFixedStatement(node: TSESTree.Expression): boolean {
      if (node.type === AST_NODE_TYPES.Literal) return typeof node.value === 'string';
      if (node.type === AST_NODE_TYPES.TemplateLiteral) {
        return node.expressions.every((expression) => isFixedText(expression));
      }
      if (node.type === AST_NODE_TYPES.ConditionalExpression) {
        return isFixedStatement(node.consequent) && isFixedStatement(node.alternate);
      }
      return isFixedText(node);
    }

    function text(node: TSESTree.Node): string {
      const source = context.sourceCode.getText(node).replace(/\s+/g, ' ');
      return source.length > 60 ? `${source.slice(0, 57)}...` : source;
    }

    function checkTemplate(template: TSESTree.TemplateLiteral): void {
      for (const expression of template.expressions) {
        if (!isFixedText(expression)) {
          context.report({
            node: expression,
            messageId: 'interpolation',
            data: { text: text(expression) },
          });
        }
      }
    }

    return {
      CallExpression(node) {
        if (!isQueryCall(node)) return;
        const statement = node.arguments[0];
        if (statement === undefined || statement.type === AST_NODE_TYPES.SpreadElement) return;
        if (statement.type === AST_NODE_TYPES.TemplateLiteral) {
          checkTemplate(statement);
          return;
        }
        if (statement.type === AST_NODE_TYPES.Literal && typeof statement.value === 'string') {
          return;
        }
        if (statement.type === AST_NODE_TYPES.Identifier && passThrough.has(statement.name)) {
          return;
        }
        if (!isFixedStatement(statement)) {
          context.report({
            node: statement,
            messageId: 'statement',
            data: { text: text(statement) },
          });
        }
      },
      TaggedTemplateExpression(node) {
        if (node.tag.type === AST_NODE_TYPES.Identifier && node.tag.name === 'sql') {
          checkTemplate(node.quasi);
        }
      },
    };
  },
});
