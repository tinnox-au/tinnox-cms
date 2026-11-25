// fast-check generators for layouts (adoption plan section 4.4, properties 4 and 5).
//
// Choosing a generator: the constraints that matter sit in superRefine checks (checkLayoutZones
// in packages/contracts/src/layout.ts), which no schema-to-generator tool can see, so each
// generator here builds its values to meet them by construction and carries a self-check in
// layout.property.test.ts that its output passes the schema or the database CHECK it stands
// for. A counterexample whose input fails its own self-check is a generator bug, not a product
// bug: fix the generator first.
//
// Two shapes of zone set: what the API's schema accepts (LayoutInputSchema: two to four zones
// that never overlap), and what the database can hold (layout_zone in 0011: up to four rows,
// each inside the square, overlap and any count allowed, D7). The planner must answer the
// second without throwing (LYX-03).
import fc from 'fast-check';
import { ABSOLUTE, LAYOUT_UNITS, type Canvas, type LayoutBox, type Rect } from '@tinnox/contracts';

/** A screen the display schema accepts: its canvas and an optional content rectangle inside it. */
export interface Screen {
  readonly canvas: Canvas;
  readonly contentRect: Rect | null;
}

const side = fc.integer({ min: ABSOLUTE.minCanvasSidePx, max: ABSOLUTE.maxCanvasSidePx });

/** One span of `total`: a start and a length of at least `least`, ending inside it. */
function span(total: number, least: number): fc.Arbitrary<{ start: number; length: number }> {
  return fc
    .integer({ min: least, max: total })
    .chain((length) =>
      fc.integer({ min: 0, max: total - length }).map((start) => ({ start, length })),
    );
}

/** Canvases within CanvasSchema, with no content rectangle or one inside the canvas. */
export const screenArb: fc.Arbitrary<Screen> = fc
  .record({ width: side, height: side })
  .chain((canvas) =>
    fc
      .option(
        fc
          .tuple(
            span(canvas.width, ABSOLUTE.minCanvasSidePx),
            span(canvas.height, ABSOLUTE.minCanvasSidePx),
          )
          .map(([h, v]) => ({ x: h.start, y: v.start, width: h.length, height: v.length })),
        { nil: null },
      )
      .map((contentRect) => ({ canvas, contentRect })),
  );

/** One layout_zone row's rectangle: inside the 10 000 basis-point square (layout_zone_in_bounds). */
export const storedBoxArb: fc.Arbitrary<LayoutBox> = fc
  .tuple(span(LAYOUT_UNITS, 1), span(LAYOUT_UNITS, 1))
  .map(([h, v]) => ({ x: h.start, y: v.start, width: h.length, height: v.length }));

/**
 * What the database can hold for one layout: zero to four zones (the primary key and
 * layout_zone_position_range), each inside the square, overlap allowed.
 */
export const storedZonesArb: fc.Arbitrary<LayoutBox[]> = fc.array(storedBoxArb, {
  minLength: 0,
  maxLength: ABSOLUTE.maxLayoutZones,
});

/** One guillotine cut: which box (modulo the count), which way, and where (modulo the side). */
const cutArb = fc.record({ box: fc.nat(), vertical: fc.boolean(), at: fc.nat() });

/** Splits `box` in two along one axis, or returns null when it is one unit wide that way. */
function cut(box: LayoutBox, vertical: boolean, at: number): [LayoutBox, LayoutBox] | null {
  const extent = vertical ? box.width : box.height;
  if (extent < 2) return null;
  const first = 1 + (at % (extent - 1));
  return vertical
    ? [
        { ...box, width: first },
        { ...box, x: box.x + first, width: box.width - first },
      ]
    : [
        { ...box, height: first },
        { ...box, y: box.y + first, height: box.height - first },
      ];
}

/**
 * What LayoutInputSchema accepts: the whole square cut into two to four boxes by guillotine cuts,
 * so the boxes never overlap and edges are shared. A cut that cannot be made where it was drawn
 * is made on the next box that can take it; with at most four boxes from a 10 000 square one
 * always can.
 */
export const schemaZonesArb: fc.Arbitrary<LayoutBox[]> = fc
  .array(cutArb, { minLength: 1, maxLength: ABSOLUTE.maxLayoutZones - 1 })
  .map((cuts) => {
    let boxes: LayoutBox[] = [{ x: 0, y: 0, width: LAYOUT_UNITS, height: LAYOUT_UNITS }];
    for (const { box, vertical, at } of cuts) {
      for (let tried = 0; tried < boxes.length * 2; tried += 1) {
        const n = (box + Math.floor(tried / 2)) % boxes.length;
        const target = boxes[n];
        const split = target === undefined ? null : cut(target, vertical !== (tried % 2 === 1), at);
        if (split !== null) {
          boxes = [...boxes.slice(0, n), ...split, ...boxes.slice(n + 1)];
          break;
        }
      }
    }
    return boxes;
  });
