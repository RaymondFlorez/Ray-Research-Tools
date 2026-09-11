fn main() {
    use pricing_core::american::{exact_price, fast_price};
    use pricing_core::bsm::{Inputs, OptionType};

    let mut worst: Vec<(f64, String)> = Vec::new();
    for kind in [OptionType::Call, OptionType::Put] {
        for moneyness in [0.6, 0.8, 0.95, 1.0, 1.05, 1.2, 1.5] {
            for t in [0.02, 0.05, 0.25, 1.0, 2.0] {
                for q in [0.0, 0.02, 0.06, 0.12] {
                    for vol in [0.15, 0.3, 0.6] {
                        let i = Inputs { spot: 100.0, strike: 100.0 * moneyness, time: t,
                                         rate: 0.05, dividend: q, vol, kind };
                        let e = exact_price(&i);
                        let f = fast_price(&i);
                        let err = (e - f).abs();
                        worst.push((err, format!("{:?} m={moneyness} T={t} q={q} vol={vol}  exact {e:.4} fast {f:.4}", kind)));
                    }
                }
            }
        }
    }
    worst.sort_by(|a, b| b.0.partial_cmp(&a.0).unwrap());
    println!("worst per-share errors (currency):");
    for (err, label) in worst.iter().take(10) { println!("  {err:.5}  {label}"); }
    let n = worst.len() as f64;
    let mean = worst.iter().map(|w| w.0).sum::<f64>() / n;
    let p95 = worst[(worst.len() as f64 * 0.05) as usize].0;
    println!("\n  cases {n}  mean {mean:.5}  p95 {p95:.5}  (half a tick = 0.005)");
}
