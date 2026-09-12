//! What each quality level costs, and what it buys.
//!
//! The knob exists because the PRD's 90ms p95 is met by the engine and missed
//! by a browser on the hardest book. These are the native numbers; the WASM
//! ones are in `@picasso/canvas-pricing`'s test output, at roughly two and a
//! half times these.

use pricing_core::bsm::OptionType;
use pricing_core::grid::{self, GridSpec, GuardConfig, Leg, Market, Quality, Style};
use std::time::Instant;

fn book(count: usize, american: usize) -> Vec<Leg> {
    (0..count)
        .map(|i| Leg {
            strike: 80.0 + (i % 20) as f64 * 2.5,
            time: 0.08 + (i % 5) as f64 * 0.24,
            kind: if i % 2 == 0 { OptionType::Call } else { OptionType::Put },
            style: if i < american { Style::American } else { Style::European },
            quantity: if i % 3 == 0 { -5.0 } else { 5.0 },
            multiplier: 100.0,
            vol: 0.22 + (i % 7) as f64 * 0.02,
        })
        .collect()
}

fn main() {
    let market = Market { spot: 100.0, rate: 0.045, dividend: 0.017 };
    println!("40 legs over a 25x15 grid, against the PRD's 90ms p95\n");
    println!("{:<12} {:>20} {:>10} {:>10}  {}", "quality", "American legs", "p50", "p95", "badge");

    for american in [40usize, 20] {
        for quality in [Quality::Draft, Quality::Standard, Quality::Exact] {
            let legs = book(40, american);
            let spec = GridSpec { quality, ..GridSpec::linear(25, 0.2, 15, 0.1) };

            // Warm the solver tables.
            let warm = grid::reprice_grid(&legs, &market, &spec, &GuardConfig::default());
            let mut runs = Vec::new();
            for _ in 0..7 {
                let t0 = Instant::now();
                let result = grid::reprice_grid(&legs, &market, &spec, &GuardConfig::default());
                runs.push(t0.elapsed().as_secs_f64() * 1000.0);
                std::hint::black_box(result.cells.len());
            }
            runs.sort_by(|a, b| a.partial_cmp(b).unwrap());
            println!(
                "{:<12} {:>20} {:>9.1}ms {:>9.1}ms  {}",
                format!("{quality:?}"),
                format!("{american} of 40"),
                runs[3],
                runs[6],
                warm.guard.badge,
            );
        }
        println!();
    }
}
