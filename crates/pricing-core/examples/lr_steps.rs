fn main() {
    use pricing_core::american::leisen_reimer_price;
    use pricing_core::bsm::{self, Inputs, OptionType};
    use std::time::Instant;
    println!("{:>6} {:>12} {:>12}", "steps", "max err", "us/price");
    for steps in [21usize, 31, 51, 101, 255] {
        let mut worst: f64 = 0.0;
        let mut count = 0u32;
        let started = Instant::now();
        for m in [0.7, 0.85, 1.0, 1.15, 1.3] {
            for t in [0.05, 0.25, 1.0, 2.0] {
                for vol in [0.15, 0.3, 0.6] {
                    // European reference: exact closed form, q=0 call has no early exercise.
                    let i = Inputs { spot: 100.0, strike: 100.0*m, time: t, rate: 0.05, dividend: 0.0, vol, kind: OptionType::Call };
                    let err = (leisen_reimer_price(&i, steps) - bsm::price(&i)).abs();
                    if err > worst { worst = err; }
                    count += 1;
                }
            }
        }
        let us = started.elapsed().as_secs_f64() * 1e6 / count as f64;
        println!("{steps:>6} {worst:>12.2e} {us:>12.1}");
    }
}
