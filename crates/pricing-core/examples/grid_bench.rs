//! The Phase 2 exit criterion: "40-leg book reprices over a 375-cell grid under
//! 90ms p95". Run with `cargo run --release --example grid_bench`.

use std::time::Instant;

use pricing_core::bsm::OptionType;
use pricing_core::grid::{self, GridSpec, GuardConfig, GuardOutcome, Leg, Market, Style};

fn book(legs: usize, style: Style) -> Vec<Leg> {
    (0..legs)
        .map(|i| Leg {
            strike: 80.0 + (i % 20) as f64 * 2.5,
            time: 0.08 + (i % 6) as f64 * 0.25,
            kind: if i % 2 == 0 { OptionType::Call } else { OptionType::Put },
            style,
            quantity: if i % 3 == 0 { -10.0 } else { 5.0 },
            multiplier: 100.0,
            vol: 0.22 + (i % 7) as f64 * 0.03,
        })
        .collect()
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() - 1) as f64 * p) as usize]
}

fn measure(label: &str, legs: usize, style: Style, runs: usize) {
    let market = Market { spot: 100.0, rate: 0.04, dividend: 0.015 };
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);
    let config = GuardConfig::default();
    let b = book(legs, style);

    // Warm up, then measure.
    for _ in 0..3 {
        grid::reprice_grid(&b, &market, &grid, &config);
    }

    let mut times = Vec::with_capacity(runs);
    let mut last = None;
    for _ in 0..runs {
        let started = Instant::now();
        let result = grid::reprice_grid(&b, &market, &grid, &config);
        times.push(started.elapsed().as_secs_f64() * 1000.0);
        last = Some(result);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let result = last.unwrap();

    let verdict = if percentile(&times, 0.95) < 90.0 { "under 90ms" } else { "OVER BUDGET" };
    println!(
        "{label:<38} cells {:>4}  repricings {:>7}  p50 {:>7.3}ms  p95 {:>7.3}ms  {verdict}",
        result.cells.len(),
        result.repricings,
        percentile(&times, 0.5),
        percentile(&times, 0.95),
    );
    println!(
        "{:<38} guard: {:?}, sampled {}, {}",
        "", result.guard.outcome, result.guard.sampled_cells, result.guard.badge
    );
}

fn main() {
    println!("Phase 2 exit criterion: 40 legs over a 25x15 grid, p95 under 90ms\n");
    measure("40 European legs", 40, Style::European, 200);
    measure("40 American legs (guard samples)", 40, Style::American, 20);
    measure("120 European legs", 120, Style::European, 100);
    measure("400 European legs", 400, Style::European, 40);

    // What the exact path would cost if it priced every cell.
    let market = Market { spot: 100.0, rate: 0.04, dividend: 0.015 };
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);
    let mut config = GuardConfig::default();
    config.sample_fraction = 1.0;
    let b = book(40, Style::American);
    let started = Instant::now();
    let result = grid::reprice_grid(&b, &market, &grid, &config);
    let elapsed = started.elapsed().as_secs_f64() * 1000.0;
    println!(
        "\n{:<38} {:.0}ms for {} repricings (guard: {:?})",
        "every cell on the lattice:", elapsed, result.repricings,
        if result.guard.outcome == GuardOutcome::Escalated { "escalated" } else { "passed" }
    );
}
