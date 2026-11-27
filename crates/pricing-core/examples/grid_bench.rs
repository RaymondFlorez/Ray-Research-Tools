//! The Phase 2 exit criterion: "40-leg book reprices over a 375-cell grid under
//! 90ms p95". Run with `cargo run --release --example grid_bench`.

use std::time::Instant;

use pricing_core::andersen_lake as al;
use pricing_core::bsm::{self, Inputs, OptionType};
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
        "every cell checked at the guard's scheme:", elapsed, result.repricings,
        if result.guard.outcome == GuardOutcome::Escalated { "escalated" } else { "passed" }
    );

    // Where the American book's time goes: a boundary per (leg, vol) at the
    // grid's scheme, a premium-table read per cell, and the guard's own solves.
    println!("\nwhere the time goes, per unit:");
    let inputs = Inputs { spot: 100.0, strike: 100.0, time: 0.5, rate: 0.04, dividend: 0.015, vol: 0.3, kind: OptionType::Put };
    for (name, scheme) in [("Draft", al::DRAFT), ("Standard", al::FAST), ("guard", al::GUARD)] {
        let solver = al::solver_for(scheme);
        let mut sink = 0.0;
        let started = Instant::now();
        for k in 0..2_000 {
            sink += solver.unit_put_boundary(0.04, 0.015, 0.3 + k as f64 * 1e-6, 0.5).at(0.2);
        }
        let solve = started.elapsed().as_secs_f64() * 1e6 / 2_000.0;
        let boundary = solver.unit_put_boundary(0.04, 0.015, 0.3, 0.5);
        let table = solver.premium_table(&boundary, 0.04, 0.015, 0.3, 0.5);
        let started = Instant::now();
        for k in 0..20_000 {
            sink += solver.price_on(&Inputs { spot: 90.0 + k as f64 * 1e-3, ..inputs }, &table);
        }
        let cell = started.elapsed().as_secs_f64() * 1e6 / 20_000.0;
        println!("  {name:<9} boundary solve {solve:>6.2}µs   price from its table {cell:>5.3}µs   ({sink:.0})");
    }
    let mut sink = 0.0;
    let started = Instant::now();
    for k in 0..20_000 {
        sink += bsm::greeks(&Inputs { spot: 90.0 + k as f64 * 1e-3, ..inputs }).delta;
    }
    let greeks = started.elapsed().as_secs_f64() * 1e6 / 20_000.0;
    println!("  Black-Scholes Greeks, every cell, every leg {greeks:.3}µs   ({sink:.0})");
}
