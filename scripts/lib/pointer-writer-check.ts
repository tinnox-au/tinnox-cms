// One writer of a display's desired publication (D10, P2-05; adoption plan step 33). A display's
// `display_delivery.desired_publication_id` may change only in a transaction that inserts a
// publication for that display, and then equals it: createPublication in
// apps/api/src/publishing.ts writes both in one transaction, and publish and push reach the
// pointer only through it. There is no database constraint (a trigger would have to prove
// "inserted in this transaction"): this scan and the desired-pointer table of
// apps/api/test/commit-outcome.integration.test.ts hold the rule instead. Read by
// scripts/lib/pointer-writer-check.test.ts over every tracked file.
//
// What the scan sees: every INSERT, UPDATE or MERGE whose target is display_delivery, in
// TypeScript, JavaScript, shell and SQL text (migrations and the sec.* functions they define
// included), from its keyword to the end of the statement (a semicolon outside a comment or
// string, or the end of the template literal); its comments write nothing and open no string.
// It flags one that names desired_publication_id or desired_at where a column is written: in an INSERT's column list (MERGE's included), or as the target of an
// assignment in a SET list (UPDATE, ON CONFLICT DO UPDATE, MERGE's UPDATE). A mention in a
// condition, a RETURNING list or the value of an assignment reads the column and is left alone.
// It also flags an INSERT with no column list, which could write every column. It cannot see a
// table or column name built at run time, nor a column list composed from a separate fragment.
//
// Test code is not scanned: a test arranges a delivery row as it needs (a pointer to a
// publication it inserted itself, as packages/db/test/support.ts does), and judging that is the
// test's business. The development seed and every other offline tool are scanned like product
// code: the seed writes no delivery row today.

/** The one file that may name the pointer in a write on display_delivery (D10). */
export const POINTER_WRITER = 'apps/api/src/publishing.ts';

const SCANNED = /\.(?:[cm]?[jt]sx?|sql|sh)$/;
/** A test file by its name, or a file in a folder of tests or test fixtures. */
const TEST_CODE = /\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)(?:tests?|test-fixtures)\//;

/** Whether the scan reads `path` (a path from the repository root, with forward slashes). */
export function isScanned(path: string): boolean {
  return SCANNED.test(path) && !TEST_CODE.test(path);
}

// Put together from parts, so this file holds no statement the scan would find in itself.
const TABLE = String.raw`(?:public\.)?"?display_delivery"?\b`;
const WRITE = new RegExp(
  String.raw`\b(INSERT\s+INTO|UPDATE(?:\s+ONLY)?|MERGE\s+INTO)\s+${TABLE}`,
  'gi',
);
const POINTER = /\bdesired_(?:publication_id|at)\b/i;
// After an INSERT's target: an optional alias, then the column list.
const COLUMN_LIST = /^(?:\s+(?:AS\s+)?(?!VALUES\b|SELECT\b|DEFAULT\b|OVERRIDING\b)\w+)?\s*\(/i;

/** One write on display_delivery that `text` holds. */
export interface DeliveryWrite {
  /** 1-based line of the statement's keyword. */
  readonly line: number;
  readonly statement: string;
  /** Whether it names the pointer, or could write it (an INSERT with no column list). */
  readonly namesPointer: boolean;
}

/**
 * `sql` with every comment (a line comment to the end of its line, and a block comment, nested as
 * PostgreSQL nests them) blanked out, and every string too when `strings` is set, the length and the line breaks
 * kept. A comment is blanked first, so an apostrophe in it ("the screen's pointer") opens no
 * string, and a semicolon in either ends no statement. Pure.
 */
function blankComments(sql: string, strings = false): string {
  let out = '';
  // By UTF-16 unit, as the indexes of `sql` count.
  for (let i = 0; i < sql.length;) {
    const two = sql.slice(i, i + 2);
    let end = i + 1;
    let blank = false;
    if (two === '--') {
      end = sql.indexOf('\n', i);
      if (end < 0) end = sql.length;
      blank = true;
    } else if (two === '/*') {
      let depth = 0;
      end = i;
      do {
        const pair = sql.slice(end, end + 2);
        if (pair === '/*') depth += 1;
        else if (pair === '*/') depth -= 1;
        end += pair === '/*' || pair === '*/' ? 2 : 1;
      } while (depth > 0 && end < sql.length);
      blank = true;
    } else if (sql.charAt(i) === "'") {
      // A doubled quote inside a string closes it and opens the next: the same blanks.
      const close = sql.indexOf("'", i + 1);
      end = close < 0 ? sql.length : close + 1;
      blank = strings;
    }
    const part = sql.slice(i, end);
    out += blank ? part.replace(/[^\n]/g, ' ') : part;
    i = end;
  }
  return out;
}

/**
 * `sql`, its comments blanked, with the inside of every parenthesis and string blanked out too,
 * the length kept: what is left is the statement's own level, where its keywords, lists and
 * commas are. Pure.
 */
function topLevel(sql: string): string {
  let depth = 0;
  let out = '';
  const flat = blankComments(sql, true);
  // By UTF-16 unit, as the indexes of `sql` count.
  for (let i = 0; i < flat.length; i += 1) {
    const char = flat.charAt(i);
    if (char === '(') {
      out += depth === 0 ? char : ' ';
      depth += 1;
    } else if (char === ')') {
      depth = Math.max(0, depth - 1);
      out += depth === 0 ? char : ' ';
    } else {
      out += depth === 0 ? char : ' ';
    }
  }
  return out;
}

/** The text between the parenthesis that opens at `open` of `flat` and the one closing it. */
function insideParens(sql: string, flat: string, open: number): string {
  const close = flat.indexOf(')', open);
  return sql.slice(open + 1, close < 0 ? sql.length : close);
}

/**
 * The columns `statement` writes, as text: its INSERT column lists and the targets of its SET
 * lists, and whether it has an INSERT with no column list. Pure.
 */
function writtenColumns(raw: string, keyword: string, targetEnd: number) {
  // Columns are read with the comments blanked, so a comment naming the pointer writes nothing.
  const statement = blankComments(raw);
  const flat = topLevel(statement);
  const columns: string[] = [];
  let noColumnList = false;
  // The column list of the INSERT itself, after its target and an optional alias.
  if (keyword.startsWith('INSERT')) {
    if (COLUMN_LIST.test(statement.slice(targetEnd))) {
      columns.push(insideParens(statement, flat, flat.indexOf('(', targetEnd)));
    } else {
      noColumnList = true;
    }
  }
  // The INSERT branches of a MERGE.
  if (keyword.startsWith('MERGE')) {
    for (const insert of flat.slice(targetEnd).matchAll(/\bINSERT\b\s*(\()?/gi)) {
      const at = targetEnd + insert.index + insert[0].length - 1;
      if (insert[1] === undefined) noColumnList = true;
      else columns.push(insideParens(statement, flat, at));
    }
  }
  // Every SET list, to the clause that ends it; of each assignment, its target. WHEN ends one
  // only in a MERGE: elsewhere it is a CASE inside the value.
  const ends = keyword.startsWith('MERGE')
    ? /\b(?:FROM|WHERE|RETURNING|WHEN)\b/i
    : /\b(?:FROM|WHERE|RETURNING)\b/i;
  for (const set of flat.matchAll(/\bSET\b/gi)) {
    const from = set.index + set[0].length;
    const stop = flat.slice(from).search(ends);
    const to = stop < 0 ? flat.length : from + stop;
    const commas = [...flat.slice(from, to).matchAll(/,/g)].map((comma) => from + comma.index);
    let item = from;
    for (const itemEnd of [...commas, to]) {
      const equals = flat.indexOf('=', item);
      columns.push(statement.slice(item, equals < 0 || equals > itemEnd ? itemEnd : equals));
      item = itemEnd + 1;
    }
  }
  return { columns, noColumnList };
}

/** Every INSERT, UPDATE and MERGE on display_delivery in `text`. Pure. */
export function deliveryWrites(text: string): DeliveryWrite[] {
  const writes: DeliveryWrite[] = [];
  for (const match of text.matchAll(WRITE)) {
    const start = match.index;
    // To the end of the template literal it is in, if any, then to its first semicolon outside a
    // comment or string.
    const literal = text.indexOf('`', start);
    const rest = text.slice(start, literal < 0 ? text.length : literal);
    const end = blankComments(rest, true).indexOf(';');
    const statement = end < 0 ? rest : rest.slice(0, end);
    const keyword = (match[1] ?? '').toUpperCase();
    const { columns, noColumnList } = writtenColumns(statement, keyword, match[0].length);
    writes.push({
      line: text.slice(0, start).split('\n').length,
      statement,
      namesPointer: noColumnList || columns.some((column) => POINTER.test(column)),
    });
  }
  return writes;
}

/** One problem per write that names the pointer outside POINTER_WRITER. Pure. */
export function pointerWriterProblems(
  files: readonly { readonly path: string; readonly text: string }[],
): string[] {
  return files.flatMap(({ path, text }) =>
    path === POINTER_WRITER || !isScanned(path)
      ? []
      : deliveryWrites(text)
          .filter((write) => write.namesPointer)
          .map(
            (write) =>
              `${path}:${String(write.line)}: this write on display_delivery names desired_publication_id or desired_at (or, an INSERT with no column list, could write them). Only createPublication in ${POINTER_WRITER} moves a display's pointer, in the transaction that inserts the publication it points to (D10, P2-05): reach it through publish or push (POST /api/playlists/:id/publish, POST /api/push), and leave the two columns out of every other write.`,
          ),
  );
}
