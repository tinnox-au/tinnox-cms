// The state chart of the player's phases in docs/player-protocol-v1.md, generated from the
// transition table of apps/player-web/src/core/machine.ts so that the document cannot drift
// from the code (adoption plan section 4.7 and step 32). scripts/check-docs.ts writes it with
// --write and reports a stale one otherwise.
//
// The table is read from the source text, not imported: scripts/ may not import an app
// (IMPORT_LAYERS in eslint.config.js), and the player is bundled for a browser. So the table
// has to stay one object literal of plain keys and string values, and a shape this does not
// read is a finding that says so, never a chart with a transition missing.
import ts from 'typescript';

export const PROTOCOL_PATH = 'docs/player-protocol-v1.md';
export const TABLE_PATH = 'apps/player-web/src/core/machine.ts';
/** The name of the table in that file. */
const TABLE_NAME = 'TABLE';

/** A transition table: for each phase, the phase each allowed event leads to. */
export type TransitionTable = Readonly<Record<string, Readonly<Record<string, string>>>>;

export const CHART_START =
  '<!-- player-state-chart:start (generated from the transition table in apps/player-web/src/core/machine.ts by `npm run check:docs -- --write`; do not edit by hand) -->';
export const CHART_END = '<!-- player-state-chart:end -->';

const WRITE_HINT = `run \`npm run check:docs -- --write\`, which writes the chart from ${TABLE_NAME} in ${TABLE_PATH}`;

const SHAPE_HINT = `keep \`const ${TABLE_NAME} = { phase: { EVENT: 'phase' } }\` in ${TABLE_PATH} one object literal of plain keys and string values (no spread, computed key or variable), or teach transitionTableOf in scripts/lib/player-chart.ts the new shape`;

export type TableRead =
  | { readonly ok: true; readonly table: TransitionTable }
  | { readonly ok: false; readonly finding: string };

function keyOf(name: ts.PropertyName): string | null {
  return ts.isIdentifier(name) || ts.isStringLiteral(name) ? name.text : null;
}

/**
 * The transition table written in the player's machine.ts, or a finding that says why it could
 * not be read.
 * @param source the text of apps/player-web/src/core/machine.ts
 */
export function transitionTableOf(source: string): TableRead {
  const file = ts.createSourceFile(TABLE_PATH, source, ts.ScriptTarget.Latest, true);
  const unread = (node: ts.Node | null, what: string): TableRead => {
    const line =
      node === null ? 1 : file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1;
    return { ok: false, finding: `${TABLE_PATH}:${String(line)} ${what}; ${SHAPE_HINT}` };
  };
  let literal: ts.Expression | undefined;
  for (const statement of file.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    for (const declaration of statement.declarationList.declarations) {
      if (ts.isIdentifier(declaration.name) && declaration.name.text === TABLE_NAME) {
        literal = declaration.initializer;
      }
    }
  }
  if (literal === undefined || !ts.isObjectLiteralExpression(literal)) {
    return unread(null, 'the transition table was not found');
  }
  const table: Record<string, Record<string, string>> = {};
  for (const phase of literal.properties) {
    if (!ts.isPropertyAssignment(phase) || !ts.isObjectLiteralExpression(phase.initializer)) {
      return unread(phase, 'a phase of the transition table could not be read');
    }
    const name = keyOf(phase.name);
    if (name === null) return unread(phase, 'a phase of the transition table could not be read');
    const events: Record<string, string> = {};
    for (const event of phase.initializer.properties) {
      if (!ts.isPropertyAssignment(event) || !ts.isStringLiteralLike(event.initializer)) {
        return unread(event, `a transition of phase ${name} could not be read`);
      }
      const key = keyOf(event.name);
      if (key === null) return unread(event, `a transition of phase ${name} could not be read`);
      events[key] = event.initializer.text;
    }
    table[name] = events;
  }
  // The type checker refuses an arrow to a phase that does not exist; said here too, so the
  // chart never shows one whatever the table's type becomes.
  for (const [phase, events] of Object.entries(table)) {
    for (const target of Object.values(events)) {
      if (!Object.hasOwn(table, target)) {
        return unread(null, `phase ${phase} leads to ${target}, which the table does not list`);
      }
    }
  }
  return { ok: true, table };
}

/**
 * The chart as a Mermaid state diagram: one arrow per pair of phases, labelled with every event
 * that makes the change, in the table's own order. A phase that nothing leaves is listed alone.
 */
export function playerStateChart(table: TransitionTable): string {
  const lines = ['```mermaid', 'stateDiagram-v2'];
  for (const [phase, events] of Object.entries(table)) {
    const byTarget = new Map<string, string[]>();
    for (const [event, target] of Object.entries(events)) {
      byTarget.set(target, [...(byTarget.get(target) ?? []), event]);
    }
    if (byTarget.size === 0) lines.push(`    ${phase}`);
    for (const [target, names] of byTarget) {
      lines.push(`    ${phase} --> ${target}: ${names.join(', ')}`);
    }
  }
  lines.push('```');
  return lines.join('\n');
}

function markers(doc: string): { start: number; end: number } | null {
  const start = doc.indexOf(CHART_START);
  const end = doc.indexOf(CHART_END);
  if (start === -1 || end === -1 || end < start) return null;
  if (doc.indexOf(CHART_START, start + 1) !== -1 || doc.indexOf(CHART_END, end + 1) !== -1) {
    return null;
  }
  return { start, end };
}

/** The document with the chart between its two marker lines; null when the markers are not there once each, in order. */
export function withChart(doc: string, chart: string): string | null {
  const at = markers(doc);
  if (at === null) return null;
  return `${doc.slice(0, at.start)}${CHART_START}\n\n${chart}\n\n${doc.slice(at.end)}`;
}

/**
 * Findings when the document's chart is not the one the player's table gives.
 * @param doc the text of docs/player-protocol-v1.md, undefined when the file is missing
 * @param source the text of apps/player-web/src/core/machine.ts, undefined when it is missing
 */
export function checkPlayerChart(doc: string | undefined, source: string | undefined): string[] {
  if (source === undefined) {
    return [
      `${TABLE_PATH}:1 the player's state machine is missing, and the state chart of ${PROTOCOL_PATH} is generated from it; restore the file, or move TABLE_PATH in scripts/lib/player-chart.ts with it`,
    ];
  }
  if (doc === undefined) {
    return [
      `${PROTOCOL_PATH}:1 the player protocol is missing, and with it the state chart generated from ${TABLE_PATH}; restore the document, or move PROTOCOL_PATH in scripts/lib/player-chart.ts with it`,
    ];
  }
  const read = transitionTableOf(source);
  if (!read.ok) return [read.finding];
  const expected = withChart(doc, playerStateChart(read.table));
  if (expected === null) {
    return [
      `${PROTOCOL_PATH}:1 the state chart's marker lines are missing, repeated or out of order; put the two lines "${CHART_START}" and "${CHART_END}" back once each, in that order, where the chart belongs, then ${WRITE_HINT}`,
    ];
  }
  if (expected === doc) return [];
  const line = doc.slice(0, doc.indexOf(CHART_START)).split('\n').length;
  return [
    `${PROTOCOL_PATH}:${String(line)} the state chart of the player's phases differs from the transition table; ${WRITE_HINT}`,
  ];
}
