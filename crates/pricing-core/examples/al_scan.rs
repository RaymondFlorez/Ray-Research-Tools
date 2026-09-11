//! Andersen-Lake against Bjerksund-Stensland, and both against a reference
//! that has itself been checked.
//!
//! The first table is the important one. The lattice cannot serve as the
//! reference here: Leisen-Reimer at 255 steps is off by more than a cent on
//! long-dated in-the-money puts, which is exactly the region early exercise
//! lives in. So the anchor runs the lattice out to 32,767 steps on a handful of
//! cases and shows it converging *towards* Andersen-Lake, and the sweep then
//! uses a heavily over-resolved Andersen-Lake scheme as its reference.
//!
//! That second reference grades scheme convergence, not correctness. The anchor
//! is what establishes correctness, and it is the reason the sweep is allowed to
//! use it.

use pricing_core::american::{self, DETAIL_STEPS, EXACT_STEPS};
use pricing_core::andersen_lake::{self as al, Scheme, Solver};
use pricing_core::bsm::{Inputs, OptionType};
use std::time::Instant;

/// So over-resolved that every scheme parameter is saturated several times over.
const REFERENCE: Scheme =
    Scheme { integration: 35, iterations: 128, collocation: 24, pricing: 39 };

fn case(is_call: bool, moneyness: f64, time: f64, vol: f64, rate: f64, dividend: f64) -> Inputs {
    Inputs {
        spot: 100.0,
        strike: 100.0 * moneyness,
        time,
        rate,
        dividend,
        vol,
        kind: if is_call { OptionType::Call } else { OptionType::Put },
    }
}

fn anchor() {
    println!("the reference, checked against a lattice run to convergence\n");
    println!(
        "{:<26} {:>12} {:>12} {:>12} {:>12}",
        "", "LR 255", "LR 4095", "LR 32767", "Andersen-Lake",
    );
    let reference = Solver::new(REFERENCE);
    let cases = [
        ("deep ITM put, 2y", case(false, 1.30, 2.0, 0.45, 0.05, 0.0)),
        ("ITM put, 2y", case(false, 1.15, 2.0, 0.30, 0.05, 0.0)),
        ("ATM put, 6m", case(false, 1.00, 0.5, 0.28, 0.045, 0.017)),
        ("OTM put, 1m", case(false, 0.85, 0.08, 0.35, 0.045, 0.017)),
        ("deep ITM call, 2y", case(true, 0.70, 2.0, 0.45, 0.02, 0.06)),
        ("ATM call on payer, 1y", case(true, 1.00, 1.0, 0.30, 0.02, 0.06)),
    ];
    for (label, inputs) in cases {
        println!(
            "{label:<26} {:>12.6} {:>12.6} {:>12.6} {:>12.6}",
            american::leisen_reimer_price(&inputs, 255),
            american::leisen_reimer_price(&inputs, 4095),
            american::leisen_reimer_price(&inputs, 32767),
            reference.price(&inputs),
        );
    }
    println!("\nthe lattice is still moving at 32,767 steps; Andersen-Lake is where it is going.");
}

struct Stats {
    label: &'static str,
    errors: Vec<f64>,
    nanos: u128,
}

impl Stats {
    fn new(label: &'static str) -> Stats {
        Stats { label, errors: Vec::new(), nanos: 0 }
    }

    fn report(&mut self) {
        self.errors.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let n = self.errors.len();
        println!(
            "{:<26} mean {:>9.6}  p95 {:>9.6}  max {:>9.6}   {:>8.2}us",
            self.label,
            self.errors.iter().sum::<f64>() / n as f64,
            self.errors[n * 95 / 100],
            self.errors[n - 1],
            self.nanos as f64 / 1000.0 / n as f64,
        );
    }
}

fn main() {
    anchor();

    let reference = Solver::new(REFERENCE);
    let mut rows = [
        Stats::new("Bjerksund-Stensland 93"),
        Stats::new("Andersen-Lake FAST"),
        Stats::new("Andersen-Lake ACCURATE"),
        Stats::new("Leisen-Reimer, 51 steps"),
        Stats::new("Leisen-Reimer, 255 steps"),
    ];

    let mut cases = 0usize;
    for &is_call in &[false, true] {
        for &moneyness in &[0.7, 0.85, 0.95, 1.0, 1.05, 1.15, 1.3] {
            for &time in &[0.02, 0.08, 0.25, 0.5, 1.0, 2.0] {
                for &vol in &[0.12, 0.2, 0.3, 0.45, 0.75] {
                    for &(rate, dividend) in
                        &[(0.045, 0.017), (0.02, 0.06), (0.05, 0.0), (0.01, 0.03)]
                    {
                        let inputs = case(is_call, moneyness, time, vol, rate, dividend);
                        let truth = reference.price(&inputs);
                        cases += 1;

                        let mut take = |slot: usize, f: &dyn Fn() -> f64| {
                            let t0 = Instant::now();
                            let v = f();
                            rows[slot].nanos += t0.elapsed().as_nanos();
                            rows[slot].errors.push((v - truth).abs());
                        };
                        take(0, &|| american::fast_price(&inputs));
                        take(1, &|| al::fast_price(&inputs));
                        take(2, &|| al::accurate_price(&inputs));
                        take(3, &|| american::leisen_reimer_price(&inputs, EXACT_STEPS));
                        take(4, &|| american::leisen_reimer_price(&inputs, DETAIL_STEPS));
                    }
                }
            }
        }
    }

    println!("\n\n{cases} cases against that reference");
    println!("absolute error per share, in currency\n");
    for row in rows.iter_mut() {
        row.report();
    }
    println!("\nhalf a tick on a listed US equity option is 0.005");
}
