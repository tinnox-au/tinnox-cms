// Which pool each transaction handle was opened on. run() in ./tx.ts records it; asDefiner in
// ./definer.ts reads it. In a file of its own because everything ./tx.ts exports is part of the
// runtime entry (./index.ts), and this is not: no entry of the package exports this module.
import type { Pool } from './pool.ts';

const pools = new WeakMap<object, Pool>();

export function rememberPool(tx: object, pool: Pool): void {
  pools.set(tx, pool);
}

/** The pool `tx` was opened on; undefined for a handle run() did not make. */
export function poolOf(tx: object): Pool | undefined {
  return pools.get(tx);
}
