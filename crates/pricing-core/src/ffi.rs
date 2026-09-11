//! The C ABI surface, which is also the WASM surface.
//!
//! The PRD's requirement is not merely that this crate compiles to both targets
//! but that it "must produce bit-identical results on client and server" — an
//! optimistic client-side price that disagrees with the server's authoritative
//! one in the last few digits produces a visual tick that never settles
//! (PRD 7.1).
//!
//! These exports exist so that claim can be tested rather than assumed:
//! `scripts/verify-wasm-parity.mjs` runs the same inputs through the native
//! binary and the WASM module and compares the raw bit patterns.

use crate::american;
use crate::bsm::{self, Inputs, OptionType};
use crate::implied;

#[inline]
fn inputs(s: f64, k: f64, t: f64, r: f64, q: f64, v: f64, is_call: i32) -> Inputs {
    Inputs {
        spot: s,
        strike: k,
        time: t,
        rate: r,
        dividend: q,
        vol: v,
        kind: if is_call != 0 { OptionType::Call } else { OptionType::Put },
    }
}

/// European price.
#[no_mangle]
pub extern "C" fn pc_price(s: f64, k: f64, t: f64, r: f64, q: f64, v: f64, is_call: i32) -> f64 {
    bsm::price(&inputs(s, k, t, r, q, v, is_call))
}

/// One Greek, selected by index, so the ABI stays scalar.
///
/// 0 price, 1 delta, 2 gamma, 3 vega, 4 theta, 5 rho, 6 vanna, 7 volga,
/// 8 charm, 9 speed.
#[no_mangle]
pub extern "C" fn pc_greek(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    v: f64,
    is_call: i32,
    which: i32,
) -> f64 {
    let g = bsm::greeks(&inputs(s, k, t, r, q, v, is_call));
    match which {
        0 => g.price,
        1 => g.delta,
        2 => g.gamma,
        3 => g.vega,
        4 => g.theta,
        5 => g.rho,
        6 => g.vanna,
        7 => g.volga,
        8 => g.charm,
        9 => g.speed,
        _ => f64::NAN,
    }
}

/// Fast American price, as used on grid and portfolio paths.
#[no_mangle]
pub extern "C" fn pc_american_fast(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    v: f64,
    is_call: i32,
) -> f64 {
    american::fast_price(&inputs(s, k, t, r, q, v, is_call))
}

/// Exact American price on the guard's lattice.
#[no_mangle]
pub extern "C" fn pc_american_exact(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    v: f64,
    is_call: i32,
) -> f64 {
    american::exact_price(&inputs(s, k, t, r, q, v, is_call))
}

/// Implied volatility. NaN when there is no answer to give.
#[no_mangle]
pub extern "C" fn pc_implied_vol(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    price: f64,
    is_call: i32,
) -> f64 {
    match implied::implied_vol(&inputs(s, k, t, r, q, 0.2, is_call), price) {
        Ok(solution) => solution.vol,
        Err(_) => f64::NAN,
    }
}

/// Standard normal CDF, exported because it is the shared primitive most
/// likely to differ between two math libraries.
#[no_mangle]
pub extern "C" fn pc_norm_cdf(x: f64) -> f64 {
    crate::normal::cdf(x)
}
