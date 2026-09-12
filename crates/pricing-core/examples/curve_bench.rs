//! "Curve bootstraps must run in the sub-millisecond range" (PRD 2.2).

use pricing_core::curve::{self, CurveShock, Instrument, STANDARD_TENORS};
use std::time::Instant;

fn market() -> Vec<Instrument> {
    let mut v = vec![
        Instrument::Deposit { maturity: 0.0833, rate: 0.0533 },
        Instrument::Deposit { maturity: 0.25, rate: 0.0528 },
        Instrument::Deposit { maturity: 0.5, rate: 0.0515 },
        Instrument::Future { start: 0.5, end: 0.75, rate: 0.0496, convexity_bps: 0.4 },
        Instrument::Future { start: 0.75, end: 1.0, rate: 0.0471, convexity_bps: 0.7 },
    ];
    for (maturity, rate) in [
        (2.0, 0.0428), (3.0, 0.0401), (4.0, 0.0392), (5.0, 0.0388), (6.0, 0.0387),
        (7.0, 0.0387), (8.0, 0.0389), (9.0, 0.0390), (10.0, 0.0392), (12.0, 0.0398),
        (15.0, 0.0404), (20.0, 0.0407), (25.0, 0.0403), (30.0, 0.0396),
    ] {
        v.push(Instrument::Swap { maturity, rate, frequency: 2.0 });
    }
    v
}

fn timed<T>(label: &str, runs: usize, mut f: impl FnMut() -> T) {
    let mut times = Vec::with_capacity(runs);
    for _ in 0..runs {
        let t0 = Instant::now();
        std::hint::black_box(f());
        times.push(t0.elapsed().as_secs_f64() * 1e6);
    }
    times.sort_by(|a, b| a.partial_cmp(b).unwrap());
    println!(
        "{label:<38} p50 {:>8.1}us  p95 {:>8.1}us  {}",
        times[runs / 2],
        times[runs * 95 / 100],
        if times[runs * 95 / 100] < 1000.0 { "sub-millisecond" } else { "OVER" },
    );
}

fn main() {
    let instruments = market();
    println!("{} instruments: 3 deposits, 2 futures, 14 swaps\n", instruments.len());

    timed("bootstrap", 2000, || curve::bootstrap(&instruments).unwrap());

    let built = curve::bootstrap(&instruments).unwrap();
    let worst = built
        .bootstrap_residuals(&instruments)
        .into_iter()
        .fold(0.0f64, |acc, r| acc.max(r.abs()));
    println!("{:<38} worst residual {worst:e}", "  reprices its own inputs to");

    timed("parallel shock, applied", 2000, || CurveShock::parallel(50.0).apply(&built));
    timed("steepener, applied", 2000, || CurveShock::steepener(40.0, 2.0).apply(&built));

    let flows: Vec<(f64, f64)> = {
        let mut f: Vec<(f64, f64)> = (1..=30).map(|i| (i as f64, 4.0)).collect();
        f[29].1 += 100.0;
        f
    };
    timed("DV01, 30y bond", 2000, || curve::dv01(&flows, &built));
    timed("key rate DV01, 10 buckets", 2000, || curve::key_rate_dv01(&flows, &built));

    let zeros: Vec<f64> = STANDARD_TENORS.iter().map(|&t| built.zero_rate(t)).collect();
    timed("Nelson-Siegel-Svensson fit", 200, || {
        curve::fit_nss(&STANDARD_TENORS, &zeros).unwrap()
    });
}
