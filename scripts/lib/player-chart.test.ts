import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { repoRoot } from './env.ts';
import {
  CHART_END,
  CHART_START,
  PROTOCOL_PATH,
  TABLE_PATH,
  checkPlayerChart,
  playerStateChart,
  transitionTableOf,
  withChart,
} from './player-chart.ts';

const MACHINE = [
  "export const PHASES = ['off', 'on', 'broken'] as const;",
  '// Not the table: another constant of the file.',
  "const OTHER = { off: { SWITCH: 'nowhere' } };",
  'const TABLE: Table = {',
  "  off: { SWITCH: 'on' },",
  '  on: {',
  "    SWITCH: 'off',",
  "    TICK: 'on',",
  "    'TOCK': 'on',",
  '    // A comment inside the table.',
  "    BREAK: 'broken',",
  '  },',
  '  broken: {},',
  '};',
  'export const use = [OTHER, TABLE];',
  '',
].join('\n');

const CHART = [
  '```mermaid',
  'stateDiagram-v2',
  '    off --> on: SWITCH',
  '    on --> off: SWITCH',
  '    on --> on: TICK, TOCK',
  '    on --> broken: BREAK',
  '    broken',
  '```',
].join('\n');

const doc = (between: string): string =>
  `# Protocol\n\n${CHART_START}${between}${CHART_END}\n\nMore.\n`;
const written = withChart(doc('\n'), CHART) ?? '';

describe('the state chart of the player protocol (adoption plan 4.7, step 32)', () => {
  it('reads the table from the source text and draws one arrow per pair of phases, with every event that makes the change', () => {
    const read = transitionTableOf(MACHINE);
    expect(read).toEqual({
      ok: true,
      table: {
        off: { SWITCH: 'on' },
        on: { SWITCH: 'off', TICK: 'on', TOCK: 'on', BREAK: 'broken' },
        broken: {},
      },
    });
    if (read.ok) expect(playerStateChart(read.table)).toBe(CHART);
  });

  it('passes on what --write writes, and writing twice changes nothing', () => {
    expect(written).toContain(`${CHART_START}\n\n${CHART}\n\n${CHART_END}`);
    expect(written).toContain('More.');
    expect(checkPlayerChart(written, MACHINE)).toEqual([]);
    expect(withChart(written, CHART)).toBe(written);
  });

  it('reports a chart the table no longer gives, at the chart’s line, with the command that writes it', () => {
    for (const changed of [
      MACHINE.replace('broken: {},', "broken: { REPAIR: 'off' },"),
      MACHINE.replace("TICK: 'on',", "TICK: 'off',"),
      MACHINE.replace("    BREAK: 'broken',\n", ''),
    ]) {
      const findings = checkPlayerChart(written, changed);
      expect(findings, changed).toHaveLength(1);
      expect(findings[0], changed).toMatch(/^docs\/player-protocol-v1\.md:3 /);
      expect(findings[0], changed).toContain('npm run check:docs -- --write');
    }
    // A chart edited by hand is as stale as a table that moved on.
    expect(checkPlayerChart(written.replace('TICK, TOCK', 'TICK'), MACHINE)).toHaveLength(1);
  });

  it('reports a table it cannot read, with the line and the shape to keep, and never draws a partial chart', () => {
    const unreadable: [string, RegExp][] = [
      [
        MACHINE.replace('const TABLE:', 'const RULES:'),
        /machine\.ts:1 the transition table was not found/,
      ],
      [
        MACHINE.replace('  broken: {},', '  ...OTHER,'),
        /machine\.ts:13 a phase of the transition table/,
      ],
      [
        MACHINE.replace('  broken: {},', '  broken: OTHER,'),
        /machine\.ts:13 a phase of the transition table/,
      ],
      [MACHINE.replace("TICK: 'on',", 'TICK: next,'), /machine\.ts:8 a transition of phase on/],
      [MACHINE.replace("TICK: 'on',", "[key]: 'on',"), /machine\.ts:8 a transition of phase on/],
      [
        MACHINE.replace("TICK: 'on',", "TICK: 'gone',"),
        /phase on leads to gone, which the table does not list/,
      ],
    ];
    for (const [source, message] of unreadable) {
      const findings = checkPlayerChart(written, source);
      expect(findings, source).toHaveLength(1);
      expect(findings[0], source).toMatch(message);
      expect(findings[0], source).toContain('scripts/lib/player-chart.ts');
    }
  });

  it('reports missing, repeated or swapped marker lines, and a missing file', () => {
    for (const broken of [
      '# Protocol\n',
      `${CHART_START}\n`,
      `${CHART_END}\n${CHART_START}\n`,
      `${doc('\n')}${doc('\n')}`,
    ]) {
      expect(withChart(broken, CHART), broken).toBeNull();
      const findings = checkPlayerChart(broken, MACHINE);
      expect(findings, broken).toHaveLength(1);
      expect(findings[0], broken).toContain('marker lines');
    }
    expect(checkPlayerChart(undefined, MACHINE)[0]).toMatch(
      /^docs\/player-protocol-v1\.md:1 .* missing/,
    );
    expect(checkPlayerChart(written, undefined)[0]).toMatch(/machine\.ts:1 .* missing/);
  });

  // The same comparison as `npm run check:docs`, so `npm test` alone also fails on a table
  // changed without the chart.
  it('the committed protocol holds the chart of the player’s own table, every phase of it', () => {
    const protocol = readFileSync(join(repoRoot, PROTOCOL_PATH), 'utf8');
    const machine = readFileSync(join(repoRoot, TABLE_PATH), 'utf8');
    expect(checkPlayerChart(protocol, machine)).toEqual([]);
    const read = transitionTableOf(machine);
    expect(read.ok).toBe(true);
    if (!read.ok) return;
    // The phases the file declares, read as text for the same reason as the table.
    const declared = /PLAYER_PHASES = \[([^\]]+)\]/.exec(machine)?.[1]?.match(/'(\w+)'/g) ?? [];
    expect(Object.keys(read.table).map((phase) => `'${phase}'`)).toEqual(declared);
    expect(declared.length).toBeGreaterThan(0);
    const chart = playerStateChart(read.table);
    expect(chart).toContain('    pairing --> idle: PAIRED');
    expect(chart).toContain('    resetting\n');
  });
});
