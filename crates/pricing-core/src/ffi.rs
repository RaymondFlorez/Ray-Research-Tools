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
use crate::copula::Factor;
use crate::implied;
use crate::de::DeConfig;
use crate::heston::{self, CalibrationConfig, HestonParams, Quote, Residual, Surface};
use crate::mc::{Gbm, Process};
use crate::portfolio::{simulate_portfolio, AssetSpec, PortfolioConfig, PortfolioResult};

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

/// Distance from spot to a strike in remaining standard deviations (PRD 5.4).
///
/// Exported rather than computed in TypeScript because the result is compared
/// against a threshold: a last-place difference between two math libraries
/// turns the pin warning on in the browser and off on the server.
#[no_mangle]
pub extern "C" fn pc_pin_sigmas(spot: f64, strike: f64, vol: f64, time: f64) -> f64 {
    crate::risk::pin_sigmas(spot, strike, vol, time)
}

/// What exercising an American option early is worth, before time value.
#[no_mangle]
pub extern "C" fn pc_early_exercise_carry(
    spot: f64,
    strike: f64,
    rate: f64,
    dividend: f64,
    time: f64,
    is_call: i32,
) -> f64 {
    crate::risk::early_exercise_carry(spot, strike, rate, dividend, time, is_call != 0)
}

/// A discount factor, so a dated dividend is discounted by the same `exp` the
/// carry above uses.
#[no_mangle]
pub extern "C" fn pc_discount(rate: f64, time: f64) -> f64 {
    crate::risk::discount(rate, time)
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

/// Installs the fitted curve as the current one, so it can be shocked and
/// discounted against like any other.
///
/// Pinned at the tenors that were observed: a fit is a shape, and the honest
/// place to pin it is where there were quotes to fit to. Returns the pin count,
/// or -1 if nothing has been fitted.
#[no_mangle]
pub extern "C" fn pc_nss_install_curve() -> i32 {
    FIT.with(|f| match f.borrow().as_ref() {
        Some(fit) => OBSERVED.with(|observed| {
            let tenors: Vec<f64> = observed.borrow().iter().map(|&(t, _)| t).collect();
            if tenors.is_empty() {
                return -1;
            }
            let built = fit.params.to_curve(&tenors);
            let pins = built.pins().count() as i32;
            CURVE.with(|c| *c.borrow_mut() = Some(built));
            pins
        }),
        None => -1,
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

// ---------------------------------------------------------------------------
// Bond analytics and OAS (PRD 5.3).

use crate::bond;
use crate::hull_white::{HullWhite, Lattice, LatticeBond};

thread_local! {
    static FLOWS: RefCell<Vec<(f64, f64)>> = const { RefCell::new(Vec::new()) };
    static LATTICE: RefCell<Option<Lattice>> = const { RefCell::new(None) };
}

#[no_mangle]
pub extern "C" fn pc_bond_reset() {
    FLOWS.with(|f| f.borrow_mut().clear());
}

#[no_mangle]
pub extern "C" fn pc_bond_add_flow(time: f64, amount: f64) {
    FLOWS.with(|f| f.borrow_mut().push((time, amount)));
}

/// A yield metric: 0 yield, 1 Macaulay, 2 modified, 3 convexity, 4 DV01.
///
/// All five come from one yield solve, so they are returned by index rather
/// than solved five times.
#[no_mangle]
pub extern "C" fn pc_bond_metric(which: i32, price: f64, frequency: f64) -> f64 {
    FLOWS.with(|flows| {
        let flows = flows.borrow();
        match bond::yield_metrics(&flows, price, frequency) {
            Some(m) => match which {
                0 => m.yield_to_maturity,
                1 => m.macaulay_duration,
                2 => m.modified_duration,
                3 => m.convexity,
                4 => m.dv01,
                _ => f64::NAN,
            },
            None => f64::NAN,
        }
    })
}

#[no_mangle]
pub extern "C" fn pc_bond_price_at_yield(y: f64, frequency: f64) -> f64 {
    FLOWS.with(|flows| bond::price_at_yield(&flows.borrow(), y, frequency))
}

/// Spread over the curve built by `pc_curve_bootstrap`. NaN if there is none.
#[no_mangle]
pub extern "C" fn pc_bond_z_spread(price: f64) -> f64 {
    FLOWS.with(|flows| {
        let flows = flows.borrow();
        CURVE.with(|c| match c.borrow().as_ref() {
            Some(curve) => bond::z_spread(&flows, curve, price).unwrap_or(f64::NAN),
            None => f64::NAN,
        })
    })
}

#[no_mangle]
pub extern "C" fn pc_bond_asset_swap(price: f64, frequency: f64, notional: f64) -> f64 {
    FLOWS.with(|flows| {
        let flows = flows.borrow();
        CURVE.with(|c| match c.borrow().as_ref() {
            Some(curve) => {
                bond::asset_swap_spread(&flows, curve, price, frequency, notional)
                    .unwrap_or(f64::NAN)
            }
            None => f64::NAN,
        })
    })
}

/// Calibrates a Hull-White lattice to the built curve. Returns the step count,
/// or -1 if there is no curve to calibrate to.
#[no_mangle]
pub extern "C" fn pc_hw_calibrate(
    mean_reversion: f64,
    vol: f64,
    dt: f64,
    steps: i32,
) -> i32 {
    let steps = steps.max(1) as usize;
    CURVE.with(|c| match c.borrow().as_ref() {
        Some(curve) => {
            let lattice = HullWhite { mean_reversion, vol }.calibrate(curve, dt, steps);
            let built = lattice.steps() as i32;
            LATTICE.with(|l| *l.borrow_mut() = Some(lattice));
            built
        }
        None => {
            LATTICE.with(|l| *l.borrow_mut() = None);
            -1
        }
    })
}

/// The lattice's own zero-coupon bond to a slice, which should equal the
/// curve's. The calibration condition, readable from outside.
#[no_mangle]
pub extern "C" fn pc_hw_zero_coupon(step: i32) -> f64 {
    LATTICE.with(|l| match l.borrow().as_ref() {
        Some(lattice) => lattice.zero_coupon(step.max(0) as usize),
        None => f64::NAN,
    })
}

fn lattice_bond(coupon: f64, redemption: f64, slices: i32, call_from: i32, call_price: f64) -> LatticeBond {
    let slices = slices.max(1) as usize;
    let mut bond = LatticeBond::bullet(coupon, redemption, slices);
    bond.flows[0] = 0.0;
    if call_from >= 0 {
        bond = bond.callable_from(call_from as usize, call_price);
    }
    bond
}

/// Prices a bond on the calibrated lattice. `call_from` below zero means no call.
#[no_mangle]
pub extern "C" fn pc_hw_bond_price(
    coupon: f64,
    redemption: f64,
    slices: i32,
    call_from: i32,
    call_price: f64,
    spread: f64,
) -> f64 {
    LATTICE.with(|l| match l.borrow().as_ref() {
        Some(lattice) => lattice.bond_price(
            &lattice_bond(coupon, redemption, slices, call_from, call_price),
            spread,
        ),
        None => f64::NAN,
    })
}

#[no_mangle]
pub extern "C" fn pc_hw_oas(
    coupon: f64,
    redemption: f64,
    slices: i32,
    call_from: i32,
    call_price: f64,
    price: f64,
) -> f64 {
    LATTICE.with(|l| match l.borrow().as_ref() {
        Some(lattice) => lattice
            .option_adjusted_spread(
                &lattice_bond(coupon, redemption, slices, call_from, call_price),
                price,
            )
            .unwrap_or(f64::NAN),
        None => f64::NAN,
    })
}

/// What the embedded call is worth, in price terms.
#[no_mangle]
pub extern "C" fn pc_hw_option_value(
    coupon: f64,
    redemption: f64,
    slices: i32,
    call_from: i32,
    call_price: f64,
    spread: f64,
) -> f64 {
    LATTICE.with(|l| match l.borrow().as_ref() {
        Some(lattice) => lattice.option_value(
            &lattice_bond(coupon, redemption, slices, call_from, call_price),
            spread,
        ),
        None => f64::NAN,
    })
}

// ---------------------------------------------------------------------------
// Monte Carlo (PRD 5.8).

use crate::mc::{self, McConfig, Sampling};

/// A European option by Monte Carlo. `process` is 0 GBM, 1 Heston, 2 Merton,
/// 3 variance gamma; `sampling` is 0 pseudorandom, 1 Sobol.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn pc_mc_european(
    process: i32,
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    q: f64,
    v: f64,
    is_call: i32,
    paths: i32,
    steps: i32,
    sampling: i32,
    antithetic: i32,
    seed: f64,
) -> f64 {
    let option = inputs(s, k, t, r, q, v, is_call);
    let config = McConfig {
        paths: paths.max(1) as usize,
        steps: steps.max(1) as usize,
        sampling: if sampling == 1 { Sampling::Quasi } else { Sampling::Pseudo },
        antithetic: antithetic != 0,
        seed: seed as u64,
    };
    let variance = v * v;
    match process {
        1 => mc::european_mc(
            &mc::Heston {
                rate: r,
                dividend: q,
                theta: variance,
                kappa: 2.0,
                sigma: 0.5,
                rho: -0.6,
                initial_variance: variance,
            },
            &option,
            &config,
            variance,
            true,
        ),
        2 => mc::european_mc(
            &mc::Merton {
                rate: r,
                dividend: q,
                vol: v * 0.8,
                intensity: 1.0,
                jump_mean: -0.08,
                jump_vol: 0.15,
            },
            &option,
            &config,
            0.0,
            true,
        ),
        3 => mc::european_mc(
            &mc::VarianceGamma { rate: r, dividend: q, sigma: v * 0.75, nu: 0.35, theta: -0.25 },
            &option,
            &config,
            0.0,
            false,
        ),
        _ => mc::european_mc(&mc::Gbm { rate: r, dividend: q, vol: v }, &option, &config, 0.0, true),
    }
    .mean
}

/// One Sobol coordinate, so the sequence itself is covered by the parity check.
#[no_mangle]
pub extern "C" fn pc_sobol(dimensions: i32, skip: i32, dimension: i32) -> f64 {
    let dims = dimensions.clamp(1, crate::rng::MAX_SOBOL_DIMENSIONS as i32) as usize;
    let mut sobol = crate::rng::Sobol::new(dims);
    let mut point = vec![0.0; dims];
    for _ in 0..=skip.max(0) {
        sobol.next_point(&mut point);
    }
    point.get(dimension.max(0) as usize).copied().unwrap_or(f64::NAN)
}

// ---------------------------------------------------------------------------
// Multi-asset Monte Carlo (PRD 5.8)
// ---------------------------------------------------------------------------

/// Floats in the summary block.
pub const MC_SUMMARY_STRIDE: usize = 9;

/// One asset's process, as the C ABI can express it.
///
/// An enum rather than a trait object because the boundary has no allocator and
/// no vtable: each variant is a flat parameter block, and the dispatch back to
/// `&dyn Process` happens on this side where it costs nothing.
#[derive(Clone, Copy, Debug)]
enum McProcess {
    Gbm(Gbm),
    Heston(crate::mc::Heston),
    Merton(crate::mc::Merton),
}

impl McProcess {
    fn as_process(&self) -> &dyn Process {
        match self {
            McProcess::Gbm(p) => p,
            McProcess::Heston(p) => p,
            McProcess::Merton(p) => p,
        }
    }
}

thread_local! {
    static MC_ASSETS: RefCell<Vec<(AssetSpec, McProcess)>> = const { RefCell::new(Vec::new()) };
    static MC_CORR: RefCell<Vec<f64>> = const { RefCell::new(Vec::new()) };
    static MC_RESULT: RefCell<Option<PortfolioResult>> = const { RefCell::new(None) };
    static MC_SUMMARY: RefCell<[f64; MC_SUMMARY_STRIDE]> =
        const { RefCell::new([0.0; MC_SUMMARY_STRIDE]) };
}

/// Clears the asset list, the correlation matrix and the last result.
#[no_mangle]
pub extern "C" fn pc_mc_reset() {
    MC_ASSETS.with(|a| a.borrow_mut().clear());
    MC_CORR.with(|c| c.borrow_mut().clear());
    MC_RESULT.with(|r| *r.borrow_mut() = None);
}

/// Appends one geometric Brownian motion asset.
///
/// One entry point per process rather than one taking the union of their
/// parameters: Heston needs five, Merton six and variance-gamma five, and a
/// single function with sixteen `f64` arguments where eleven are ignored is a
/// signature nobody can call correctly twice. Each variant below carries only
/// what it uses, and `pc_mc_asset_count` is how a caller checks the boundary
/// took what it thought it sent.
#[no_mangle]
pub extern "C" fn pc_mc_add_asset(
    spot: f64,
    weight: f64,
    vol: f64,
    rate: f64,
    dividend: f64,
) {
    MC_ASSETS.with(|assets| {
        assets.borrow_mut().push((
            AssetSpec { spot, weight, initial_variance: 0.0 },
            McProcess::Gbm(Gbm { rate, dividend, vol }),
        ));
    });
}

/// Appends one Heston asset, with the parameters a surface calibration produces.
///
/// The cross-asset correlation in `pc_mc_corr_*` couples the *spot* shocks.
/// Each asset's own `rho` couples its variance to its own spot, which is what
/// Heston's `rho` means; variance shocks are not correlated across assets. That
/// is a modelling choice rather than an omission — a cross-asset variance
/// correlation is a second matrix nobody calibrates — and it is stated because
/// a reader would otherwise reasonably assume the one matrix covered both.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn pc_mc_add_heston(
    spot: f64,
    weight: f64,
    rate: f64,
    dividend: f64,
    v0: f64,
    theta: f64,
    kappa: f64,
    sigma: f64,
    rho: f64,
) {
    MC_ASSETS.with(|assets| {
        assets.borrow_mut().push((
            // The initial variance travels on the spec, because that is what
            // `simulate_portfolio` seeds `ProcessState` from; the copy on the
            // process is what the drift reads.
            AssetSpec { spot, weight, initial_variance: v0 },
            McProcess::Heston(crate::mc::Heston {
                rate,
                dividend,
                theta,
                kappa,
                sigma,
                rho,
                initial_variance: v0,
            }),
        ));
    });
}

/// Appends one Merton jump-diffusion asset.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn pc_mc_add_merton(
    spot: f64,
    weight: f64,
    rate: f64,
    dividend: f64,
    vol: f64,
    intensity: f64,
    jump_mean: f64,
    jump_vol: f64,
) {
    MC_ASSETS.with(|assets| {
        assets.borrow_mut().push((
            AssetSpec { spot, weight, initial_variance: 0.0 },
            McProcess::Merton(crate::mc::Merton {
                rate,
                dividend,
                vol,
                intensity,
                jump_mean,
                jump_vol,
            }),
        ));
    });
}

/// Variance gamma has no entry point here, deliberately.
///
/// It is a pure-jump process: it builds its increment from a gamma clock and
/// its own normal, and never reads the Brownian increment the portfolio
/// simulator correlates. In a multi-asset run that means it receives no
/// cross-asset dependence at all while looking exactly like an asset that did —
/// measured, a VG pair asked for a correlation of 0.8 comes back at 0.0062, the
/// same to the last digit as at zero. `simulate_portfolio` refuses it, so an
/// entry point here could only ever produce that refusal. A single-asset
/// variance-gamma simulation belongs in `mc::simulate`, which drives it
/// correctly.

#[no_mangle]
pub extern "C" fn pc_mc_asset_count() -> i32 {
    MC_ASSETS.with(|a| a.borrow().len() as i32)
}

/// Appends one entry of the correlation matrix, row-major.
///
/// Pushed one at a time rather than passed as a pointer because the caller has
/// no allocator on this side of the boundary: the grid book is built the same
/// way. A 40-asset matrix is 1,600 calls, made once per run rather than once
/// per path, against 1.008 billion asset-steps.
#[no_mangle]
pub extern "C" fn pc_mc_corr_push(value: f64) {
    MC_CORR.with(|c| c.borrow_mut().push(value));
}

/// Fills the correlation matrix with a single off-diagonal value.
#[no_mangle]
pub extern "C" fn pc_mc_corr_equicorrelated(rho: f64) {
    let n = MC_ASSETS.with(|a| a.borrow().len());
    MC_CORR.with(|c| {
        let mut c = c.borrow_mut();
        c.clear();
        c.resize(n * n, rho);
        for i in 0..n {
            c[i * n + i] = 1.0;
        }
    });
}

/// Runs the simulation. Returns the path count, or a negative code.
///
/// `-1` no assets, `-2` the correlation matrix is the wrong size, `-3` the
/// matrix is not a valid correlation matrix (not symmetric, diagonal not one,
/// or not positive definite), `-4` zero paths or steps.
///
/// The not-positive-definite case is worth its own code rather than being
/// folded into a generic failure: it is the one an analyst causes, by
/// assembling correlations pairwise until they no longer describe any joint
/// distribution, and the fix is theirs rather than the caller's.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn pc_mc_run(
    time: f64,
    paths: i32,
    steps: i32,
    antithetic: i32,
    seed: f64,
    sample_paths: i32,
) -> i32 {
    let n = MC_ASSETS.with(|a| a.borrow().len());
    if n == 0 {
        return -1;
    }
    let correlation = MC_CORR.with(|c| c.borrow().clone());
    if correlation.len() != n * n {
        return -2;
    }
    let Ok(factor) = Factor::cholesky(&correlation, n) else {
        return -3;
    };
    if paths <= 0 || steps <= 0 {
        return -4;
    }

    let config = PortfolioConfig {
        paths: paths as usize,
        steps: steps as usize,
        antithetic: antithetic != 0,
        // f64 to u64 because the C ABI here is all f64 and i32; a seed that
        // arrives as a double keeps 53 bits, which is more than enough entropy
        // and avoids a 64-bit integer crossing a boundary JavaScript cannot
        // represent exactly anyway.
        seed: seed.abs() as u64,
        sample_paths: sample_paths.max(0) as usize,
    };

    MC_ASSETS.with(|assets| {
        let assets = assets.borrow();
        let specs: Vec<AssetSpec> = assets.iter().map(|(spec, _)| *spec).collect();
        let processes: Vec<&dyn Process> =
            assets.iter().map(|(_, process)| process.as_process()).collect();

        match simulate_portfolio(&processes, &specs, &factor, time, &config) {
            Ok(result) => {
                MC_SUMMARY.with(|summary| {
                    *summary.borrow_mut() = [
                        result.mean,
                        result.variance,
                        result.skewness,
                        result.excess_kurtosis,
                        result.standard_error,
                        result.paths as f64,
                        result.steps as f64,
                        result.retained_values as f64,
                        result.cube_values as f64,
                    ];
                });
                let count = result.paths as i32;
                MC_RESULT.with(|slot| *slot.borrow_mut() = Some(result));
                count
            }
            Err(_) => -3,
        }
    })
}

/// Pointer to the summary block: mean, variance, skewness, excess kurtosis,
/// standard error, paths, steps, retained values, cube values.
#[no_mangle]
pub extern "C" fn pc_mc_summary() -> *const f64 {
    MC_SUMMARY.with(|s| s.borrow().as_ptr())
}

/// Pointer to the sorted terminal portfolio values, `paths` long.
///
/// Null when the last `pc_mc_run` failed, so a caller must check that call's
/// return code first. A WASM caller that does not reads address zero and gets
/// zeros; a native caller that does not has undefined behaviour. Both are the
/// caller's bug, and `pc_mc_sample_rows` returning zero is the cheap way to
/// notice it — which is how the parity harness found its own misuse of this.
#[no_mangle]
pub extern "C" fn pc_mc_terminal() -> *const f64 {
    MC_RESULT.with(|slot| {
        slot.borrow().as_ref().map(|r| r.terminal.as_ptr()).unwrap_or(core::ptr::null())
    })
}

/// Pointer to the sorted per-path maximum drawdowns, `paths` long.
#[no_mangle]
pub extern "C" fn pc_mc_drawdown() -> *const f64 {
    MC_RESULT.with(|slot| {
        slot.borrow().as_ref().map(|r| r.drawdown.as_ptr()).unwrap_or(core::ptr::null())
    })
}

/// Pointer to the path sample: `sample_paths` rows of `steps + 1` values.
#[no_mangle]
pub extern "C" fn pc_mc_sample() -> *const f64 {
    MC_RESULT.with(|slot| {
        slot.borrow().as_ref().map(|r| r.sample.as_ptr()).unwrap_or(core::ptr::null())
    })
}

#[no_mangle]
pub extern "C" fn pc_mc_sample_rows() -> i32 {
    MC_RESULT.with(|slot| {
        slot.borrow()
            .as_ref()
            .map(|r| if r.steps + 1 == 0 { 0 } else { (r.sample.len() / (r.steps + 1)) as i32 })
            .unwrap_or(0)
    })
}

/// Terminal-value percentile, `p` in [0, 1]. NaN with no result.
#[no_mangle]
pub extern "C" fn pc_mc_percentile(p: f64) -> f64 {
    MC_RESULT.with(|slot| slot.borrow().as_ref().map(|r| r.percentile(p)).unwrap_or(f64::NAN))
}

/// Drawdown percentile, in portfolio currency.
#[no_mangle]
pub extern "C" fn pc_mc_drawdown_percentile(p: f64) -> f64 {
    MC_RESULT
        .with(|slot| slot.borrow().as_ref().map(|r| r.drawdown_percentile(p)).unwrap_or(f64::NAN))
}

/// Conditional value at risk on the left tail at `alpha`.
#[no_mangle]
pub extern "C" fn pc_mc_cvar(alpha: f64) -> f64 {
    MC_RESULT.with(|slot| slot.borrow().as_ref().map(|r| r.cvar(alpha)).unwrap_or(f64::NAN))
}

// ---------------------------------------------------------------------------
// Heston: closed form and surface calibration (PRD 5.8)
// ---------------------------------------------------------------------------

/// Floats in the calibration result block.
pub const HESTON_FIT_STRIDE: usize = 11;

thread_local! {
    static HESTON_QUOTES: RefCell<Vec<Quote>> = const { RefCell::new(Vec::new()) };
    static HESTON_FIT: RefCell<[f64; HESTON_FIT_STRIDE]> =
        const { RefCell::new([0.0; HESTON_FIT_STRIDE]) };
}

fn heston_params(v0: f64, theta: f64, kappa: f64, sigma: f64, rho: f64) -> HestonParams {
    HestonParams { v0, theta, kappa, sigma, rho }
}

/// A European option under Heston, by the Lewis integral.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn pc_heston_price(
    spot: f64,
    strike: f64,
    time: f64,
    rate: f64,
    dividend: f64,
    is_call: i32,
    v0: f64,
    theta: f64,
    kappa: f64,
    sigma: f64,
    rho: f64,
) -> f64 {
    let inputs = Inputs {
        spot,
        strike,
        time,
        rate,
        dividend,
        vol: 0.2,
        kind: if is_call != 0 { OptionType::Call } else { OptionType::Put },
    };
    heston::price(&heston_params(v0, theta, kappa, sigma, rho), &inputs)
}

/// The Black-Scholes volatility that reproduces that price. NaN where vega has
/// collapsed and the inversion carries no information.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn pc_heston_iv(
    spot: f64,
    strike: f64,
    time: f64,
    rate: f64,
    dividend: f64,
    is_call: i32,
    v0: f64,
    theta: f64,
    kappa: f64,
    sigma: f64,
    rho: f64,
) -> f64 {
    let inputs = Inputs {
        spot,
        strike,
        time,
        rate,
        dividend,
        vol: 0.2,
        kind: if is_call != 0 { OptionType::Call } else { OptionType::Put },
    };
    heston::implied_vol(&heston_params(v0, theta, kappa, sigma, rho), &inputs)
}

/// `kappa theta / sigma^2`. Past `pc_heston_conditioning_limit` the closed form
/// is losing digits to cancellation; see `heston.rs`.
#[no_mangle]
pub extern "C" fn pc_heston_conditioning(
    v0: f64,
    theta: f64,
    kappa: f64,
    sigma: f64,
    rho: f64,
) -> f64 {
    heston::conditioning(&heston_params(v0, theta, kappa, sigma, rho))
}

#[no_mangle]
pub extern "C" fn pc_heston_conditioning_limit() -> f64 {
    heston::CONDITIONING_LIMIT
}

/// Clears the surface. Call before adding quotes.
#[no_mangle]
pub extern "C" fn pc_heston_surface_reset() {
    HESTON_QUOTES.with(|q| q.borrow_mut().clear());
}

/// Appends one market quote.
#[no_mangle]
pub extern "C" fn pc_heston_surface_add(
    strike: f64,
    time: f64,
    is_call: i32,
    vol: f64,
    weight: f64,
) {
    HESTON_QUOTES.with(|quotes| {
        quotes.borrow_mut().push(Quote {
            strike,
            time,
            kind: if is_call != 0 { OptionType::Call } else { OptionType::Put },
            vol,
            weight,
        });
    });
}

#[no_mangle]
pub extern "C" fn pc_heston_surface_len() -> i32 {
    HESTON_QUOTES.with(|q| q.borrow().len() as i32)
}

/// Fit Heston to the accumulated surface. Returns the quote count, or -1 when
/// the surface is empty.
///
/// `residual` is 0 for implied vol and 1 for price. Anything else is implied
/// vol, because a caller passing a code this build does not know should get the
/// residual the PRD's wings depend on rather than the other one.
///
/// This is not a browser call. At the default budget it is several seconds of
/// solid arithmetic on one thread; the TypeScript wrapper states the cost
/// before running it and refuses past a ceiling.
#[allow(clippy::too_many_arguments)]
#[no_mangle]
pub extern "C" fn pc_heston_calibrate(
    spot: f64,
    rate: f64,
    dividend: f64,
    residual: i32,
    population: i32,
    generations: i32,
    seed: f64,
) -> i32 {
    HESTON_QUOTES.with(|quotes| {
        let quotes = quotes.borrow();
        if quotes.is_empty() {
            return -1;
        }
        let surface = Surface { spot, rate, dividend, quotes: &quotes };
        let config = CalibrationConfig {
            residual: if residual == 1 { Residual::Price } else { Residual::ImpliedVol },
            de: DeConfig {
                population: population.max(4) as usize,
                generations: generations.max(1) as usize,
                seed: seed.abs() as u64,
                ..DeConfig::default()
            },
            bounds: heston::DEFAULT_BOUNDS,
        };
        let fit = heston::calibrate(&surface, &config);
        HESTON_FIT.with(|slot| {
            *slot.borrow_mut() = [
                fit.params.v0,
                fit.params.theta,
                fit.params.kappa,
                fit.params.sigma,
                fit.params.rho,
                fit.rmse,
                fit.worst,
                fit.worst_quote as f64,
                fit.skipped as f64,
                fit.score_spread,
                fit.feller,
            ];
        });
        quotes.len() as i32
    })
}

/// Pointer to the fit: v0, theta, kappa, sigma, rho, rmse, worst, worst quote,
/// skipped, score spread, Feller.
#[no_mangle]
pub extern "C" fn pc_heston_fit() -> *const f64 {
    HESTON_FIT.with(|f| f.borrow().as_ptr())
}
