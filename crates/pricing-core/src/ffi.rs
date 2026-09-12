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

use crate::grid::{self, Cell, GridSpec, GuardConfig, GuardOutcome, Leg, Market, Quality, Style};
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
///
/// `quality` is 0 draft, 1 standard, 2 exact. Anything else is standard, because
/// a caller that passes a quality this build does not know about should get the
/// safe answer rather than the fast one.
#[allow(clippy::too_many_arguments)]
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
    quality: i32,
) -> i32 {
    let market = Market { spot, rate, dividend };
    let mut spec = GridSpec::linear(
        spot_steps.max(1) as usize,
        spot_range,
        vol_steps.max(1) as usize,
        vol_range,
    );
    spec.time_decay_days = decay_days;
    spec.quality = match quality {
        0 => Quality::Draft,
        2 => Quality::Exact,
        _ => Quality::Standard,
    };

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

// ---------------------------------------------------------------------------
// Curves (PRD 5.3).
//
// "Curve bootstraps must run in the sub-millisecond range and must produce
// bit-identical results on client and server." Same shape as the grid surface:
// the instruments are pushed one at a time, the build happens in one call, and
// the results are read back by index — a curve is tens of numbers, not
// thousands, so there is no buffer to share.

use crate::curve::{self, Curve, CurveShock, Instrument, Nss, NssFit};

thread_local! {
    static INSTRUMENTS: RefCell<Vec<Instrument>> = const { RefCell::new(Vec::new()) };
    static CURVE: RefCell<Option<Curve>> = const { RefCell::new(None) };
    static OBSERVED: RefCell<Vec<(f64, f64)>> = const { RefCell::new(Vec::new()) };
    static FIT: RefCell<Option<NssFit>> = const { RefCell::new(None) };
    static WARNING: RefCell<String> = const { RefCell::new(String::new()) };
}

#[no_mangle]
pub extern "C" fn pc_curve_reset() {
    INSTRUMENTS.with(|i| i.borrow_mut().clear());
    CURVE.with(|c| *c.borrow_mut() = None);
}

#[no_mangle]
pub extern "C" fn pc_curve_add_deposit(maturity: f64, rate: f64) {
    INSTRUMENTS.with(|i| i.borrow_mut().push(Instrument::Deposit { maturity, rate }));
}

#[no_mangle]
pub extern "C" fn pc_curve_add_future(start: f64, end: f64, rate: f64, convexity_bps: f64) {
    INSTRUMENTS
        .with(|i| i.borrow_mut().push(Instrument::Future { start, end, rate, convexity_bps }));
}

#[no_mangle]
pub extern "C" fn pc_curve_add_swap(maturity: f64, rate: f64, frequency: f64) {
    INSTRUMENTS.with(|i| i.borrow_mut().push(Instrument::Swap { maturity, rate, frequency }));
}

/// Bootstraps. Returns the pin count, or -1 if the instruments do not build.
#[no_mangle]
pub extern "C" fn pc_curve_bootstrap() -> i32 {
    INSTRUMENTS.with(|instruments| {
        let instruments = instruments.borrow();
        match curve::bootstrap(&instruments) {
            Ok(built) => {
                let pins = built.pins().count() as i32;
                CURVE.with(|c| *c.borrow_mut() = Some(built));
                pins
            }
            Err(_) => {
                CURVE.with(|c| *c.borrow_mut() = None);
                -1
            }
        }
    })
}

/// Replaces the built curve with a shocked copy.
///
/// `shape` is 0 parallel, 1 steepener, 2 flattener, 3 butterfly. `pivot` is the
/// rotation point or the belly, and is ignored by a parallel shift.
#[no_mangle]
pub extern "C" fn pc_curve_shock(shape: i32, bps: f64, pivot: f64) -> i32 {
    let shock = match shape {
        1 => CurveShock::steepener(bps, pivot),
        2 => CurveShock::flattener(bps, pivot),
        3 => CurveShock::butterfly(bps, pivot),
        _ => CurveShock::parallel(bps),
    };
    CURVE.with(|c| {
        let mut slot = c.borrow_mut();
        match slot.as_ref() {
            Some(built) => {
                let shocked = shock.apply(built);
                let pins = shocked.pins().count() as i32;
                *slot = Some(shocked);
                pins
            }
            None => -1,
        }
    })
}

fn with_curve<F: FnOnce(&Curve) -> f64>(f: F) -> f64 {
    CURVE.with(|c| match c.borrow().as_ref() {
        Some(built) => f(built),
        None => f64::NAN,
    })
}

#[no_mangle]
pub extern "C" fn pc_curve_zero(t: f64) -> f64 {
    with_curve(|c| c.zero_rate(t))
}

#[no_mangle]
pub extern "C" fn pc_curve_discount(t: f64) -> f64 {
    with_curve(|c| c.discount(t))
}

#[no_mangle]
pub extern "C" fn pc_curve_forward(t1: f64, t2: f64) -> f64 {
    with_curve(|c| c.forward_rate(t1, t2))
}

/// How far the built curve is from repricing instrument `index` at par.
///
/// Exposed rather than asserted: "this curve reprices its own inputs" is a
/// claim a `CurveNode` should be able to show, not one the analyst takes on
/// trust.
#[no_mangle]
pub extern "C" fn pc_curve_residual(index: i32) -> f64 {
    INSTRUMENTS.with(|instruments| {
        let instruments = instruments.borrow();
        match instruments.get(index.max(0) as usize) {
            Some(instrument) => with_curve(|c| instrument.par_residual(c)),
            None => f64::NAN,
        }
    })
}

#[no_mangle]
pub extern "C" fn pc_nss_reset() {
    OBSERVED.with(|o| o.borrow_mut().clear());
    FIT.with(|f| *f.borrow_mut() = None);
}

#[no_mangle]
pub extern "C" fn pc_nss_observe(tenor: f64, zero_rate: f64) {
    OBSERVED.with(|o| o.borrow_mut().push((tenor, zero_rate)));
}

/// Fits. Returns 1 on success, 0 if the fit was refused, and -1 if it fitted
/// but the residuals are too large to present as the curve.
#[no_mangle]
pub extern "C" fn pc_nss_fit() -> i32 {
    OBSERVED.with(|observed| {
        let observed = observed.borrow();
        let tenors: Vec<f64> = observed.iter().map(|&(t, _)| t).collect();
        let zeros: Vec<f64> = observed.iter().map(|&(_, z)| z).collect();
        match curve::fit_nss(&tenors, &zeros) {
            Some(fit) => {
                let code = if fit.warning.is_some() { -1 } else { 1 };
                WARNING.with(|w| *w.borrow_mut() = fit.warning.clone().unwrap_or_default());
                FIT.with(|f| *f.borrow_mut() = Some(fit));
                code
            }
            None => {
                WARNING.with(|w| w.borrow_mut().clear());
                FIT.with(|f| *f.borrow_mut() = None);
                0
            }
        }
    })
}

/// A fitted parameter: 0 beta0, 1 beta1, 2 beta2, 3 beta3, 4 tau1, 5 tau2.
#[no_mangle]
pub extern "C" fn pc_nss_param(which: i32) -> f64 {
    FIT.with(|f| match f.borrow().as_ref() {
        Some(NssFit { params: Nss { beta0, beta1, beta2, beta3, tau1, tau2 }, .. }) => {
            match which {
                0 => *beta0,
                1 => *beta1,
                2 => *beta2,
                3 => *beta3,
                4 => *tau1,
                5 => *tau2,
                _ => f64::NAN,
            }
        }
        None => f64::NAN,
    })
}

/// A fit statistic: 0 rmse in bps, 1 worst absolute residual in bps, 2 the
/// tenor where it is worst.
#[no_mangle]
pub extern "C" fn pc_nss_stat(which: i32) -> f64 {
    FIT.with(|f| match f.borrow().as_ref() {
        Some(fit) => match which {
            0 => fit.rmse_bps,
            1 => fit.max_abs_bps,
            2 => fit.worst_tenor,
            _ => f64::NAN,
        },
        None => f64::NAN,
    })
}

#[no_mangle]
pub extern "C" fn pc_nss_zero(t: f64) -> f64 {
    FIT.with(|f| match f.borrow().as_ref() {
        Some(fit) => fit.params.zero_rate(t),
        None => f64::NAN,
    })
}

#[no_mangle]
pub extern "C" fn pc_nss_residual(index: i32) -> f64 {
    FIT.with(|f| match f.borrow().as_ref() {
        Some(fit) => fit.residuals.get(index.max(0) as usize).copied().unwrap_or(f64::NAN),
        None => f64::NAN,
    })
}

#[no_mangle]
pub extern "C" fn pc_nss_warning_ptr() -> *const u8 {
    WARNING.with(|w| w.borrow().as_ptr())
}

#[no_mangle]
pub extern "C" fn pc_nss_warning_len() -> i32 {
    WARNING.with(|w| w.borrow().len() as i32)
}
