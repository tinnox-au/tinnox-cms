// AG-2.3: the organisation comes from the verified session or the device credential, never from
// the request. Every exported schema and every route pattern is walked, so a new request schema
// with an organisation id fails here without anyone listing it (adoption plan section 3.2).
import { describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as contracts from './index.ts';

/** orgId, org_id, organisationId, organization_id, x-org-id, in any case. */
const ORG_KEY = /^(x-)?org(ani[sz]ation)?[-_]?id$/i;

/** Every object key anywhere inside `schema`. */
function keysOf(schema: z.ZodType, seen = new Set<z.ZodType>()): string[] {
  if (seen.has(schema)) return [];
  seen.add(schema);
  const inner = (child: unknown): string[] =>
    child instanceof z.ZodType ? keysOf(child, seen) : [];
  const def = schema._zod.def;
  // Every kind is named, so a kind zod adds later fails lint here until the walk reads it.
  switch (def.type) {
    case 'object':
      return schema instanceof z.ZodObject
        ? [
            ...Object.entries(schema.shape).flatMap(([key, child]) => [key, ...inner(child)]),
            ...inner(schema.def.catchall),
          ]
        : unread(def.type);
    case 'array':
      return schema instanceof z.ZodArray ? inner(schema.element) : unread(def.type);
    case 'union':
      return schema instanceof z.ZodUnion ? schema.options.flatMap(inner) : unread(def.type);
    case 'intersection':
      return schema instanceof z.ZodIntersection
        ? [...inner(schema.def.left), ...inner(schema.def.right)]
        : unread(def.type);
    case 'optional':
    case 'nullable':
    case 'default':
    case 'prefault':
    case 'nonoptional':
    case 'readonly':
    case 'catch':
    case 'promise':
      return 'innerType' in def ? inner(def.innerType) : unread(def.type);
    case 'pipe':
      return schema instanceof z.ZodPipe
        ? [...inner(schema.in), ...inner(schema.out)]
        : unread(def.type);
    case 'record':
    case 'map':
      return 'keyType' in def && 'valueType' in def
        ? [...inner(def.keyType), ...inner(def.valueType)]
        : unread(def.type);
    case 'set':
      return 'valueType' in def ? inner(def.valueType) : unread(def.type);
    case 'tuple':
      return schema instanceof z.ZodTuple
        ? [...schema.def.items.flatMap(inner), ...inner(schema.def.rest)]
        : unread(def.type);
    case 'lazy':
      return schema instanceof z.ZodLazy ? inner(schema.def.getter()) : unread(def.type);
    case 'any':
    case 'bigint':
    case 'boolean':
    case 'custom':
    case 'date':
    case 'enum':
    case 'file':
    case 'function':
    case 'int':
    case 'literal':
    case 'nan':
    case 'never':
    case 'null':
    case 'number':
    case 'string':
    case 'success':
    case 'symbol':
    case 'template_literal':
    case 'transform':
    case 'undefined':
    case 'unknown':
    case 'void':
      // Hold no keys.
      return [];
  }
}

function unread(type: string): never {
  throw new Error(`the walk could not read a zod ${type} schema`);
}

const schemas = Object.entries(contracts).flatMap(([name, value]) =>
  value instanceof z.ZodType ? [{ name, schema: value }] : [],
);

describe('no organisation id from the request (AG-2.3)', () => {
  it('finds a key at any depth, through arrays, unions, optionals, pipes and records', () => {
    const nested = z.object({
      items: z
        .array(z.union([z.object({ a: z.string() }), z.object({ org_id: z.string() })]))
        .optional(),
      meta: z
        .string()
        .transform((s) => s.length)
        .pipe(z.number()),
      tags: z.record(z.string(), z.object({ organisationId: z.string() })),
    });
    expect(
      keysOf(nested)
        .filter((key) => ORG_KEY.test(key))
        .sort(),
    ).toEqual(['org_id', 'organisationId']);
  });

  it('reads the exported schemas (a broken walk would pass the next test vacuously)', () => {
    expect(schemas.length).toBeGreaterThan(100);
    expect(keysOf(contracts.PairingClaimRequestSchema)).toContain('code');
  });

  it('no request schema carries an organisation id; only the pairing poll answer does', () => {
    const carrying = schemas
      .filter(({ schema }) => keysOf(schema).some((key) => ORG_KEY.test(key)))
      .map(({ name }) => name);
    // The player learns its organisation from the claimed poll answer; it is sent by the API,
    // never read from a request. A name added here must be an answer too.
    expect(carrying).toEqual(['PairingPollResponseSchema']);
  });

  it('no route pattern has an organisation parameter', () => {
    const params: string[] = [];
    for (const value of Object.values(contracts.ROUTES)) {
      if (typeof value !== 'string') continue;
      for (const match of value.matchAll(/:([A-Za-z_]+)/g)) params.push(match[1] ?? '');
    }
    expect(params).toContain('id');
    expect(params.filter((param) => ORG_KEY.test(param))).toEqual([]);
  });
});
