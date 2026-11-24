// CU-02 (adoption plan section 2.5): the job directory is a contract between two uids, the API
// and the media worker, and the mode of what is written there must not be left to a umask:
// writeFile's and mkdir's `mode` option is reduced by it, so a 0644 file can come out 0600 and
// the other uid cannot read it. The two exchange-file.ts helpers (apps/api/src/media and
// apps/media-worker/src) write with the mode and set it again with chmod; every other file of
// those folders goes through them.
//
// Four things are refused:
// - a property named `mode` in an object literal (the option of writeFile, mkdir,
//   createWriteStream and open, which is how a mode gets set by hand);
// - a name that writes or creates a file or folder (writeFile, createWriteStream, mkdir, chmod,
//   their Sync forms and the other writers of node:fs), imported from node:fs, or reached
//   through a namespace or default import of it or its `promises` object, which hide the call;
// - an `open` or `openSync` that could create or write a file: a third (mode) argument, a
//   string flag other than 'r' or 'rs', or numeric flags that are not only O_RDONLY, O_NOFOLLOW,
//   O_NONBLOCK and the like (O_CREAT with no mode argument is 0666 cut by the umask);
// - a method call by a writer's name (handle.writeFile, handle.chmod), which is how a FileHandle
//   or any other object writes.
// Reading (open read-only, lstat, readdir), rename and removal stay with the caller.
//
// Not seen, and left to review: a writer taken from a dynamic import or require, a writer
// reached through a module that re-exports node:fs, and an `open` whose flags come from a
// variable (it is refused, since the rule cannot tell what the variable holds).
import { AST_NODE_TYPES, type TSESTree } from '@typescript-eslint/utils';
import { createRule } from './create-rule.ts';

const WRITERS: ReadonlySet<string> = new Set([
  'writeFile',
  'writeFileSync',
  'appendFile',
  'appendFileSync',
  'createWriteStream',
  'mkdir',
  'mkdirSync',
  'mkdtemp',
  'mkdtempSync',
  'chmod',
  'chmodSync',
  'copyFile',
  'copyFileSync',
  'cp',
  'cpSync',
  'link',
  'linkSync',
  'symlink',
  'symlinkSync',
  'truncate',
  'truncateSync',
  'write',
  'writeSync',
  'writev',
  'writevSync',
]);
// A method call by these names is refused. `write` and `writev` are left out: process.stdout
// and every stream have a write method, and a stream to the job directory can only come from
// createWriteStream, which is refused where it is imported.
const WRITER_METHODS: ReadonlySet<string> = new Set(
  [...WRITERS].filter((name) => name !== 'write' && name !== 'writev'),
);
const OPENERS: ReadonlySet<string> = new Set(['open', 'openSync']);
const FILE_MODULES: ReadonlySet<string> = new Set([
  'node:fs',
  'node:fs/promises',
  'fs',
  'fs/promises',
]);
// The string flags and the fs.constants flags that neither create nor write a file.
const READ_FLAGS: ReadonlySet<string> = new Set(['r', 'rs', 'sr']);
const READ_CONSTANTS: ReadonlySet<string> = new Set([
  'O_RDONLY',
  'O_NOFOLLOW',
  'O_NONBLOCK',
  'O_NOATIME',
  'O_DIRECTORY',
  'O_SYNC',
  'O_DSYNC',
  'O_DIRECT',
]);

const nameOf = (node: TSESTree.Identifier | TSESTree.StringLiteral): string =>
  node.type === AST_NODE_TYPES.Identifier ? node.name : node.value;

/** True when an `open` flags argument can be read to neither create nor write. */
function readOnlyFlags(node: TSESTree.Node): boolean {
  if (node.type === AST_NODE_TYPES.Literal) {
    return typeof node.value === 'string' && READ_FLAGS.has(node.value);
  }
  if (node.type === AST_NODE_TYPES.BinaryExpression && node.operator === '|') {
    return readOnlyFlags(node.left) && readOnlyFlags(node.right);
  }
  if (
    node.type === AST_NODE_TYPES.MemberExpression &&
    !node.computed &&
    node.property.type === AST_NODE_TYPES.Identifier
  ) {
    return READ_CONSTANTS.has(node.property.name);
  }
  if (node.type === AST_NODE_TYPES.Identifier) return READ_CONSTANTS.has(node.name);
  return false;
}

export default createRule<[], 'mode' | 'writer' | 'namespace' | 'open'>({
  name: 'exchange-files',
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow a file mode option and direct file writes in the media job directory code; use the exchange-file helper',
    },
    schema: [],
    messages: {
      mode: 'A `mode` option is reduced by the process umask (CU-02), so the other uid may not be able to read what you write. Write the file with publishExchangeFile(tempPath, finalPath, data) or writeExchangeFile(path, data) and a folder with makeExchangeDir(path, mode), all from ./exchange-file.ts, which set the mode again with chmod.',
      writer:
        '{{name}} creates a file or folder in the job directory without the exchange helpers (CU-02): its mode is left to the umask. Use publishExchangeFile(tempPath, finalPath, data), writeExchangeFile(path, data), createExchangeWriteStream(path), shareExchangeFile(path) or makeExchangeDir(path, mode) from ./exchange-file.ts, which set the mode explicitly.',
      namespace:
        'A namespace or default import of {{module}} hides which writer is called, so the rule cannot see it (CU-02). Import the names you read with (open, lstat, readdir, rename) and write through ./exchange-file.ts.',
      open: "{{name}} here may create or write a file whose mode is left to the umask (CU-02). Open only to read, with no mode argument and flags of fsConstants.O_RDONLY (with O_NOFOLLOW or O_NONBLOCK) or a literal 'r', and write through publishExchangeFile(tempPath, finalPath, data) or writeExchangeFile(path, data) from ./exchange-file.ts.",
    },
  },
  defaultOptions: [],
  create(context) {
    // Local names bound to open or openSync of node:fs, so an alias is followed.
    const openers = new Map<string, string>();
    return {
      Property(node) {
        if (node.parent.type !== AST_NODE_TYPES.ObjectExpression) return;
        const key = node.key;
        const named =
          !node.computed && key.type === AST_NODE_TYPES.Identifier
            ? key.name
            : key.type === AST_NODE_TYPES.Literal && typeof key.value === 'string'
              ? key.value
              : null;
        if (named === 'mode') context.report({ node: key, messageId: 'mode' });
      },
      ImportDeclaration(node) {
        const module = String(node.source.value);
        if (!FILE_MODULES.has(module)) return;
        if (node.importKind === 'type') return;
        for (const specifier of node.specifiers) {
          if (specifier.type === AST_NODE_TYPES.ImportSpecifier) {
            if (specifier.importKind === 'type') continue;
            const name = nameOf(specifier.imported);
            if (WRITERS.has(name)) {
              context.report({ node: specifier, messageId: 'writer', data: { name } });
            } else if (name === 'promises') {
              // The promises object of node:fs is the whole of node:fs/promises under one name.
              context.report({
                node: specifier,
                messageId: 'namespace',
                data: { module: `the promises object of ${module}` },
              });
            } else if (OPENERS.has(name)) {
              openers.set(specifier.local.name, name);
            }
          } else {
            context.report({ node: specifier, messageId: 'namespace', data: { module } });
          }
        }
      },
      CallExpression(node) {
        const callee = node.callee;
        if (
          callee.type === AST_NODE_TYPES.MemberExpression &&
          !callee.computed &&
          callee.property.type === AST_NODE_TYPES.Identifier &&
          WRITER_METHODS.has(callee.property.name)
        ) {
          context.report({
            node: callee,
            messageId: 'writer',
            data: { name: context.sourceCode.getText(callee).replace(/\s+/g, ' ') },
          });
          return;
        }
        if (callee.type !== AST_NODE_TYPES.Identifier) return;
        const opener = openers.get(callee.name);
        if (opener === undefined) return;
        const flags = node.arguments[1];
        const reads = node.arguments.length <= 2 && (flags === undefined || readOnlyFlags(flags));
        if (!reads) context.report({ node, messageId: 'open', data: { name: opener } });
      },
    };
  },
});
