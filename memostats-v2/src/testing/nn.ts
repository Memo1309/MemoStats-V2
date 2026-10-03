/** Test helper: asserts a value is present (strict lint forbids non-null assertions). */
export function nn<T>(value: T | null | undefined, label = 'value'): T {
  if (value === null || value === undefined) throw new Error(`expected ${label} to be present`);
  return value;
}
