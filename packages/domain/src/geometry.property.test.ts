import fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { ABSOLUTE, rectsOverlap, type LayoutBox, type Rect } from '@tinnox/contracts';
import { effectiveContentRect, fitRect, zoneRect, type FloatRect } from './geometry.ts';
import { schemaZonesArb, screenArb, storedBoxArb } from './layout.test-support.ts';

// Adoption plan section 4.4, properties 4 and 6, and D11: every run draws a fresh seed, and a
// failure prints the seed and the shrunk counterexample. A counterexample is committed below as
// a plain example test with its fix, never as a seed or path. The generators of layouts and
// screens, and their self-checks, are those of layout.test-support.ts and layout.property.test.ts.

function inside(rect: Rect, area: Rect): boolean {
  return (
    rect.width >= 0 &&
    rect.height >= 0 &&
    rect.x >= area.x &&
    rect.y >= area.y &&
    rect.x + rect.width <= area.x + area.width &&
    rect.y + rect.height <= area.y + area.height
  );
}

/** The pairs of zones in which `a`'s right (or bottom) edge is `b`'s left (or top) edge. */
function sharedEdges(zones: readonly LayoutBox[]): { a: number; b: number; axis: 'x' | 'y' }[] {
  const edges: { a: number; b: number; axis: 'x' | 'y' }[] = [];
  zones.forEach((za, a) =>
    zones.forEach((zb, b) => {
      if (za.x + za.width === zb.x) edges.push({ a, b, axis: 'x' });
      if (za.y + za.height === zb.y) edges.push({ a, b, axis: 'y' });
    }),
  );
  return edges;
}

describe('zoneRect: properties (property 4)', () => {
  it('any stored zone resolves to a rectangle of non-negative size inside the area', () => {
    fc.assert(
      fc.property(screenArb, storedBoxArb, ({ canvas, contentRect }, zone) => {
        const area = effectiveContentRect(canvas, contentRect);
        expect(inside(zoneRect(area, zone), area)).toBe(true);
      }),
    );
  });

  it('zones the schema accepts never overlap in pixels, share their shared edges, and fill the area', () => {
    fc.assert(
      fc.property(screenArb, schemaZonesArb, ({ canvas, contentRect }, zones) => {
        const area = effectiveContentRect(canvas, contentRect);
        const rects = zones.map((zone) => zoneRect(area, zone));
        rects.forEach((rect, n) => {
          expect(inside(rect, area)).toBe(true);
          for (const other of rects.slice(0, n)) expect(rectsOverlap(rect, other)).toBe(false);
        });
        for (const { a, b, axis } of sharedEdges(zones)) {
          const [ra, rb] = [rects[a], rects[b]];
          if (ra === undefined || rb === undefined) throw new Error('unreachable');
          if (axis === 'x') expect(ra.x + ra.width).toBe(rb.x);
          else expect(ra.y + ra.height).toBe(rb.y);
        }
        // The cuts tile the whole square, so the pixels tile the whole area: no gap.
        const total = rects.reduce((sum, r) => sum + r.width * r.height, 0);
        expect(total).toBe(area.width * area.height);
      }),
    );
  });
});

const sideArb = fc.integer({ min: 1, max: ABSOLUTE.maxCanvasSidePx });
const frameArb: fc.Arbitrary<FloatRect> = fc.record({
  x: fc.integer({ min: 0, max: ABSOLUTE.maxCanvasSidePx }),
  y: fc.integer({ min: 0, max: ABSOLUTE.maxCanvasSidePx }),
  width: sideArb,
  height: sideArb,
});

/** Equal within a relative 1e-9: the placements are doubles. */
function close(a: number, b: number): boolean {
  return Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a), Math.abs(b));
}
const atMost = (a: number, b: number) => a <= b || close(a, b);

describe('fitRect: properties (property 6)', () => {
  it('contain keeps the whole source inside the frame, touching it on one axis, aspect kept', () => {
    fc.assert(
      fc.property(fc.record({ width: sideArb, height: sideArb }), frameArb, (source, frame) => {
        const { dest, visible, clip, sourceCrop } = fitRect(source, frame, 'contain');
        expect(atMost(frame.x, dest.x) && atMost(frame.y, dest.y)).toBe(true);
        expect(atMost(dest.x + dest.width, frame.x + frame.width)).toBe(true);
        expect(atMost(dest.y + dest.height, frame.y + frame.height)).toBe(true);
        expect(close(dest.width, frame.width) || close(dest.height, frame.height)).toBe(true);
        expect(close(dest.width * source.height, dest.height * source.width)).toBe(true);
        expect([visible, clip, sourceCrop]).toEqual([
          dest,
          frame,
          { x: 0, y: 0, width: source.width, height: source.height },
        ]);
      }),
    );
  });

  it('cover fills the frame, overflowing it on one axis only, aspect kept, crop inside the source', () => {
    fc.assert(
      fc.property(fc.record({ width: sideArb, height: sideArb }), frameArb, (source, frame) => {
        const { dest, visible, clip, sourceCrop } = fitRect(source, frame, 'cover');
        expect(atMost(dest.x, frame.x) && atMost(dest.y, frame.y)).toBe(true);
        expect(atMost(frame.x + frame.width, dest.x + dest.width)).toBe(true);
        expect(atMost(frame.y + frame.height, dest.y + dest.height)).toBe(true);
        expect(close(dest.width, frame.width) || close(dest.height, frame.height)).toBe(true);
        expect(close(dest.width * source.height, dest.height * source.width)).toBe(true);
        expect([visible, clip]).toEqual([frame, frame]);
        expect(atMost(0, sourceCrop.x) && atMost(0, sourceCrop.y)).toBe(true);
        expect(atMost(sourceCrop.x + sourceCrop.width, source.width)).toBe(true);
        expect(atMost(sourceCrop.y + sourceCrop.height, source.height)).toBe(true);
        expect(close(sourceCrop.width * frame.height, sourceCrop.height * frame.width)).toBe(true);
      }),
    );
  });
});
