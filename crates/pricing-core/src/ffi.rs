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

thread_local! {
    static IV_REASON: std::cell::Cell<i32> = const { std::cell::Cell::new(0) };
}

#[inline]
fn set_iv_reason(code: i32) {
    IV_REASON.with(|reason| reason.set(code));
}

/// The 255-step lattice, for a single position an analyst pinned as exact.
#[no_mangle]
pub extern "C" fn pc_american_detail(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    v: f64,
    is_call: i32,
) -> f64 {
    american::detail_price(&inputs(s, k, t, r, q, v, is_call))
}

/// Implied volatility. NaN when there is no answer to give.
///
/// The reason is recorded rather than returned, because the ABI stays scalar;
/// call `pc_implied_vol_reason` immediately afterwards. It matters which
/// failure it was: "not identifiable" is a chain showing `--`, and "below
/// intrinsic" is a quote that should never have reached us.
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
        Ok(solution) => {
            set_iv_reason(IV_OK);
            solution.vol
        }
        Err(failure) => {
            set_iv_reason(match failure {
                implied::SolveFailure::BelowIntrinsic => 1,
                implied::SolveFailure::AboveUpperBound => 2,
                implied::SolveFailure::Degenerate => 3,
                implied::SolveFailure::NoConvergence => 4,
                implied::SolveFailure::NotIdentifiable => 5,
            });
            f64::NAN
        }
    }
}

const IV_OK: i32 = 0;

/// Why the last `pc_implied_vol` call returned what it did.
///
/// 0 solved, 1 below intrinsic, 2 above upper bound, 3 degenerate,
/// 4 no convergence, 5 not identifiable.
#[no_mangle]
pub extern "C" fn pc_implied_vol_reason() -> i32 {
    IV_REASON.with(|reason| reason.get())
}

/// Standard normal CDF, exported because it is the shared primitive most
/// likely to differ between two math libraries.
#[no_mangle]
pub extern "C" fn pc_norm_cdf(x: f64) -> f64 {
    crate::normal::cdf(x)
}

// ---------------------------------------------------------------------------
// Grid repricing across the boundary.
//
// A 25x15 grid is 375 cells and a 40-leg book is 15,000 repricings. Crossing
// the WASM boundary per cell would cost more than the arithmetic does, so the
// book is built up leg by leg, repriced in one call, and the results are read
// straight out of WASM memory as a typed array.
//
// The state is thread-local and the module is single-threaded, which is what
// WASM gives us; the native side is only ever driven by the parity harness.

use crate::grid::{self, Cell, GridSpec, GuardConfig, GuardOutcome, Leg, Market, Style};
use std::cell::RefCell;

/// Floats written per cell: value, delta, gamma, vega, theta, exact flag.
pub const CELL_STRIDE: usize = 6;

thread_local! {
    static BOOK: RefCell<Vec<Leg>> = const { RefCell::new(Vec::new()) };
    static CELLS: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    // The axes as the grid actually used them, so a chart labels its cells with
    // the numbers they were priced at rather than with a JavaScript
    // reconstruction of the same formula.
    static SPOT_AXIS: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    static VOL_AXIS: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    static BADGE: RefCell<String> = const { RefCell::new(String::new()) };
    static REPORT: RefCell<[f64; 5]> = const { RefCell::new([0.0; 5]) };
}

/// Clears the book. Call before adding legs.
#[no_mangle]
pub extern "C" fn pc_book_reset() {
    BOOK.with(|b| b.borrow_mut().clear());
}

/// Appends one leg.
#[no_mangle]
pub extern "C" fn pc_book_add_leg(
    strike: f64,
    time: f64,
    is_call: i32,
    is_american: i32,
    quantity: f64,
    multiplier: f64,
    vol: f64,
) {
    let leg = Leg {
        strike,
        time,
        kind: if is_call != 0 { OptionType::Call } else { OptionType::Put },
        style: if is_american != 0 { Style::American } else { Style::European },
        quantity,
        multiplier,
        vol,
    };
    BOOK.with(|b| b.borrow_mut().push(leg));
}

#[no_mangle]
pub extern "C" fn pc_book_len() -> i32 {
    BOOK.with(|b| b.borrow().len() as i32)
}

/// Reprices the book over the grid. Returns the cell count, or -1 if empty.
#[no_mangle]
pub extern "C" fn pc_grid_reprice(
    spot: f64,
    rate: f64,
    dividend: f64,
    spot_steps: i32,
    spot_range: f64,
    vol_steps: i32,
    vol_range: f64,
    decay_days: f64,
) -> i32 {
    let market = Market { spot, rate, dividend };
    let mut spec = GridSpec::linear(
        spot_steps.max(1) as usize,
        spot_range,
        vol_steps.max(1) as usize,
        vol_range,
    );
    spec.time_decay_days = decay_days;

    BOOK.with(|book| {
        let book = book.borrow();
        if book.is_empty() {
            return -1;
        }
        let result = grid::reprice_grid(&book, &market, &spec, &GuardConfig::default());

        SPOT_AXIS.with(|axis| {
            *axis.borrow_mut() = spec.spot_shocks.iter().map(|s| market.spot * s).collect();
        });
        VOL_AXIS.with(|axis| *axis.borrow_mut() = spec.vol_shifts.clone());

        CELLS.with(|cells| {
            let mut cells = cells.borrow_mut();
            cells.clear();
            cells.reserve(result.cells.len() * CELL_STRIDE);
            for Cell { value, delta, gamma, vega, theta, exact } in &result.cells {
                cells.push(*value);
                cells.push(*delta);
                cells.push(*gamma);
                cells.push(*vega);
                cells.push(*theta);
                cells.push(if *exact { 1.0 } else { 0.0 });
            }
        });

        BADGE.with(|badge| *badge.borrow_mut() = result.guard.badge.clone());
        REPORT.with(|report| {
            *report.borrow_mut() = [
                match result.guard.outcome {
                    GuardOutcome::NotNeeded => 0.0,
                    GuardOutcome::Passed => 1.0,
                    GuardOutcome::Escalated => 2.0,
                },
                result.guard.max_error,
                result.guard.tolerance,
                result.guard.escalated_cells as f64,
                result.repricings as f64,
            ];
        });

        result.cells.len() as i32
    })
}

/// Pointer to the packed cells: `CELL_STRIDE` floats each, row-major by spot.
#[no_mangle]
pub extern "C" fn pc_grid_data() -> *const f64 {
    CELLS.with(|cells| cells.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn pc_grid_stride() -> i32 {
    CELL_STRIDE as i32
}

/// Axis values the last grid was priced at: 0 spot levels, 1 vol shifts.
///
/// Pointer plus length rather than one value per call, because an axis is read
/// once per redraw and 25 boundary crossings for 25 labels is 25 too many.
#[no_mangle]
pub extern "C" fn pc_grid_axis_ptr(which: i32) -> *const f64 {
    if which == 0 {
        SPOT_AXIS.with(|axis| axis.borrow().as_ptr())
    } else {
        VOL_AXIS.with(|axis| axis.borrow().as_ptr())
    }
}

#[no_mangle]
pub extern "C" fn pc_grid_axis_len(which: i32) -> i32 {
    if which == 0 {
        SPOT_AXIS.with(|axis| axis.borrow().len() as i32)
    } else {
        VOL_AXIS.with(|axis| axis.borrow().len() as i32)
    }
}

/// Guard figures by index: 0 outcome, 1 max error, 2 tolerance,
/// 3 escalated cells, 4 total repricings.
#[no_mangle]
pub extern "C" fn pc_guard_value(which: i32) -> f64 {
    REPORT.with(|report| {
        let report = report.borrow();
        report.get(which as usize).copied().unwrap_or(f64::NAN)
    })
}

#[no_mangle]
pub extern "C" fn pc_guard_badge_ptr() -> *const u8 {
    BADGE.with(|badge| badge.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn pc_guard_badge_len() -> i32 {
    BADGE.with(|badge| badge.borrow().len() as i32)
}
