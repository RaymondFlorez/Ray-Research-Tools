//! The grid against cash dividends: what the dividend ladder costs, and how
//! close it lands. Run with `cargo run --release --example div_grid_bench`.
//!
//! The book is grid_bench's 40 American legs; the underlier pays 0.50 a
//! quarter. Accuracy is checked on sampled cells against a separate averaged
//! 4,000-step tree per leg, priced independently through `american_price`.

use std::time::Instant;

use pricing_core::bsm::{Inputs, OptionType};
use pricing_core::dividends::{american_price, CashDividend};
use pricing_core::grid::{self, GridSpec, GuardConfig, Leg, Market, Quality, Style};

fn book() -> Vec<Leg> {
    (0..40)
        .map(|i| Leg {
            strike: 80.0 + (i % 20) as f64 * 2.5,
            time: 0.08 + (i % 6) as f64 * 0.25,
            kind: if i % 2 == 0 { OptionType::Call } else { OptionType::Put },
            style: Style::American,
            quantity: if i % 3 == 0 { -10.0 } else { 5.0 },
            multiplier: 100.0,
            vol: 0.22 + (i % 7) as f64 * 0.03,
        })
        .collect()
}

fn main() {
    let market = Market { spot: 100.0, rate: 0.04, dividend: 0.0 };
    let dividends: Vec<CashDividend> = (0..6).map(|q| CashDividend { time: 0.05 + 0.25 * q as f64, amount: 0.5 }).collect();
    let b = book();
    let contracts: f64 = b.iter().map(|l| l.quantity.abs() * l.multiplier).sum();

    for quality in [Quality::Draft, Quality::Standard, Quality::Exact] {
        let mut spec = GridSpec::linear(25, 0.2, 15, 0.1);
        spec.quality = quality;
        let config = GuardConfig::default();
        grid::reprice_grid_with_dividends(&b, &market, &spec, &config, &dividends);
        let mut times = Vec::new();
        let mut last = None;
        for _ in 0..7 {
            let started = Instant::now();
            let r = grid::reprice_grid_with_dividends(&b, &market, &spec, &config, &dividends);
            times.push(started.elapsed().as_secs_f64() * 1e3);
            last = Some(r);
        }
        times.sort_by(|a, c| a.partial_cmp(c).unwrap());
        let r = last.unwrap();

        // Sampled cells against an independent tree per leg.
        let mut worst: f64 = 0.0;
        for &(si, vi) in &[(0usize, 0usize), (6, 7), (12, 7), (18, 14), (24, 3)] {
            let spot = market.spot * spec.spot_shocks[si];
            let shift = spec.vol_shifts[vi];
            let mut reference = 0.0;
            for leg in &b {
                let inputs = Inputs { spot, strike: leg.strike, time: leg.time, rate: market.rate, dividend: 0.0, vol: leg.vol + shift, kind: leg.kind };
                let value = 0.5 * (american_price(&inputs, &dividends, 4_000) + american_price(&inputs, &dividends, 4_001));
                reference += value * leg.quantity * leg.multiplier;
            }
            worst = worst.max((r.cell(si, vi).value - reference).abs());
        }
        println!(
            "{quality:?}: p50 {:.1}ms  max {:.1}ms  worst sampled error {:.2} ticks per contract  [{}]",
            times[times.len() / 2],
            times[times.len() - 1],
            worst / (0.01 * contracts),
            r.guard.badge
        );
    }
}
