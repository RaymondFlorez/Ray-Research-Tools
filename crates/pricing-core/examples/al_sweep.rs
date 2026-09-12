//! Which of the four numbers is actually limiting the error?
//!
//! Andersen-Lake's scheme is (integration, iterations, collocation, pricing).
//! Raising all four together says nothing about which one to spend on, so this
//! raises them one at a time from a common base.

use pricing_core::andersen_lake::{Scheme, Solver};
use pricing_core::bsm::{Inputs, OptionType};
use std::time::Instant;

/// Over-resolved several times over in every parameter, and anchored against a
/// 32,767-step lattice by `al_scan`'s first table.
const REFERENCE: Scheme =
    Scheme { integration: 35, iterations: 128, collocation: 24, pricing: 39 };

/// Every case in the sweep, and the reference price for each — computed once.
/// The reference costs about a millisecond a call, so recomputing it per row
/// would spend more time on the yardstick than on what is being measured.
fn corpus() -> Vec<(Inputs, f64)> {
    let reference = Solver::new(REFERENCE);
    let mut out = Vec::new();
    for &is_call in &[false, true] {
        for &moneyness in &[0.7, 0.85, 0.95, 1.0, 1.05, 1.15, 1.3] {
            for &time in &[0.02, 0.08, 0.25, 0.5, 1.0, 2.0] {
                for &vol in &[0.12, 0.2, 0.3, 0.45, 0.75] {
                    for &(rate, dividend) in
                        &[(0.045, 0.017), (0.02, 0.06), (0.05, 0.0), (0.01, 0.03)]
                    {
                        let inputs = Inputs {
                            spot: 100.0,
                            strike: 100.0 * moneyness,
                            time,
                            rate,
                            dividend,
                            vol,
                            kind: if is_call { OptionType::Call } else { OptionType::Put },
                        };
                        let truth = reference.price(&inputs);
                        out.push((inputs, truth));
                    }
                }
            }
        }
    }
    out
}

fn measure(cases: &[(Inputs, f64)], scheme: Scheme) -> (f64, f64, f64, f64) {
    let solver = Solver::new(scheme);
    let mut errors = Vec::with_capacity(cases.len());
    let mut nanos = 0u128;
    for (inputs, truth) in cases {
        let t0 = Instant::now();
        let v = solver.price(inputs);
        nanos += t0.elapsed().as_nanos();
        errors.push((v - truth).abs());
    }
    errors.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let n = errors.len();
    (
        errors.iter().sum::<f64>() / n as f64,
        errors[n * 95 / 100],
        errors[n - 1],
        nanos as f64 / 1000.0 / n as f64,
    )
}

fn row(cases: &[(Inputs, f64)], label: String, scheme: Scheme) {
    let (mean, p95, max, us) = measure(cases, scheme);
    println!(
        "{label:<28} mean {mean:>8.5}  p95 {p95:>8.5}  max {max:>8.5}  {us:>7.2}us",
    );
}

fn main() {
    println!("reference: Andersen-Lake (35,128,24,39), anchored in al_scan\n");
    let cases = corpus();
    let base = Scheme { integration: 9, iterations: 4, collocation: 6, pricing: 15 };
    row(&cases, "base (9,4,6,15)".into(), base);

    println!("\nintegration nodes in the fixed point");
    for l in [5, 9, 15, 25, 35] {
        row(&cases, format!("  l = {l}"), Scheme { integration: l, ..base });
    }

    println!("\nfixed-point iterations");
    for m in [1, 2, 4, 8, 16, 32] {
        row(&cases, format!("  m = {m}"), Scheme { iterations: m, ..base });
    }

    println!("\ncollocation intervals on the boundary");
    for n in [3, 6, 9, 12, 20] {
        row(&cases, format!("  n = {n}"), Scheme { collocation: n, ..base });
    }

    println!("\npricing-integral nodes");
    for p in [7, 15, 25, 39] {
        row(&cases, format!("  p = {p}"), Scheme { pricing: p, ..base });
    }

    // l, n and p are all saturated at their smallest useful settings, so the
    // only parameter worth spending on is the iteration count.
    println!("\ncandidates");
    for (l, m, n, q) in [
        (5, 5, 5, 5),
        (5, 6, 5, 7),
        (5, 7, 5, 7),
        (5, 8, 5, 7),
        (7, 8, 6, 7),
        (5, 8, 6, 9),
        (7, 8, 6, 11),
        (5, 12, 6, 9),
        (7, 16, 8, 15),
        (9, 24, 10, 19),
    ] {
        row(
            &cases,
            format!("  ({l},{m},{n},{q})"),
            Scheme { integration: l, iterations: m, collocation: n, pricing: q },
        );
    }
}
