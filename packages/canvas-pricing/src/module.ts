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
    decayDays: number, quality: number,
  ): number;
  pc_grid_data(): number;
  pc_grid_stride(): number;
  pc_grid_axis_ptr(which: number): number;
  pc_grid_axis_len(which: number): number;
  pc_guard_value(which: number): number;
  pc_guard_badge_ptr(): number;
  pc_guard_badge_len(): number;

  pc_bond_reset(): void;
  pc_bond_add_flow(time: number, amount: number): void;
  pc_bond_metric(which: number, price: number, frequency: number): number;
  pc_bond_price_at_yield(y: number, frequency: number): number;
  pc_bond_z_spread(price: number): number;
  pc_bond_asset_swap(price: number, frequency: number, notional: number): number;
  pc_hw_calibrate(meanReversion: number, vol: number, dt: number, steps: number): number;
  pc_hw_zero_coupon(step: number): number;
  pc_hw_bond_price(
    coupon: number, redemption: number, slices: number,
    callFrom: number, callPrice: number, spread: number,
  ): number;
  pc_hw_oas(
    coupon: number, redemption: number, slices: number,
    callFrom: number, callPrice: number, price: number,
  ): number;
  pc_hw_option_value(
    coupon: number, redemption: number, slices: number,
    callFrom: number, callPrice: number, spread: number,
  ): number;

  pc_curve_reset(): void;
  pc_curve_add_deposit(maturity: number, rate: number): void;
  pc_curve_add_future(start: number, end: number, rate: number, convexityBps: number): void;
  pc_curve_add_swap(maturity: number, rate: number, frequency: number): void;
  pc_curve_bootstrap(): number;
  pc_curve_shock(shape: number, bps: number, pivot: number): number;
  pc_curve_zero(t: number): number;
  pc_curve_discount(t: number): number;
  pc_curve_forward(t1: number, t2: number): number;
  pc_curve_residual(index: number): number;

  pc_nss_reset(): void;
  pc_nss_observe(tenor: number, zeroRate: number): void;
  pc_nss_fit(): number;
  pc_nss_param(which: number): number;
  pc_nss_stat(which: number): number;
  pc_nss_zero(t: number): number;
  pc_nss_residual(index: number): number;
  pc_nss_install_curve(): number;
  pc_heston_price(
    spot: number, strike: number, time: number, rate: number, dividend: number, isCall: number,
    v0: number, theta: number, kappa: number, sigma: number, rho: number,
  ): number;
  pc_heston_iv(
    spot: number, strike: number, time: number, rate: number, dividend: number, isCall: number,
    v0: number, theta: number, kappa: number, sigma: number, rho: number,
  ): number;
  pc_heston_conditioning(
    v0: number, theta: number, kappa: number, sigma: number, rho: number,
  ): number;
  pc_heston_conditioning_limit(): number;
  pc_heston_surface_reset(): void;
  pc_heston_surface_add(
    strike: number, time: number, isCall: number, vol: number, weight: number,
  ): void;
  pc_heston_surface_len(): number;
  pc_heston_calibrate(
    spot: number, rate: number, dividend: number, residual: number,
    population: number, generations: number, seed: number,
  ): number;
  pc_heston_fit(): number;

  pc_mc_reset(): void;
  pc_mc_add_asset(spot: number, weight: number, vol: number, rate: number, dividend: number): void;
  pc_mc_asset_count(): number;
  pc_mc_corr_push(value: number): void;
  pc_mc_corr_equicorrelated(rho: number): void;
  pc_mc_run(
    time: number, paths: number, steps: number,
    antithetic: number, seed: number, samplePaths: number,
  ): number;
  pc_mc_summary(): number;
  pc_mc_terminal(): number;
  pc_mc_drawdown(): number;
  pc_mc_sample(): number;
  pc_mc_sample_rows(): number;
  pc_mc_percentile(p: number): number;
  pc_mc_drawdown_percentile(p: number): number;
  pc_mc_cvar(alpha: number): number;

  pc_nss_warning_ptr(): number;
  pc_nss_warning_len(): number;
}

const REQUIRED: readonly (keyof PricingExports)[] = [
  'memory',
  'pc_price', 'pc_greek', 'pc_american_fast', 'pc_american_exact', 'pc_american_detail',
  'pc_implied_vol', 'pc_implied_vol_reason', 'pc_norm_cdf',
  'pc_book_reset', 'pc_book_add_leg', 'pc_book_len', 'pc_grid_reprice',
  'pc_grid_data', 'pc_grid_stride', 'pc_grid_axis_ptr', 'pc_grid_axis_len',
  'pc_guard_value',
  'pc_guard_badge_ptr', 'pc_guard_badge_len',
  'pc_bond_reset', 'pc_bond_add_flow', 'pc_bond_metric', 'pc_bond_price_at_yield',
  'pc_bond_z_spread', 'pc_bond_asset_swap',
  'pc_hw_calibrate', 'pc_hw_zero_coupon', 'pc_hw_bond_price', 'pc_hw_oas',
  'pc_hw_option_value',
  'pc_curve_reset', 'pc_curve_add_deposit', 'pc_curve_add_future', 'pc_curve_add_swap',
  'pc_curve_bootstrap', 'pc_curve_shock', 'pc_curve_zero', 'pc_curve_discount',
  'pc_curve_forward', 'pc_curve_residual',
  'pc_nss_reset', 'pc_nss_observe', 'pc_nss_fit', 'pc_nss_param', 'pc_nss_stat',
  'pc_nss_zero', 'pc_nss_residual', 'pc_nss_install_curve',
  'pc_nss_warning_ptr', 'pc_nss_warning_len',
  'pc_mc_reset', 'pc_mc_add_asset', 'pc_mc_asset_count',
  'pc_mc_corr_push', 'pc_mc_corr_equicorrelated', 'pc_mc_run',
  'pc_mc_summary', 'pc_mc_terminal', 'pc_mc_drawdown', 'pc_mc_sample',
  'pc_mc_sample_rows', 'pc_mc_percentile', 'pc_mc_drawdown_percentile', 'pc_mc_cvar',
  'pc_heston_price', 'pc_heston_iv', 'pc_heston_conditioning',
  'pc_heston_conditioning_limit', 'pc_heston_surface_reset', 'pc_heston_surface_add',
  'pc_heston_surface_len', 'pc_heston_calibrate', 'pc_heston_fit',
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
