import { describe, expect, it } from 'vitest';
import { loadSpecifiers } from './load-specifiers.ts';

describe('loadSpecifiers (LINT-1)', () => {
  it('reads import() with a string or a plain template, and require(), in source order', () => {
    const text = [
      "const a = await import('pg');",
      'const b = await import(`@tinnox/db`);',
      'const c = () => import("./routes/media.ts");',
      "const d = require('node:fs');",
    ].join('\n');
    expect(loadSpecifiers('apps/api/src/x.ts', text)).toEqual([
      'pg',
      '@tinnox/db',
      './routes/media.ts',
      'node:fs',
    ]);
  });

  it('leaves out static imports, which no-restricted-imports already sees', () => {
    const text = "import pg from 'pg';\nexport * from './a.ts';\nimport type { T } from './t.ts';";
    expect(loadSpecifiers('apps/api/src/x.ts', text)).toEqual([]);
  });

  it('leaves out computed specifiers, a template with an expression and other calls', () => {
    const text = [
      'const a = await import(name);',
      'const b = await import(`./pages/${page}.tsx`);',
      "const c = load('pg');",
      "const d = module.require('pg');",
      'const e = require(name);',
    ].join('\n');
    expect(loadSpecifiers('apps/api/src/x.ts', text)).toEqual([]);
  });

  it('does not read a specifier written inside a string or a comment', () => {
    const text = [
      'const fixture = "await import(\'@tinnox/api\')";',
      "// await import('pg')",
      "/* require('node:fs') */",
    ].join('\n');
    expect(loadSpecifiers('scripts/lib/x.test.ts', text)).toEqual([]);
  });

  it('parses JSX in .tsx files and plain JavaScript in .mjs files', () => {
    expect(
      loadSpecifiers(
        'apps/portal/src/App.tsx',
        "const Page = lazy(() => import('./features/Page.tsx'));\nexport const x = <Page />;",
      ),
    ).toEqual(['./features/Page.tsx']);
    expect(
      loadSpecifiers('scripts/x.mjs', "const { createHash } = await import('node:crypto');"),
    ).toEqual(['node:crypto']);
  });
});
