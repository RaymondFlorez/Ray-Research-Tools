//! Round-trip calibration: can it recover parameters it generated the surface from?

use pricing_core::de::DeConfig;
use pricing_core::heston::{self, CalibrationConfig, HestonParams, Quote, Residual, Surface};
use pricing_core::rng::Rng;
use std::time::Instant;

fn main() {
    let truth = HestonParams { v0: 0.042, theta: 0.058, kappa: 1.8, sigma: 0.55, rho: -0.68 };
    let spot = 100.0;
    let strikes = [70.0, 80.0, 90.0, 95.0, 100.0, 105.0, 110.0, 120.0, 130.0];
    let maturities = [0.08, 0.25, 0.5, 1.0, 2.0];

    let mut quotes: Vec<Quote> = Vec::new();
    heston::synthetic_surface(&truth, spot, 0.03, 0.01, &strikes, &maturities, &mut quotes);
    println!("surface: {} quotes ({} strikes x {} maturities)", quotes.len(), strikes.len(), maturities.len());

    let surface = Surface { spot, rate: 0.03, dividend: 0.01, quotes: &quotes };

    for seed in [0x5EED_0DEu64, 0xA11CE, 0xB0B] {
        let config = CalibrationConfig {
            residual: Residual::ImpliedVol,
            de: DeConfig { population: 50, generations: 150, seed, target: 1e-6, ..DeConfig::default() },
            ..CalibrationConfig::default()
        };
        let started = Instant::now();
        let fit = heston::calibrate(&surface, &config);
        let elapsed = started.elapsed();

        let p = fit.params;
        println!(
            "seed {seed:>9x}  rmse {:.2e}  worst {:.2e}  gens {:>3}  evals {:>6}  spread {:.2e}  {:.2}s",
            fit.rmse, fit.worst, fit.generations, fit.evaluations, fit.score_spread, elapsed.as_secs_f64(),
        );
        println!(
            "            v0 {:.4} ({:+.4})  theta {:.4} ({:+.4})  kappa {:.3} ({:+.3})  sigma {:.3} ({:+.3})  rho {:+.3} ({:+.3})",
            p.v0, p.v0 - truth.v0,
            p.theta, p.theta - truth.theta,
            p.kappa, p.kappa - truth.kappa,
            p.sigma, p.sigma - truth.sigma,
            p.rho, p.rho - truth.rho,
        );
    }

    // The honest case. A real surface is quoted to a tick, so the residual has
    // a floor no parameter set can get under, and the question stops being
    // "does it recover the truth" and becomes "how much of the truth is even
    // identified". Half a vol point of noise is a tight equity surface.
    println!("\n== with half a vol point of quote noise ==");
    for &noise in &[0.0005f64, 0.002, 0.005] {
        let mut recovered: Vec<HestonParams> = Vec::new();
        for seed in [1u64, 2, 3, 4, 5] {
            let mut rng = Rng::new(seed.wrapping_mul(0x9E37_79B9));
            let noisy: Vec<Quote> = quotes
                .iter()
                .map(|q| Quote { vol: q.vol + noise * rng.next_normal(), ..*q })
                .collect();
            let surface = Surface { spot, rate: 0.03, dividend: 0.01, quotes: &noisy };
            let config = CalibrationConfig {
                residual: Residual::ImpliedVol,
                de: DeConfig { population: 50, generations: 150, seed: 0xA11CE, ..DeConfig::default() },
                ..CalibrationConfig::default()
            };
            let fit = heston::calibrate(&surface, &config);
            recovered.push(fit.params);
        }

        let spread = |f: fn(&HestonParams) -> f64| {
            let values: Vec<f64> = recovered.iter().map(f).collect();
            let mean = values.iter().sum::<f64>() / values.len() as f64;
            let sd = (values.iter().map(|v| (v - mean) * (v - mean)).sum::<f64>()
                / (values.len() - 1) as f64)
                .sqrt();
            (mean, sd)
        };

        let (v0m, v0s) = spread(|p| p.v0);
        let (thm, ths) = spread(|p| p.theta);
        let (kam, kas) = spread(|p| p.kappa);
        let (sim, sis) = spread(|p| p.sigma);
        let (rhm, rhs) = spread(|p| p.rho);
        println!(
            "  noise {noise:.4}  v0 {v0m:.4}+/-{v0s:.4}  theta {thm:.4}+/-{ths:.4}  kappa {kam:.2}+/-{kas:.2}  sigma {sim:.3}+/-{sis:.3}  rho {rhm:+.3}+/-{rhs:.3}"
        );
        println!(
            "                 relative sd:  v0 {:.1}%   theta {:.1}%   kappa {:.1}%   sigma {:.1}%   rho {:.1}%",
            100.0 * v0s / v0m.abs(), 100.0 * ths / thm.abs(), 100.0 * kas / kam.abs(),
            100.0 * sis / sim.abs(), 100.0 * rhs / rhm.abs(),
        );
    }
}
