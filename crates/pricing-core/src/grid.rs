//! Multi-leg repricing over a grid, with the accuracy guard (PRD 5.4, C.2).
//!
//! "A 40-leg book across a 25x15 spot-vol grid is 15,000 repricings."
//!
//! Every cell reprices the whole book, so the loop is the hot path and the
//! guard is what keeps it honest: a stratified sample of cells is priced both
//! ways, and if the fast path has drifted past tolerance the affected region is
//! repriced exactly. The badge the node shows says which happened.

use crate::american;
use crate::bsm::{self, Greeks, Inputs, OptionType};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Style {
    European,
    American,
}

/// One position in the book.
#[derive(Clone, Copy, Debug)]
pub struct Leg {
    pub strike: f64,
    pub time: f64,
    pub kind: OptionType,
    pub style: Style,
    /// Signed: negative is short.
    pub quantity: f64,
    /// Contract multiplier, 100 for listed US equity options.
    pub multiplier: f64,
    /// Per-leg vol, before the grid's vol shift.
    pub vol: f64,
}

/// Market state the whole book shares.
#[derive(Clone, Copy, Debug)]
pub struct Market {
    pub spot: f64,
    pub rate: f64,
    pub dividend: f64,
}

/// The axes. The PRD's worked example is 25 spots by 15 vols.
#[derive(Clone, Debug)]
pub struct GridSpec {
    /// Multiplicative shocks to spot: 1.0 is unchanged.
    pub spot_shocks: Vec<f64>,
    /// Additive shifts to vol, in vol points: 0.0 is unchanged.
    pub vol_shifts: Vec<f64>,
    /// Days of time decay applied to every leg.
    pub time_decay_days: f64,
}

impl GridSpec {
    pub fn cells(&self) -> usize {
        self.spot_shocks.len() * self.vol_shifts.len()
    }

    /// An evenly spaced grid, as a scenario node would build.
    pub fn linear(spot_steps: usize, spot_range: f64, vol_steps: usize, vol_range: f64) -> Self {
        let span = |n: usize, range: f64| -> Vec<f64> {
            if n <= 1 {
                return vec![0.0];
            }
            (0..n)
                .map(|i| -range + 2.0 * range * (i as f64) / ((n - 1) as f64))
                .collect()
        };
        GridSpec {
            spot_shocks: span(spot_steps, spot_range).into_iter().map(|s| 1.0 + s).collect(),
            vol_shifts: span(vol_steps, vol_range),
            time_decay_days: 0.0,
        }
    }
}

/// One cell: the book's value and aggregate Greeks under that shock.
#[derive(Clone, Copy, Debug, Default)]
pub struct Cell {
    pub value: f64,
    pub delta: f64,
    pub gamma: f64,
    pub vega: f64,
    pub theta: f64,
    /// True when this cell was escalated to the exact lattice.
    pub exact: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum GuardOutcome {
    /// No American legs; nothing to approximate.
    NotNeeded,
    /// Sampled, and the approximation held.
    Passed,
    /// Sampled, drifted, and the affected region was repriced exactly.
    Escalated,
}

#[derive(Clone, Debug)]
pub struct GuardReport {
    pub outcome: GuardOutcome,
    pub sampled_cells: usize,
    /// Largest absolute price error found in the sample, in currency.
    pub max_error: f64,
    /// The tolerance that applied, in currency.
    pub tolerance: f64,
    pub escalated_cells: usize,
    /// What the node shows: "approx, max err 0.3 ticks", or the escalation.
    pub badge: String,
}

#[derive(Clone, Debug)]
pub struct GridResult {
    pub cells: Vec<Cell>,
    pub spot_count: usize,
    pub vol_count: usize,
    pub guard: GuardReport,
    /// Repricings performed, the fast path and any escalation together.
    pub repricings: usize,
}

impl GridResult {
    pub fn cell(&self, spot_index: usize, vol_index: usize) -> Cell {
        self.cells[spot_index * self.vol_count + vol_index]
    }
}

#[derive(Clone, Copy, Debug)]
pub struct GuardConfig {
    /// Fraction of cells checked. C.2 says 2 percent.
    pub sample_fraction: f64,
    /// One tick, in currency. 0.01 for listed US equity options.
    pub tick_size: f64,
    /// Ticks of error tolerated before escalation.
    pub tolerance_ticks: f64,
    /// The other half of "whichever is tighter": bps of the position's notional.
    pub tolerance_bps_of_notional: f64,
    /// Seeds the stratified sample. Fixed, so a grid is reproducible and its
    /// cache key means something.
    pub seed: u64,
}

impl Default for GuardConfig {
    fn default() -> Self {
        GuardConfig {
            sample_fraction: 0.02,
            tick_size: 0.01,
            tolerance_ticks: 0.5,
            tolerance_bps_of_notional: 25.0,
            seed: 0x5EED_1234_ABCD_0001,
        }
    }
}

/// Deterministic sampler. The guard must pick the same cells every run, or the
/// same grid produces different badges and its cache key stops meaning anything.
struct Lcg(u64);

impl Lcg {
    fn next_u64(&mut self) -> u64 {
        self.0 = self.0.wrapping_mul(6_364_136_223_846_793_005).wrapping_add(1_442_695_040_888_963_407);
        self.0
    }

    fn below(&mut self, bound: usize) -> usize {
        if bound == 0 {
            0
        } else {
            (self.next_u64() >> 11) as usize % bound
        }
    }
}

fn leg_inputs(leg: &Leg, market: &Market, spot: f64, vol_shift: f64, decay: f64) -> Inputs {
    Inputs {
        spot,
        strike: leg.strike,
        time: (leg.time - decay).max(0.0),
        rate: market.rate,
        dividend: market.dividend,
        vol: (leg.vol + vol_shift).max(1e-6),
        kind: leg.kind,
    }
}

fn fast_greeks(inputs: &Inputs, style: Style) -> Greeks {
    match style {
        Style::European => bsm::greeks(inputs),
        Style::American => {
            // The approximation prices; the European Greeks carry the shape.
            // On the grid path that is the trade C.2 is making: Greeks accurate
            // enough to aggregate, prices measured by the guard.
            let mut g = bsm::greeks(inputs);
            g.price = american::fast_price(inputs);
            g
        }
    }
}

fn price_book(book: &[Leg], market: &Market, spot: f64, vol_shift: f64, decay: f64, exact: bool) -> Cell {
    let mut cell = Cell {
        exact,
        ..Default::default()
    };
    for leg in book {
        let inputs = leg_inputs(leg, market, spot, vol_shift, decay);
        let scale = leg.quantity * leg.multiplier;
        let mut g = fast_greeks(&inputs, leg.style);
        if exact && leg.style == Style::American {
            g.price = american::exact_price(&inputs);
        }
        cell.value += g.price * scale;
        cell.delta += g.delta * scale;
        cell.gamma += g.gamma * scale;
        cell.vega += g.vega * scale;
        cell.theta += g.theta * scale;
    }
    cell
}

/// Reprices the book across the grid, then checks itself.
pub fn reprice_grid(
    book: &[Leg],
    market: &Market,
    grid: &GridSpec,
    config: &GuardConfig,
) -> GridResult {
    let spot_count = grid.spot_shocks.len();
    let vol_count = grid.vol_shifts.len();
    let decay = grid.time_decay_days / 365.0;

    let mut cells = Vec::with_capacity(spot_count * vol_count);
    for &shock in &grid.spot_shocks {
        for &shift in &grid.vol_shifts {
            cells.push(price_book(book, market, market.spot * shock, shift, decay, false));
        }
    }
    let mut repricings = cells.len() * book.len();

    let has_american = book.iter().any(|leg| leg.style == Style::American);
    if !has_american {
        return GridResult {
            cells,
            spot_count,
            vol_count,
            guard: GuardReport {
                outcome: GuardOutcome::NotNeeded,
                sampled_cells: 0,
                max_error: 0.0,
                tolerance: 0.0,
                escalated_cells: 0,
                badge: "exact".to_string(),
            },
            repricings,
        };
    }

    // Tolerance: half a tick, or 25bps of notional, whichever is tighter.
    //
    // Both have to be expressed on the basis the comparison actually happens
    // on, which is the *book's* value, not one option's. Half a tick is half a
    // tick on every contract in the book; comparing a per-share tolerance
    // against a book-value error would escalate every grid ever priced.
    let contracts: f64 = book.iter().map(|leg| leg.quantity.abs() * leg.multiplier).sum();
    let notional: f64 = book
        .iter()
        .map(|leg| leg.quantity.abs() * leg.multiplier * leg.strike)
        .sum();
    let tolerance = (config.tolerance_ticks * config.tick_size * contracts)
        .min(config.tolerance_bps_of_notional / 10_000.0 * notional);

    // Stratified by spot band: the approximation fails at the edges of the
    // spot axis, so a sample that ignores stratification can miss it entirely.
    let strata = spot_count.min(8).max(1);
    let per_stratum = ((cells.len() as f64 * config.sample_fraction) / strata as f64).ceil() as usize;
    let mut rng = Lcg(config.seed);

    let mut max_error: f64 = 0.0;
    let mut failing_strata = vec![false; strata];
    let mut sampled = 0usize;

    for stratum in 0..strata {
        let lo = stratum * spot_count / strata;
        let hi = ((stratum + 1) * spot_count / strata).max(lo + 1).min(spot_count);
        for _ in 0..per_stratum.max(1) {
            let si = lo + rng.below(hi - lo);
            let vi = rng.below(vol_count);
            let spot = market.spot * grid.spot_shocks[si];
            let shift = grid.vol_shifts[vi];

            let exact = price_book(book, market, spot, shift, decay, true);
            repricings += book.len();
            sampled += 1;

            let error = (exact.value - cells[si * vol_count + vi].value).abs();
            if error > max_error {
                max_error = error;
            }
            if error > tolerance {
                failing_strata[stratum] = true;
            }
        }
    }

    let mut escalated = 0usize;
    for (stratum, failed) in failing_strata.iter().enumerate() {
        if !failed {
            continue;
        }
        let lo = stratum * spot_count / strata;
        let hi = ((stratum + 1) * spot_count / strata).max(lo + 1).min(spot_count);
        for si in lo..hi {
            for vi in 0..vol_count {
                let spot = market.spot * grid.spot_shocks[si];
                cells[si * vol_count + vi] =
                    price_book(book, market, spot, grid.vol_shifts[vi], decay, true);
                escalated += 1;
                repricings += book.len();
            }
        }
    }

    let outcome = if escalated > 0 {
        GuardOutcome::Escalated
    } else {
        GuardOutcome::Passed
    };
    let badge = match outcome {
        GuardOutcome::Escalated => format!("escalated: {escalated} cells repriced exact"),
        _ => format!(
            "approx, max err {:.1} ticks",
            if contracts > 0.0 { max_error / (config.tick_size * contracts) } else { 0.0 }
        ),
    };

    GridResult {
        cells,
        spot_count,
        vol_count,
        guard: GuardReport {
            outcome,
            sampled_cells: sampled,
            max_error,
            tolerance,
            escalated_cells: escalated,
            badge,
        },
        repricings,
    }
}

/// Aggregate Greeks for the book at the unshocked point (PRD 5.4).
pub fn book_greeks(book: &[Leg], market: &Market) -> Cell {
    price_book(book, market, market.spot, 0.0, 0.0, false)
}
