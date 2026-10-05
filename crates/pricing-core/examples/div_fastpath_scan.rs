//! Why the grid has no fast path for American legs under cash dividends.
//! Run with `cargo run --release --example div_fastpath_scan`.
//!
//! 160 options (calls and puts; five strikes; four dividend schedules; two
//! vols), each against an averaged 8,000-step escrowed tree. Worst absolute
//! error per candidate, in ticks of 0.01.

use pricing_core::andersen_lake as al;
use pricing_core::bsm::{self, Inputs, OptionType};
use pricing_core::dividends::{american_price, european_price, escrowed_spot, CashDividend};

fn main() {
    let schedules: Vec<(f64, Vec<CashDividend>)> = vec![
        (0.5, vec![CashDividend { time: 0.45, amount: 2.0 }]),
        (0.5, vec![CashDividend { time: 0.1, amount: 1.0 }, CashDividend { time: 0.35, amount: 1.0 }]),
        (1.0, (0..4).map(|q| CashDividend { time: 0.2 + 0.25 * q as f64, amount: 1.5 }).collect()),
        (0.25, vec![CashDividend { time: 0.24, amount: 0.8 }]),
    ];
    let mut worst = std::collections::BTreeMap::<String, f64>::new();
    for &kind in &[OptionType::Call, OptionType::Put] {
        let label = if kind == OptionType::Call { "call" } else { "put " };
        for &k in &[80.0, 95.0, 100.0, 105.0, 120.0] {
            for (t, divs) in &schedules {
                for &v in &[0.2, 0.45] {
                    let inp = Inputs { spot: 100.0, strike: k, time: *t, rate: 0.05, dividend: 0.0, vol: v, kind };
                    let reference = 0.5 * (american_price(&inp, divs, 8_000) + american_price(&inp, divs, 8_001));
                    let mut record = |name: &str, value: f64| {
                        let w = worst.entry(format!("{label} {name}")).or_insert(0.0);
                        *w = w.max((value - reference).abs() / 0.01);
                    };
                    let escrowed = Inputs { spot: escrowed_spot(&inp, divs), ..inp };
                    let q = -libm::log(escrowed.spot / inp.spot) / inp.time;
                    let yield_equivalent = Inputs { dividend: q, ..inp };
                    record("Andersen-Lake on the escrowed spot", al::fast_price(&escrowed));
                    record("Andersen-Lake on an equal-forward yield", al::fast_price(&yield_equivalent));
                    record("European (no early exercise)", european_price(&inp, divs));
                    if kind == OptionType::Call {
                        // Black's pseudo-American: exercise just before the last ex-date.
                        let last = divs.iter().filter(|d| d.time < inp.time).map(|d| d.time).fold(0.0, f64::max);
                        let earlier: f64 = divs.iter().filter(|d| d.time < last).map(|d| d.amount * libm::exp(-inp.rate * d.time)).sum();
                        let early = bsm::price(&Inputs { spot: inp.spot - earlier, time: last - 1e-6, ..inp });
                        record(
                            "best: max(yield A-L, Black, European)",
                            al::fast_price(&yield_equivalent).max(early).max(european_price(&inp, divs)),
                        );
                    }
                    record("200-step tree, averaged with 201", 0.5 * (american_price(&inp, divs, 200) + american_price(&inp, divs, 201)));
                }
            }
        }
    }
    for (name, ticks) in worst {
        println!("{name:<50} worst {ticks:>7.1} ticks");
    }
}
