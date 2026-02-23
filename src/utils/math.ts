/**
 * Safe math utilities that avoid V8 stack overflow on large arrays.
 *
 * Math.min(...arr) / Math.max(...arr) spread every element as a function
 * argument. V8 has a hard limit of ~65 536 arguments; exceeding it throws
 * "RangeError: Maximum call stack size exceeded". These iterative helpers
 * work on arrays of any length.
 */

/**
 * Return the minimum value in a numeric array (iterative, no spread).
 * Returns `undefined` when the array is empty so callers can provide
 * their own fallback via `?? defaultValue`.
 */
export function safeMin(arr: number[]): number | undefined {
  if (arr.length === 0) return undefined;
  let min = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] < min) min = arr[i];
  }
  return min;
}

/**
 * Return the maximum value in a numeric array (iterative, no spread).
 * Returns `undefined` when the array is empty so callers can provide
 * their own fallback via `?? defaultValue`.
 */
export function safeMax(arr: number[]): number | undefined {
  if (arr.length === 0) return undefined;
  let max = arr[0];
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > max) max = arr[i];
  }
  return max;
}
