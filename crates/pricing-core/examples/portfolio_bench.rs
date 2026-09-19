//! The PRD's Monte Carlo shape, run and timed.
//!
//! > Execution: 100k paths x 252 steps x 40 assets runs on Ray across the
//! > cluster; result matrices persist to S3 and the node holds a reference plus
//! > summary statistics, so the browser never loads a 4GB array. — PRD 5.8
//!
//! > Monte Carlo 100k x 252 x 40 — 4.5s p50, 9s p95, 30s hard ceiling. — PRD 7.1
//!
//! Two numbers come out of this, and only one of them is about speed.
//!
//! The first is the elapsed time on **one core**, against a budget the PRD
//! explicitly says is met by a cluster. A single-threaded figure that misses it
//! is not a failure of this code; it is the measurement that says how much
//! parallelism the budget actually assumes, which is a thing worth knowing
//! before anyone builds the distribution layer.
//!
//! The second is the memory the result holds against the cube it never built.
//! That is the claim the PRD makes in its own sentence about the 4GB array, it
//! is hardware-independent, and it is the one that decides whether a browser
//! can hold the answer at all.
//!
//!   cargo run --release --example portfolio_bench

use pricing_core::copula::Factor;
use pricing_core::mc::{Gbm, Process};
use pricing_core::portfolio::{simulate_portfolio, AssetSpec, PortfolioConfig};
use std::time::Instant;

fn main() {
    let shapes: Vec<(usize, usize, usize)> = std::env::args()
        .nth(1)
        .map(|arg| {
            let parts: Vec<usize> = arg.split('x').map(|p| p.parse().expect("paths x steps x assets")).collect();
            vec![(parts[0], parts[1], parts[2])]
        })
        .unwrap_or_else(|| {
            vec![
                (10_000, 252, 40),
                (25_000, 252, 40),
                (50_000, 252, 40),
                (100_000, 252, 40),
            ]
        });

    println!(
        "{:>8} {:>6} {:>7} {:>10} {:>12} {:>10} {:>12} {:>9}",
        "paths", "steps", "assets", "elapsed", "steps/s", "retained", "cube", "ratio",
    );

    for (paths, steps, assets) in shapes {
        // Forty names with a spread of volatilities and a common factor, which
        // is what a real book looks like: one market, several clusters.
        let processes: Vec<Gbm> = (0..assets)
            .map(|i| Gbm { rate: 0.04, dividend: 0.01, vol: 0.18 + 0.02 * (i % 12) as f64 })
            .collect();
        let refs: Vec<&dyn Process> = processes.iter().map(|p| p as &dyn Process).collect();
        let specs: Vec<AssetSpec> = (0..assets)
            .map(|i| AssetSpec {
                spot: 40.0 + 3.0 * (i % 25) as f64,
                weight: if i % 7 == 0 { -200.0 } else { 100.0 },
                initial_variance: 0.0,
            })
            .collect();
        let factor = Factor::equicorrelated(assets, 0.45).expect("a valid correlation matrix");

        let config = PortfolioConfig {
            paths,
            steps,
            antithetic: true,
            seed: 0x5EED_BEEF,
            sample_paths: 64,
        };

        let started = Instant::now();
        let result = simulate_portfolio(&refs, &specs, &factor, 1.0, &config).expect("a run");
        let elapsed = started.elapsed();

        let asset_steps = (paths as f64) * (steps as f64) * (assets as f64);
        println!(
            "{:>8} {:>6} {:>7} {:>9.2}s {:>12.3e} {:>9.1}MB {:>11.1}GB {:>8.0}x",
            paths,
            steps,
            assets,
            elapsed.as_secs_f64(),
            asset_steps / elapsed.as_secs_f64(),
            (result.retained_values * 8) as f64 / 1_048_576.0,
            (result.cube_values * 8) as f64 / 1_073_741_824.0,
            result.compression(),
        );

        if paths >= 100_000 {
            println!(
                "\n  mean {:.2}  se {:.3}  skew {:+.3}  excess kurtosis {:+.3}",
                result.mean, result.standard_error, result.skewness, result.excess_kurtosis,
            );
            println!(
                "  terminal  p1 {:.0}  p5 {:.0}  p50 {:.0}  p95 {:.0}  p99 {:.0}",
                result.percentile(0.01),
                result.percentile(0.05),
                result.percentile(0.50),
                result.percentile(0.95),
                result.percentile(0.99),
            );
            println!(
                "  CVaR      1% {:.0}   5% {:.0}   10% {:.0}",
                result.cvar(0.01),
                result.cvar(0.05),
                result.cvar(0.10),
            );
            println!(
                "  drawdown  p50 {:.0}  p95 {:.0}  p99 {:.0}  worst {:.0}",
                result.drawdown_percentile(0.50),
                result.drawdown_percentile(0.95),
                result.drawdown_percentile(0.99),
                result.drawdown.last().copied().unwrap_or(f64::NAN),
            );
            let budget = 9.0;
            println!(
                "\n  PRD 7.1 p95 budget {budget:.0}s, single core {:.2}s — {}",
                elapsed.as_secs_f64(),
                if elapsed.as_secs_f64() <= budget {
                    "inside it on one core".to_string()
                } else {
                    format!(
                        "outside it by {:.1}x; the PRD budgets this shape on a cluster, so this is the number of cores the budget assumes",
                        elapsed.as_secs_f64() / budget
                    )
                },
            );
        }
    }
}
