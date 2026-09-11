/**
 * Loading the pricing core, and reading back out of it.
 *
 * The Rust crate compiles to `wasm32-unknown-unknown` with a plain C ABI: no
 * wasm-bindgen, no glue, no allocator on the JS side. That keeps the module
 * small and, more importantly, keeps the arithmetic identical to the native
 * build (PRD 7.1) — there is no marshalling layer that could round a value on
 * the way past.
 *
 * The cost is that this file has to do the marshalling by hand, which is what
 * everything below is.
 */

/** The exports the crate's `ffi.rs` declares. Hand-written, not generated. */
export interface PricingExports {
  readonly memory: WebAssembly.Memory;

  pc_price(s: number, k: number, t: number, r: number, q: number, v: number, isCall: number): number;
  pc_greek(
    s: number, k: number, t: number, r: number, q: number, v: number,
    isCall: number, which: number,
  ): number;
  pc_american_fast(
    s: number, k: number, t: number, r: number, q: number, v: number, isCall: number,
  ): number;
  pc_american_exact(
    s: number, k: number, t: number, r: number, q: number, v: number, isCall: number,
  ): number;
  pc_american_detail(
    s: number, k: number, t: number, r: number, q: number, v: number, isCall: number,
  ): number;
  pc_implied_vol(
    s: number, k: number, t: number, r: number, q: number, price: number, isCall: number,
  ): number;
  pc_implied_vol_reason(): number;
  pc_norm_cdf(x: number): number;

  pc_book_reset(): void;
  pc_book_add_leg(
    strike: number, time: number, isCall: number, isAmerican: number,
    quantity: number, multiplier: number, vol: number,
  ): void;
  pc_book_len(): number;
  pc_grid_reprice(
    spot: number, rate: number, dividend: number,
    spotSteps: number, spotRange: number, volSteps: number, volRange: number,
    decayDays: number,
  ): number;
  pc_grid_data(): number;
  pc_grid_stride(): number;
  pc_grid_axis_ptr(which: number): number;
  pc_grid_axis_len(which: number): number;
  pc_guard_value(which: number): number;
  pc_guard_badge_ptr(): number;
  pc_guard_badge_len(): number;
}

const REQUIRED: readonly (keyof PricingExports)[] = [
  'memory',
  'pc_price', 'pc_greek', 'pc_american_fast', 'pc_american_exact', 'pc_american_detail',
  'pc_implied_vol', 'pc_implied_vol_reason', 'pc_norm_cdf',
  'pc_book_reset', 'pc_book_add_leg', 'pc_book_len', 'pc_grid_reprice',
  'pc_grid_data', 'pc_grid_stride', 'pc_grid_axis_ptr', 'pc_grid_axis_len',
  'pc_guard_value',
  'pc_guard_badge_ptr', 'pc_guard_badge_len',
];

/**
 * Checks the module is the one we think it is.
 *
 * A stale `.wasm` served from a cache is otherwise a runtime `undefined is not
 * a function` somewhere deep in a repricing loop, which is a miserable way to
 * learn that a deploy half-landed.
 */
export function assertPricingExports(exports: WebAssembly.Exports): PricingExports {
  const missing = REQUIRED.filter((name) => exports[name] === undefined);
  if (missing.length > 0) {
    throw new Error(
      `pricing module is missing ${missing.length} export(s): ${missing.join(', ')}. ` +
        'This is usually a stale .wasm — rebuild with ' +
        '`cargo build --release --target wasm32-unknown-unknown`.',
    );
  }
  return exports as unknown as PricingExports;
}

/** Instantiates from bytes. The module imports nothing. */
export async function instantiatePricing(
  source: BufferSource | Response | Promise<Response>,
): Promise<PricingExports> {
  if (source instanceof ArrayBuffer || ArrayBuffer.isView(source)) {
    const { instance } = await WebAssembly.instantiate(source as BufferSource, {});
    return assertPricingExports(instance.exports);
  }
  // Streaming compilation, which is the browser path: the module starts
  // compiling while it is still downloading.
  const { instance } = await WebAssembly.instantiateStreaming(source as Response, {});
  return assertPricingExports(instance.exports);
}

/**
 * Reads `count` f64s starting at `ptr` and copies them out.
 *
 * The copy is not optional. The view aliases WASM linear memory, and the next
 * call into the module can reallocate the vector behind it or grow the memory
 * and detach the buffer entirely. A retained view is a use-after-free wearing a
 * typed array's clothes.
 */
export function readFloats(memory: WebAssembly.Memory, ptr: number, count: number): Float64Array {
  return new Float64Array(memory.buffer, ptr, count).slice();
}

/** Reads a Rust `String` given as pointer and byte length. */
export function readUtf8(memory: WebAssembly.Memory, ptr: number, len: number): string {
  if (len === 0) return '';
  return new TextDecoder().decode(new Uint8Array(memory.buffer, ptr, len));
}
