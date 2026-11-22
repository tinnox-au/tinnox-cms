/**
 * The field `name` of a thrown value, or undefined when it is not an object (or a function) or
 * has no such field. Thrown values are `unknown`; this reads a driver's `code` or `constraint`
 * without a cast to an inline object type, which lint refuses (adoption plan section 3.2).
 * It lives here because packages/db imports no other @tinnox package, and the API and the scripts
 * both import @tinnox/db.
 */
export function errorField(error: unknown, name: string): unknown {
  const hasFields = (typeof error === 'object' && error !== null) || typeof error === 'function';
  // Reflect.get reads like `error[name]`: own or inherited, through a getter if there is one.
  return hasFields ? Reflect.get(error, name) : undefined;
}
