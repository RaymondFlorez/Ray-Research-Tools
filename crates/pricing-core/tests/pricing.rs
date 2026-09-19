//! Correctness tests for the pricing core.
//!
//! Where a published reference value exists it is used; where one does not, the
//! test checks an identity that must hold whatever the implementation (parity,
//! monotonicity, Greeks against finite differences of the price they claim to
//! be the derivative of). Identities catch transcription errors that a single
//! reference value walks straight past.

use pricing_core::american::{self, binomial_price};
use pricing_core::bsm::{self, Inputs, OptionType};
use pricing_core::grid::{self, GridSpec, GuardConfig, GuardOutcome, Leg, Market, Style};
use pricing_core::implied::{implied_vol, SolveFailure};
use pricing_core::normal;

fn call(spot: f64, strike: f64, time: f64, rate: f64, dividend: f64, vol: f64) -> Inputs {
    Inputs { spot, strike, time, rate, dividend, vol, kind: OptionType::Call }
}

fn put(spot: f64, strike: f64, time: f64, rate: f64, dividend: f64, vol: f64) -> Inputs {
    Inputs { spot, strike, time, rate, dividend, vol, kind: OptionType::Put }
}

#[test]
fn normal_cdf_matches_known_values() {
    assert!((normal::cdf(0.0) - 0.5).abs() < 1e-15);
    assert!((normal::cdf(1.0) - 0.841_344_746_068_543).abs() < 1e-12);
    assert!((normal::cdf(-1.0) - 0.158_655_253_931_457).abs() < 1e-12);
    assert!((normal::cdf(1.96) - 0.975_002_104_851_780).abs() < 1e-12);
    // The far tail, where the wing solves live. Relative, because an absolute
    // tolerance on a value of 1e-9 says nothing about the digits that matter.
    // Measured: the continued-fraction branch holds about 5e-10 relative here.
    let tail = normal::cdf(-6.0);
    assert!(((tail - 9.865_876_450_377e-10) / 9.865_876_450_377e-10).abs() < 1e-8, "tail was {tail}");
    assert_eq!(normal::cdf(40.0), 1.0);
    assert_eq!(normal::cdf(-40.0), 0.0);
}

#[test]
fn normal_cdf_is_monotone_and_symmetric() {
    let mut previous = 0.0;
    let mut x = -8.0;
    while x <= 8.0 {
        let value = normal::cdf(x);
        assert!(value >= previous, "not monotone at {x}");
        assert!((value + normal::cdf(-x) - 1.0).abs() < 1e-12, "not symmetric at {x}");
        previous = value;
        x += 0.01;
    }
}

#[test]
fn inverse_normal_round_trips() {
    for p in [0.001, 0.01, 0.1, 0.25, 0.5, 0.75, 0.9, 0.99, 0.999] {
        let x = normal::inv_cdf(p);
        assert!((normal::cdf(x) - p).abs() < 1e-9, "round trip failed at {p}");
    }
}

#[test]
fn black_scholes_matches_reference_values() {
    // Hull, Options Futures and Other Derivatives: S=42, K=40, r=10%, sigma=20%,
    // T=0.5 gives a call of 4.76 and a put of 0.81.
    let c = bsm::price(&call(42.0, 40.0, 0.5, 0.10, 0.0, 0.20));
    let p = bsm::price(&put(42.0, 40.0, 0.5, 0.10, 0.0, 0.20));
    assert!((c - 4.759_422).abs() < 1e-5, "call was {c}");
    assert!((p - 0.808_599).abs() < 1e-5, "put was {p}");
}

#[test]
fn put_call_parity_holds() {
    for spot in [50.0, 100.0, 150.0] {
        for vol in [0.1, 0.3, 0.8] {
            for time in [0.05, 1.0, 3.0] {
                let c = bsm::price(&call(spot, 100.0, time, 0.04, 0.02, vol));
                let p = bsm::price(&put(spot, 100.0, time, 0.04, 0.02, vol));
                let lhs = c - p;
                let rhs = spot * (-0.02 * time).exp() - 100.0 * (-0.04 * time).exp();
                assert!((lhs - rhs).abs() < 1e-10, "parity broke at S={spot} vol={vol} T={time}");
            }
        }
    }
}

#[test]
fn greeks_agree_with_finite_differences_of_the_price() {
    // Every Greek claims to be a derivative of the price. This checks that it is.
    for kind in [OptionType::Call, OptionType::Put] {
        for spot in [80.0, 100.0, 125.0] {
            for vol in [0.15, 0.45] {
                let base = Inputs { spot, strike: 100.0, time: 0.75, rate: 0.03, dividend: 0.01, vol, kind };
                let g = bsm::greeks(&base);

                let bump = |f: &dyn Fn(&mut Inputs)| {
                    let mut copy = base;
                    f(&mut copy);
                    bsm::price(&copy)
                };

                let h = 1e-5;
                let up = bump(&|i: &mut Inputs| i.spot += h);
                let down = bump(&|i: &mut Inputs| i.spot -= h);
                let fd_delta = (up - down) / (2.0 * h);
                let fd_gamma = (up - 2.0 * g.price + down) / (h * h);
                assert!((g.delta - fd_delta).abs() < 1e-6, "delta {} vs {}", g.delta, fd_delta);
                assert!((g.gamma - fd_gamma).abs() < 1e-3, "gamma {} vs {}", g.gamma, fd_gamma);

                let hv = 1e-6;
                let fd_vega = (bump(&|i: &mut Inputs| i.vol += hv) - bump(&|i: &mut Inputs| i.vol -= hv)) / (2.0 * hv);
                assert!((g.vega - fd_vega).abs() < 1e-4, "vega {} vs {}", g.vega, fd_vega);

                let hr = 1e-7;
                let fd_rho = (bump(&|i: &mut Inputs| i.rate += hr) - bump(&|i: &mut Inputs| i.rate -= hr)) / (2.0 * hr);
                assert!((g.rho - fd_rho).abs() < 1e-3, "rho {} vs {}", g.rho, fd_rho);

                let ht = 1e-6;
                let fd_theta = -(bump(&|i: &mut Inputs| i.time += ht) - bump(&|i: &mut Inputs| i.time -= ht)) / (2.0 * ht);
                assert!((g.theta - fd_theta).abs() < 1e-3, "theta {} vs {}", g.theta, fd_theta);

                // The second-order Greeks: derivatives of delta and vega.
                let delta_of = |f: &dyn Fn(&mut Inputs)| {
                    let mut copy = base;
                    f(&mut copy);
                    bsm::greeks(&copy).delta
                };
                let fd_vanna = (delta_of(&|i: &mut Inputs| i.vol += hv) - delta_of(&|i: &mut Inputs| i.vol -= hv)) / (2.0 * hv);
                assert!((g.vanna - fd_vanna).abs() < 1e-4, "vanna {} vs {}", g.vanna, fd_vanna);

                let vega_of = |f: &dyn Fn(&mut Inputs)| {
                    let mut copy = base;
                    f(&mut copy);
                    bsm::greeks(&copy).vega
                };
                let fd_volga = (vega_of(&|i: &mut Inputs| i.vol += hv) - vega_of(&|i: &mut Inputs| i.vol -= hv)) / (2.0 * hv);
                assert!((g.volga - fd_volga).abs() < 1e-2, "volga {} vs {}", g.volga, fd_volga);

                let fd_charm = -(delta_of(&|i: &mut Inputs| i.time += ht) - delta_of(&|i: &mut Inputs| i.time -= ht)) / (2.0 * ht);
                assert!((g.charm - fd_charm).abs() < 1e-3, "charm {} vs {}", g.charm, fd_charm);

                let gamma_of = |f: &dyn Fn(&mut Inputs)| {
                    let mut copy = base;
                    f(&mut copy);
                    bsm::greeks(&copy).gamma
                };
                let hs = 1e-3;
                let fd_speed = (gamma_of(&|i: &mut Inputs| i.spot += hs) - gamma_of(&|i: &mut Inputs| i.spot -= hs)) / (2.0 * hs);
                assert!((g.speed - fd_speed).abs() < 1e-4, "speed {} vs {}", g.speed, fd_speed);
            }
        }
    }
}

#[test]
fn degenerate_inputs_return_intrinsic_rather_than_nan() {
    let expired = call(110.0, 100.0, 0.0, 0.05, 0.0, 0.3);
    assert_eq!(bsm::price(&expired), 10.0);
    assert_eq!(bsm::greeks(&expired).delta, 1.0);

    let zero_vol = call(110.0, 100.0, 1.0, 0.0, 0.0, 0.0);
    assert!((bsm::price(&zero_vol) - 10.0).abs() < 1e-12);

    let worthless = put(110.0, 100.0, 0.0, 0.05, 0.0, 0.3);
    assert_eq!(bsm::price(&worthless), 0.0);
    assert!(bsm::greeks(&worthless).price.is_finite());
}

#[test]
fn implied_vol_round_trips_across_the_surface() {
    for kind in [OptionType::Call, OptionType::Put] {
        for moneyness in [0.6, 0.8, 1.0, 1.2, 1.6] {
            for vol in [0.08, 0.2, 0.6, 1.5] {
                for time in [0.02, 0.25, 2.0] {
                    let inputs = Inputs {
                        spot: 100.0, strike: 100.0 * moneyness, time,
                        rate: 0.04, dividend: 0.01, vol, kind,
                    };
                    let target = bsm::price(&inputs);
                    // Below a tenth of a cent there is no information left to
                    // invert; a real chain would not quote it either.
                    if target < 1e-3 { continue; }

                    match implied_vol(&inputs, target) {
                        Ok(solved) => assert!(
                            (solved.vol - vol).abs() < 1e-6,
                            "got {} want {vol} at moneyness {moneyness} T={time}",
                            solved.vol
                        ),
                        // Deep in the money and near expiry, vega is zero and
                        // the price says nothing about vol. Refusing is right.
                        Err(SolveFailure::NotIdentifiable) => {
                            assert!(bsm::greeks(&inputs).vega < 1e-3, "refused a solvable case");
                        }
                        Err(e) => panic!("failed at {moneyness}/{vol}/{time}: {e:?}"),
                    }
                }
            }
        }
    }
}

#[test]
fn implied_vol_refuses_impossible_prices() {
    let inputs = call(100.0, 100.0, 1.0, 0.04, 0.0, 0.2);
    assert_eq!(implied_vol(&inputs, -1.0).unwrap_err(), SolveFailure::BelowIntrinsic);
    // At or above the forward, no volatility reproduces the price.
    assert_eq!(implied_vol(&inputs, 200.0).unwrap_err(), SolveFailure::AboveUpperBound);
    let expired = call(100.0, 100.0, 0.0, 0.04, 0.0, 0.2);
    assert_eq!(implied_vol(&expired, 5.0).unwrap_err(), SolveFailure::Degenerate);
}

#[test]
fn american_is_never_worth_less_than_european_or_intrinsic() {
    for kind in [OptionType::Call, OptionType::Put] {
        for spot in [60.0, 100.0, 140.0] {
            for dividend in [0.0, 0.03, 0.08] {
                for time in [0.1, 1.0] {
                    let inputs = Inputs { spot, strike: 100.0, time, rate: 0.05, dividend, vol: 0.3, kind };
                    let euro = bsm::price(&inputs);
                    let fast = american::fast_price(&inputs);
                    let exact = american::exact_price(&inputs);
                    assert!(fast >= euro - 1e-8, "fast {fast} < euro {euro}");
                    // The lattice has its own discretisation error: about
                    // 5.6e-4 per share at EXACT_STEPS, per the sweep in
                    // examples/lr_steps.rs. Holding it tighter than its own
                    // accuracy would be testing the tolerance, not the code.
                    assert!(exact >= euro - 1e-3, "exact {exact} < euro {euro}");
                    assert!(exact >= inputs.intrinsic() - 1e-3);
                }
            }
        }
    }
}

#[test]
fn an_american_call_on_a_non_dividend_payer_is_a_european_call() {
    // The textbook result: with no dividend, early exercise is never optimal.
    let inputs = call(100.0, 95.0, 1.0, 0.05, 0.0, 0.3);
    let euro = bsm::price(&inputs);
    assert!((american::fast_price(&inputs) - euro).abs() < 1e-10);
    assert!((american::exact_price(&inputs) - euro).abs() < 0.02, "lattice drifted from BSM");
}

#[test]
fn the_american_put_carries_an_early_exercise_premium() {
    // Deep in the money with a high rate: exercising early to earn interest on
    // the strike is worth real money.
    let inputs = put(60.0, 100.0, 1.0, 0.10, 0.0, 0.25);
    let euro = bsm::price(&inputs);
    let exact = american::exact_price(&inputs);
    assert!(exact > euro + 1.0, "premium was only {}", exact - euro);
    assert!(exact >= 40.0, "should be at least intrinsic, got {exact}");
}

#[test]
fn the_binomial_converges_as_steps_increase() {
    let inputs = call(100.0, 100.0, 1.0, 0.05, 0.0, 0.25);
    let reference = bsm::price(&inputs);
    let coarse = (binomial_price(&inputs, 50) - reference).abs();
    let fine = (binomial_price(&inputs, 800) - reference).abs();
    assert!(fine < coarse, "800 steps ({fine}) no better than 50 ({coarse})");
    assert!(fine < 0.01, "800 steps still off by {fine}");
}

// ---- The accuracy guard (Appendix C.2) ------------------------------------

fn european_book(legs: usize) -> Vec<Leg> {
    (0..legs)
        .map(|i| Leg {
            strike: 80.0 + (i % 20) as f64 * 2.5,
            time: 0.08 + (i % 6) as f64 * 0.25,
            kind: if i % 2 == 0 { OptionType::Call } else { OptionType::Put },
            style: Style::European,
            quantity: if i % 3 == 0 { -10.0 } else { 5.0 },
            multiplier: 100.0,
            vol: 0.22 + (i % 7) as f64 * 0.03,
        })
        .collect()
}

#[test]
fn the_guard_does_not_run_when_there_is_nothing_to_approximate() {
    let market = Market { spot: 100.0, rate: 0.04, dividend: 0.01 };
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);
    let result = grid::reprice_grid(&european_book(40), &market, &grid, &GuardConfig::default());

    assert_eq!(result.guard.outcome, GuardOutcome::NotNeeded);
    assert_eq!(result.guard.badge, "exact");
    assert_eq!(result.cells.len(), 375);
}

/// The book that used to escalate, and no longer does.
///
/// Chosen from measurement: Bjerksund-Stensland 1993 was worst on deep
/// in-the-money, long-dated, high-vol puts, and put this book roughly 58 cents
/// per share out against the lattice — a hundred times the half-tick tolerance.
/// The guard escalated almost every cell of it, which is what argued for
/// building Andersen-Lake in the first place.
///
/// The same book now passes, and the assertion at the bottom is why: on one of
/// these contracts the closed form is still tens of cents out, and the solver
/// the grid actually uses is not.
#[test]
fn the_region_that_used_to_escalate_now_passes() {
    let book: Vec<Leg> = (0..8)
        .map(|i| Leg {
            strike: 150.0 + i as f64,
            time: 2.0,
            kind: OptionType::Put,
            style: Style::American,
            quantity: 50.0,
            multiplier: 100.0,
            vol: 0.6,
        })
        .collect();
    let market = Market { spot: 100.0, rate: 0.05, dividend: 0.02 };
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);

    let result = grid::reprice_grid(&book, &market, &grid, &GuardConfig::default());
    assert_eq!(result.guard.outcome, GuardOutcome::Passed, "badge: {}", result.guard.badge);
    assert_eq!(result.guard.escalated_cells, 0);
    assert!(result.cells.iter().all(|c| !c.exact));

    // The approximation that used to sit on the grid path, on one of these
    // contracts, against the one that sits there now.
    let contract = Inputs {
        spot: 100.0,
        strike: 150.0,
        time: 2.0,
        rate: 0.05,
        dividend: 0.02,
        vol: 0.6,
        kind: OptionType::Put,
    };
    let truth = pricing_core::andersen_lake::accurate_price(&contract);
    let closed_form = (american::fast_price(&contract) - truth).abs();
    let solver = (pricing_core::andersen_lake::fast_price(&contract) - truth).abs();
    assert!(closed_form > 0.2, "closed form was only {closed_form} out");
    assert!(solver < 5e-3, "solver was {solver} out");
}

/// The escalation path itself, still exercised.
///
/// With an accurate fast path no realistic book escalates any more, so the way
/// to test the mechanism is to make the tolerance smaller than the
/// approximation instead of the other way round. A tick of a hundredth of a
/// cent is not a market anyone trades, but it is a guard doing exactly what it
/// would do if a future approximation were this far out.
#[test]
fn the_guard_escalates_when_the_tolerance_is_tighter_than_the_approximation() {
    let book: Vec<Leg> = (0..8)
        .map(|i| Leg {
            strike: 150.0 + i as f64,
            time: 2.0,
            kind: OptionType::Put,
            style: Style::American,
            quantity: 50.0,
            multiplier: 100.0,
            vol: 0.6,
        })
        .collect();
    let market = Market { spot: 100.0, rate: 0.05, dividend: 0.02 };
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);
    let config = GuardConfig { tick_size: 1e-6, ..GuardConfig::default() };

    let result = grid::reprice_grid(&book, &market, &grid, &config);
    assert_eq!(result.guard.outcome, GuardOutcome::Escalated, "badge: {}", result.guard.badge);
    assert!(result.guard.escalated_cells > 0);
    assert!(result.guard.badge.starts_with("escalated:"), "badge was {}", result.guard.badge);
    // Escalated cells are marked, so the node can say which numbers are exact.
    assert!(result.cells.iter().any(|c| c.exact));
}

#[test]
fn the_guard_passes_where_the_fast_path_is_genuinely_exact() {
    // American calls on a non-dividend payer: early exercise is never optimal,
    // so the approximation returns the European price and is exact by
    // construction. This is the honest "passes" case.
    //
    // It is also, on the measurements in `examples/error_scan.rs`, close to the
    // only one. Bjerksund-Stensland 1993 misses a half-tick by 1-2 cents even
    // on short-dated at-the-money puts, so anywhere early exercise carries
    // value this guard escalates. See the README: that is the guard working,
    // and it is the argument for the more accurate method C.2 specifies.
    let book: Vec<Leg> = (0..12)
        .map(|i| Leg {
            strike: 95.0 + i as f64,
            time: 0.5,
            kind: OptionType::Call,
            style: Style::American,
            quantity: 10.0,
            multiplier: 100.0,
            vol: 0.25,
        })
        .collect();
    let market = Market { spot: 100.0, rate: 0.04, dividend: 0.0 };
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);

    let result = grid::reprice_grid(&book, &market, &grid, &GuardConfig::default());
    assert_eq!(result.guard.outcome, GuardOutcome::Passed, "badge: {}", result.guard.badge);
    assert_eq!(result.guard.escalated_cells, 0);
    assert!(result.guard.badge.starts_with("approx,"), "badge was {}", result.guard.badge);
    assert!(result.guard.max_error <= result.guard.tolerance);
}

#[test]
fn the_guard_is_deterministic() {
    // The same grid must produce the same badge and the same sample, or its
    // cache key means nothing.
    let book: Vec<Leg> = (0..12)
        .map(|i| Leg {
            strike: 95.0 + i as f64,
            time: 0.4,
            kind: OptionType::Put,
            style: Style::American,
            quantity: 10.0,
            multiplier: 100.0,
            vol: 0.3,
        })
        .collect();
    let market = Market { spot: 100.0, rate: 0.05, dividend: 0.02 };
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);
    let config = GuardConfig::default();

    let first = grid::reprice_grid(&book, &market, &grid, &config);
    let second = grid::reprice_grid(&book, &market, &grid, &config);

    assert_eq!(first.guard.badge, second.guard.badge);
    assert_eq!(first.guard.sampled_cells, second.guard.sampled_cells);
    assert_eq!(first.guard.escalated_cells, second.guard.escalated_cells);
    for (a, b) in first.cells.iter().zip(second.cells.iter()) {
        assert_eq!(a.value, b.value);
    }
}

#[test]
fn the_guard_samples_about_two_percent() {
    let book: Vec<Leg> = vec![Leg {
        strike: 100.0, time: 0.5, kind: OptionType::Put, style: Style::American,
        quantity: 1.0, multiplier: 100.0, vol: 0.25,
    }];
    let market = Market { spot: 100.0, rate: 0.03, dividend: 0.01 };
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);
    let result = grid::reprice_grid(&book, &market, &grid, &GuardConfig::default());

    // 2 percent of 375 is 7.5, spread over 8 strata: at least one per stratum.
    assert!(result.guard.sampled_cells >= 8, "sampled {}", result.guard.sampled_cells);
    assert!(result.guard.sampled_cells <= 24, "sampled {}", result.guard.sampled_cells);
}

#[test]
fn the_grid_shape_and_shocks_are_what_was_asked_for() {
    let grid = GridSpec::linear(25, 0.2, 15, 0.1);
    assert_eq!(grid.cells(), 375);
    assert_eq!(grid.spot_shocks.len(), 25);
    assert_eq!(grid.vol_shifts.len(), 15);
    assert!((grid.spot_shocks[0] - 0.8).abs() < 1e-12);
    assert!((grid.spot_shocks[24] - 1.2).abs() < 1e-12);
    assert!((grid.vol_shifts[7]).abs() < 1e-12);
}

#[test]
fn book_greeks_aggregate_across_legs_and_sign_the_shorts() {
    let market = Market { spot: 100.0, rate: 0.04, dividend: 0.0 };
    let long = vec![Leg {
        strike: 100.0, time: 1.0, kind: OptionType::Call, style: Style::European,
        quantity: 1.0, multiplier: 100.0, vol: 0.25,
    }];
    let mut short = long.clone();
    short[0].quantity = -1.0;

    let long_greeks = grid::book_greeks(&long, &market);
    let short_greeks = grid::book_greeks(&short, &market);
    assert!((long_greeks.delta + short_greeks.delta).abs() < 1e-12);
    assert!(long_greeks.delta > 0.0 && short_greeks.delta < 0.0);
    assert!((long_greeks.value + short_greeks.value).abs() < 1e-12);
}

// ---------------------------------------------------------------------------
// Multi-asset Monte Carlo (PRD 5.8)
// ---------------------------------------------------------------------------

mod portfolio_tests {
    use pricing_core::copula::Factor;
    use pricing_core::mc::{Gbm, Process};
    use pricing_core::portfolio::{
        simulate_portfolio, AssetSpec, PortfolioConfig, PortfolioError,
    };

    fn gbm(vol: f64) -> Gbm {
        Gbm { rate: 0.03, dividend: 0.0, vol }
    }

    fn spec(spot: f64, weight: f64) -> AssetSpec {
        AssetSpec { spot, weight, initial_variance: 0.0 }
    }

    fn config(paths: usize, steps: usize) -> PortfolioConfig {
        PortfolioConfig { paths, steps, antithetic: true, seed: 0xC0FFEE, sample_paths: 8 }
    }

    /// The correlation the factor actually induced, read off three variances.
    ///
    /// The terminal values come back sorted, so the paths cannot be lined up
    /// pairwise — and correlating two sorted samples gives 1.0 whatever the
    /// dependence is, which is a Q-Q plot wearing a correlation's name. It is
    /// also what the first version of this helper did, and it reported 0.99998
    /// for independent assets without anybody noticing until the independence
    /// test ran.
    ///
    /// Variance does not depend on order. The simulator draws the same normals
    /// whatever the weights are, so three runs on one seed see the same asset
    /// paths, and
    ///
    /// ```text
    /// Var(aA + bB) = a^2 Var(A) + b^2 Var(B) + 2ab Cov(A, B)
    /// ```
    ///
    /// recovers the covariance from three sorted samples with nothing lined up.
    fn terminal_correlation(rho: f64, vol: f64, seed: u64) -> f64 {
        let a = gbm(vol);
        let b = gbm(vol);
        let processes: Vec<&dyn Process> = vec![&a, &b];
        let factor = Factor::equicorrelated(2, rho).unwrap();
        let cfg = PortfolioConfig { seed, antithetic: false, ..config(60_000, 64) };

        let run = |wa: f64, wb: f64| {
            simulate_portfolio(&processes, &[spec(100.0, wa), spec(100.0, wb)], &factor, 1.0, &cfg)
                .unwrap()
                .variance
        };

        let va = run(1.0, 0.0);
        let vb = run(0.0, 1.0);
        let vp = run(0.5, 0.5);
        let covariance = 2.0 * (vp - 0.25 * va - 0.25 * vb);
        covariance / (va.sqrt() * vb.sqrt())
    }

    /// What the correlation of two terminal lognormals *should* be.
    ///
    /// Correlating the Brownian increments at `rho` does not make the prices
    /// correlate at `rho`: the exponential pulls it toward zero, by a factor
    /// that closed form gives exactly. Asserting against this rather than
    /// against `rho` is the difference between testing that the correlation is
    /// induced and testing that it is induced *correctly*.
    fn lognormal_correlation(rho: f64, s1: f64, s2: f64, t: f64) -> f64 {
        ((rho * s1 * s2 * t).exp() - 1.0)
            / (((s1 * s1 * t).exp() - 1.0) * ((s2 * s2 * t).exp() - 1.0)).sqrt()
    }

    #[test]
    fn each_asset_keeps_its_own_marginal() {
        // A one-asset portfolio must reprice like the single-asset engine: the
        // terminal expectation of a GBM is S0 * exp((r - q) T), whatever else
        // the correlation machinery is doing around it.
        let process = gbm(0.2);
        let processes: Vec<&dyn Process> = vec![&process];
        let factor = Factor::independent(1);
        let result =
            simulate_portfolio(&processes, &[spec(100.0, 1.0)], &factor, 1.0, &config(40_000, 64))
                .unwrap();

        let expected = 100.0 * (0.03f64).exp();
        assert!(
            (result.mean - expected).abs() < 4.0 * result.standard_error.max(1e-9),
            "mean {} expected {} se {}",
            result.mean,
            expected,
            result.standard_error
        );
    }

    #[test]
    fn independent_assets_come_back_uncorrelated() {
        let rho = terminal_correlation(0.0, 0.25, 0x11);
        assert!(rho.abs() < 0.02, "independent assets correlated at {rho}");
    }

    #[test]
    fn the_factor_induces_the_correlation_the_closed_form_predicts() {
        for rho in [0.8, 0.4, -0.6] {
            let measured = terminal_correlation(rho, 0.25, 0x22);
            let expected = lognormal_correlation(rho, 0.25, 0.25, 1.0);
            assert!(
                (measured - expected).abs() < 0.02,
                "rho {rho}: measured {measured}, closed form {expected}"
            );
        }
    }

    #[test]
    fn the_gap_between_rho_and_the_price_correlation_is_the_exponential() {
        // Worth pinning, because it is the thing an analyst gets wrong: the
        // correlation they type is on the returns and the correlation they see
        // is on the prices, and the two separate as volatility rises.
        let mild = lognormal_correlation(0.8, 0.1, 0.1, 1.0);
        let wild = lognormal_correlation(0.8, 0.8, 0.8, 1.0);
        assert!(mild > 0.79 && mild < 0.801, "low vol should barely move it: {mild}");
        // 0.7458 at 80 vol. The pull is real and smaller than it feels — worth
        // pinning the actual figure, because "well below" was my guess and it
        // was wrong by three points the first time this ran.
        assert!(wild > 0.74 && wild < 0.75, "80 vol should give about 0.746: {wild}");
        assert!(wild < mild);

        let measured = terminal_correlation(0.8, 0.8, 0x44);
        assert!((measured - wild).abs() < 0.03, "measured {measured}, closed form {wild}");
    }

    #[test]
    fn a_correlation_matrix_that_is_impossible_is_refused_rather_than_repaired() {
        // Three assets pairwise correlated at -0.9 cannot exist. The factor
        // says so and names the block, and the simulator never runs.
        assert!(Factor::equicorrelated(3, -0.9).is_err());
    }

    #[test]
    fn drawdown_is_measured_against_the_running_peak() {
        // Zero volatility makes the path deterministic. With a positive drift
        // the portfolio only rises, so the maximum drawdown is exactly zero.
        let up = Gbm { rate: 0.10, dividend: 0.0, vol: 0.0 };
        let processes: Vec<&dyn Process> = vec![&up];
        let factor = Factor::independent(1);
        let rising =
            simulate_portfolio(&processes, &[spec(100.0, 1.0)], &factor, 1.0, &config(64, 32))
                .unwrap();
        assert!(rising.drawdown.iter().all(|d| *d < 1e-12));

        // The case that made the drawdown absolute rather than fractional. A
        // deterministic riser held *short* falls monotonically from -100 to
        // -110.5, which is a real loss and a peak that is never positive. The
        // first version divided by the peak behind an `if peak > 0.0` guard and
        // reported zero for the whole family.
        let short =
            simulate_portfolio(&processes, &[spec(100.0, -1.0)], &factor, 1.0, &config(64, 32))
                .unwrap();
        let terminal = short.terminal[0];
        let expected = -100.0 - terminal;
        assert!(expected > 10.0, "the short position should have lost money: {expected}");
        assert!(
            (short.drawdown[0] - expected).abs() < 1e-9,
            "drawdown {} expected {}",
            short.drawdown[0],
            expected
        );
    }

    #[test]
    fn the_drawdown_distribution_is_a_distribution() {
        let process = gbm(0.4);
        let processes: Vec<&dyn Process> = vec![&process];
        let factor = Factor::independent(1);
        let result =
            simulate_portfolio(&processes, &[spec(100.0, 1.0)], &factor, 1.0, &config(8_000, 64))
                .unwrap();

        assert_eq!(result.drawdown.len(), 8_000);
        assert!(result.drawdown.windows(2).all(|w| w[0] <= w[1]), "not sorted");
        assert!(result.drawdown_percentile(0.5) < result.drawdown_percentile(0.95));
        assert!(result.drawdown.iter().all(|d| *d >= 0.0), "a drawdown is never negative");
        assert!(result.drawdown.iter().all(|d| d.is_finite()));
        // Not bounded by the starting value, which is the thing a fractional
        // drawdown hides: a path that doubles to 200 and falls back to 80 drew
        // down 120 on a book that started at 100. At 40 vol over a year the
        // worst path here exceeds the initial value, and that is correct.
        assert!(
            *result.drawdown.last().unwrap() > 100.0,
            "worst drawdown {} should exceed the starting value at 40 vol",
            result.drawdown.last().unwrap()
        );
        assert!(result.drawdown_percentile(0.5) > 10.0);
    }

    #[test]
    fn cvar_is_the_mean_of_the_tail_and_sits_below_the_quantile() {
        let process = gbm(0.3);
        let processes: Vec<&dyn Process> = vec![&process];
        let factor = Factor::independent(1);
        let result =
            simulate_portfolio(&processes, &[spec(100.0, 1.0)], &factor, 1.0, &config(20_000, 32))
                .unwrap();

        for alpha in [0.01, 0.05, 0.10] {
            assert!(
                result.cvar(alpha) <= result.percentile(alpha),
                "cvar({alpha}) {} above the quantile {}",
                result.cvar(alpha),
                result.percentile(alpha)
            );
        }
        // Worse tails are worse.
        assert!(result.cvar(0.01) < result.cvar(0.10));
        // The whole distribution is the mean.
        assert!((result.cvar(1.0) - result.mean).abs() < 1e-9);
    }

    #[test]
    fn the_sample_is_a_path_and_not_a_snapshot() {
        let process = gbm(0.25);
        let processes: Vec<&dyn Process> = vec![&process];
        let factor = Factor::independent(1);
        let cfg = PortfolioConfig { sample_paths: 5, ..config(100, 16) };
        let result =
            simulate_portfolio(&processes, &[spec(100.0, 1.0)], &factor, 1.0, &cfg).unwrap();

        assert_eq!(result.sample.len(), 5 * 17);
        for i in 0..5 {
            let path = result.sample_path(i).expect("a kept path");
            assert_eq!(path.len(), 17);
            assert!((path[0] - 100.0).abs() < 1e-12, "every path starts at the portfolio value");
            assert!(path[1..].iter().any(|v| (v - 100.0).abs() > 1e-9), "path never moved");
        }
        assert!(result.sample_path(5).is_none());
    }

    #[test]
    fn the_cube_is_never_materialized() {
        // The property the PRD's "the browser never loads a 4GB array" asks
        // for, at a shape small enough to run in a test. What is retained is
        // 2 * paths + sample * (steps + 1); what a cube would hold is
        // paths * steps * assets.
        let process = gbm(0.2);
        let processes: Vec<&dyn Process> = (0..8).map(|_| &process as &dyn Process).collect();
        let assets: Vec<AssetSpec> = (0..8).map(|i| spec(50.0 + i as f64, 0.125)).collect();
        let factor = Factor::equicorrelated(8, 0.3).unwrap();
        let cfg = PortfolioConfig { sample_paths: 16, ..config(5_000, 126) };

        let result = simulate_portfolio(&processes, &assets, &factor, 0.5, &cfg).unwrap();

        assert_eq!(result.cube_values, 5_000 * 126 * 8);
        assert_eq!(result.retained_values, 2 * 5_000 + 16 * 127);
        assert!(result.compression() > 400.0, "compression {}", result.compression());
    }

    #[test]
    fn a_shape_mismatch_is_an_error_rather_than_a_truncation() {
        let process = gbm(0.2);
        let processes: Vec<&dyn Process> = vec![&process, &process];
        let factor = Factor::independent(2);

        assert_eq!(
            simulate_portfolio(&processes, &[spec(100.0, 1.0)], &factor, 1.0, &config(10, 4))
                .err(),
            Some(PortfolioError::Shape { processes: 2, assets: 1, factor: 2 })
        );

        let three = Factor::independent(3);
        assert!(matches!(
            simulate_portfolio(
                &processes,
                &[spec(100.0, 0.5), spec(100.0, 0.5)],
                &three,
                1.0,
                &config(10, 4)
            ),
            Err(PortfolioError::Shape { .. })
        ));

        assert_eq!(
            simulate_portfolio(
                &processes,
                &[spec(100.0, 0.5), spec(100.0, 0.5)],
                &factor,
                1.0,
                &config(0, 4)
            )
            .err(),
            Some(PortfolioError::Empty)
        );
    }

    /// The implied correlation of two assets' terminal values, off three runs.
    fn pair_correlation(processes: &[&dyn Process], rho: f64, seed: u64) -> f64 {
        let factor = Factor::equicorrelated(2, rho).unwrap();
        let cfg = PortfolioConfig {
            paths: 60_000,
            steps: 64,
            antithetic: false,
            seed,
            sample_paths: 0,
        };
        let run = |wa: f64, wb: f64| {
            let specs = [
                AssetSpec { spot: 100.0, weight: wa, initial_variance: 0.0625 },
                AssetSpec { spot: 100.0, weight: wb, initial_variance: 0.0625 },
            ];
            simulate_portfolio(processes, &specs, &factor, 1.0, &cfg).unwrap().variance
        };
        let va = run(1.0, 0.0);
        let vb = run(0.0, 1.0);
        let vp = run(0.5, 0.5);
        2.0 * (vp - 0.25 * va - 0.25 * vb) / (va.sqrt() * vb.sqrt())
    }

    #[test]
    fn every_diffusive_process_receives_the_correlation() {
        let gbm = gbm(0.25);
        let heston = pricing_core::mc::Heston {
            rate: 0.03, dividend: 0.0, theta: 0.0625, kappa: 2.0, sigma: 0.5, rho: -0.6,
            initial_variance: 0.0625,
        };
        let merton = pricing_core::mc::Merton {
            rate: 0.03, dividend: 0.0, vol: 0.22, intensity: 0.5, jump_mean: -0.05, jump_vol: 0.12,
        };

        // Measured at 0.79, 0.67 and 0.69. Heston and Merton come back below
        // the requested 0.8 because each carries independent noise of its own —
        // a variance shock, a jump — that dilutes the terminal correlation.
        // That is the model, not a defect, so the assertion is that they are
        // substantially correlated rather than that they hit 0.8.
        for (label, processes) in [
            ("gbm", vec![&gbm as &dyn Process, &gbm as &dyn Process]),
            ("heston", vec![&heston as &dyn Process, &heston as &dyn Process]),
            ("merton", vec![&merton as &dyn Process, &merton as &dyn Process]),
        ] {
            let at_zero = pair_correlation(&processes, 0.0, 0xC0FFEE);
            let at_high = pair_correlation(&processes, 0.8, 0xC0FFEE);
            assert!(at_zero.abs() < 0.05, "{label} at rho=0: {at_zero:.4}");
            assert!(at_high > 0.6, "{label} at rho=0.8: {at_high:.4}");
        }
    }

    // The trap this refusal exists for. Variance gamma is pure jump: it builds
    // its increment from a gamma clock and its own normal and never reads the
    // Brownian increment the simulator correlates. Before the refusal, a VG
    // pair asked for 0.8 came back at 0.0062 — the same value to the last digit
    // as at a requested correlation of zero, because the factor had literally
    // no effect. A number that looks like a correlated simulation and is not
    // one is worse than a refusal.
    #[test]
    fn a_process_that_ignores_the_brownian_is_refused_rather_than_decorrelated() {
        let vg = pricing_core::mc::VarianceGamma {
            rate: 0.03, dividend: 0.0, sigma: 0.25, nu: 0.35, theta: -0.2,
        };
        let gbm = gbm(0.25);
        assert!(!vg.uses_brownian());
        assert!(gbm.uses_brownian());

        let factor = Factor::equicorrelated(2, 0.8).unwrap();
        let assets = [spec(100.0, 0.5), spec(100.0, 0.5)];

        // And it names which asset, so a forty-name book says where to look.
        let processes: Vec<&dyn Process> = vec![&gbm, &vg];
        assert_eq!(
            simulate_portfolio(&processes, &assets, &factor, 1.0, &config(100, 8)).err(),
            Some(PortfolioError::NotDrivenByBrownian { asset: 1 })
        );

        let processes: Vec<&dyn Process> = vec![&vg, &gbm];
        assert_eq!(
            simulate_portfolio(&processes, &assets, &factor, 1.0, &config(100, 8)).err(),
            Some(PortfolioError::NotDrivenByBrownian { asset: 0 })
        );
    }

    #[test]
    fn antithetic_pairing_reduces_the_standard_error() {
        let process = gbm(0.3);
        let processes: Vec<&dyn Process> = vec![&process];
        let factor = Factor::independent(1);
        let assets = [spec(100.0, 1.0)];

        let paired = simulate_portfolio(
            &processes,
            &assets,
            &factor,
            1.0,
            &PortfolioConfig { antithetic: true, ..config(20_000, 32) },
        )
        .unwrap();
        let plain = simulate_portfolio(
            &processes,
            &assets,
            &factor,
            1.0,
            &PortfolioConfig { antithetic: false, ..config(20_000, 32) },
        )
        .unwrap();

        assert!(
            paired.standard_error < plain.standard_error,
            "antithetic {} plain {}",
            paired.standard_error,
            plain.standard_error
        );
    }

    #[test]
    fn the_same_seed_gives_the_same_answer() {
        let process = gbm(0.22);
        let processes: Vec<&dyn Process> = vec![&process, &process];
        let assets = [spec(100.0, 0.6), spec(80.0, 0.4)];
        let factor = Factor::equicorrelated(2, 0.5).unwrap();
        let cfg = config(2_000, 32);

        let a = simulate_portfolio(&processes, &assets, &factor, 1.0, &cfg).unwrap();
        let b = simulate_portfolio(&processes, &assets, &factor, 1.0, &cfg).unwrap();
        assert_eq!(a.terminal, b.terminal);
        assert_eq!(a.drawdown, b.drawdown);
        assert_eq!(a.sample, b.sample);
    }
}

// ---------------------------------------------------------------------------
// Complex arithmetic, the characteristic function, and calibration (PRD 5.8)
// ---------------------------------------------------------------------------

mod complex_tests {
    use pricing_core::complex::Complex;

    #[test]
    fn division_survives_the_ranges_an_exponential_reaches() {
        // The naive formula divides by re^2 + im^2, which overflows past about
        // 1e154 and underflows to zero below about 1e-162. Neither is exotic
        // inside exp() of a complex number.
        let huge = Complex::new(1e200, 1e200);
        let got = huge.div(huge);
        assert!((got.re - 1.0).abs() < 1e-12 && got.im.abs() < 1e-12, "{got:?}");

        let tiny = Complex::new(1e-200, 1e-200);
        let got = tiny.div(tiny);
        assert!((got.re - 1.0).abs() < 1e-12 && got.im.abs() < 1e-12, "{got:?}");

        let mixed = Complex::new(3.0, -4.0).div(Complex::new(1e-180, 2e-180));
        assert!(mixed.re.is_finite() && mixed.im.is_finite(), "{mixed:?}");
    }

    #[test]
    fn multiplication_and_division_invert_each_other() {
        let a = Complex::new(0.7, -2.3);
        let b = Complex::new(-1.9, 0.4);
        let back = a.mul(b).div(b);
        assert!((back.re - a.re).abs() < 1e-14);
        assert!((back.im - a.im).abs() < 1e-14);
    }

    #[test]
    fn sqrt_takes_the_principal_branch() {
        // Non-negative real part, and squaring returns the argument.
        for z in [
            Complex::new(-4.0, 0.0),
            Complex::new(-4.0, -1e-15),
            Complex::new(3.0, 4.0),
            Complex::new(0.0, -2.0),
            Complex::new(1e-300, 1e-300),
        ] {
            let r = z.sqrt();
            assert!(r.re >= 0.0, "{z:?} -> {r:?}");
            let back = r.mul(r);
            let scale = z.abs().max(1e-300);
            assert!((back.re - z.re).abs() / scale < 1e-12, "{z:?} -> {back:?}");
            assert!((back.im - z.im).abs() / scale < 1e-12, "{z:?} -> {back:?}");
        }
        assert_eq!(Complex::ZERO.sqrt(), Complex::ZERO);
    }

    #[test]
    fn ln_and_exp_invert_each_other_inside_the_principal_strip() {
        for z in [Complex::new(1.0, 0.5), Complex::new(-2.0, 0.3), Complex::new(0.01, -1.0)] {
            let back = z.ln().exp();
            assert!((back.re - z.re).abs() < 1e-13, "{z:?} -> {back:?}");
            assert!((back.im - z.im).abs() < 1e-13, "{z:?} -> {back:?}");
        }
        // Principal branch: the imaginary part of ln stays in (-pi, pi].
        for z in [Complex::new(-1.0, 1e-18), Complex::new(-1.0, -1e-18)] {
            assert!(z.ln().im.abs() <= core::f64::consts::PI + 1e-15);
        }
    }
}

mod heston_tests {
    use pricing_core::bsm::{self, Inputs, OptionType};
    use pricing_core::complex::Complex;
    use pricing_core::heston::{self, HestonParams, CONDITIONING_LIMIT};
    use pricing_core::mc::{self, McConfig, Sampling};
    use pricing_core::quad::Legendre;

    fn call(strike: f64, time: f64) -> Inputs {
        Inputs {
            spot: 100.0, strike, time, rate: 0.03, dividend: 0.01, vol: 0.2,
            kind: OptionType::Call,
        }
    }

    fn realistic() -> HestonParams {
        HestonParams { v0: 0.042, theta: 0.058, kappa: 1.8, sigma: 0.55, rho: -0.68 }
    }

    #[test]
    fn it_collapses_to_black_scholes_as_the_vol_of_vol_vanishes() {
        // At sigma = 1e-3, not 1e-6. The series coefficient carries a factor of
        // kappa*theta/sigma^2 against a bracket that vanishes with sigma^2, so
        // the obvious test point is the one where a double runs out of digits
        // to cancel with — measured, the error bottoms at sigma = 1e-4 and
        // *grows* below it. See the module docs.
        for &vol in &[0.15f64, 0.25, 0.40] {
            let v = vol * vol;
            let params = HestonParams { v0: v, theta: v, kappa: 2.0, sigma: 1e-3, rho: 0.0 };
            assert!(heston::well_conditioned(&params));
            for &(k, t) in &[(90.0, 0.25), (100.0, 1.0), (120.0, 2.0)] {
                let mut inputs = call(k, t);
                inputs.vol = vol;
                let gap = (heston::price(&params, &inputs) - bsm::price(&inputs)).abs();
                assert!(gap < 1e-5, "vol {vol} K {k} T {t}: gap {gap:.2e}");
            }
        }
    }

    #[test]
    fn it_reports_the_conditioning_rather_than_pricing_through_it() {
        let degenerate = HestonParams { v0: 0.16, theta: 0.16, kappa: 2.0, sigma: 1e-6, rho: 0.0 };
        assert!(heston::conditioning(&degenerate) > CONDITIONING_LIMIT);
        assert!(!heston::well_conditioned(&degenerate));

        assert!(heston::well_conditioned(&realistic()));
        assert!(heston::conditioning(&realistic()) < CONDITIONING_LIMIT);

        // And the report is honest about what it is warning of. At sigma=1e-6
        // the price really is wrong — 5.0e-4 against Black-Scholes, where the
        // model difference at that sigma is 1.4e-12 — and by sigma=1e-7 it is
        // 0.46 on a $16 option. The assertion is on the direction the error
        // moves, because that is what distinguishes cancellation from the model:
        // a model difference shrinks with sigma and this grows.
        let mut inputs = call(120.0, 2.0);
        inputs.vol = 0.4;
        let gap = |sigma: f64| {
            let params = HestonParams { sigma, ..degenerate };
            (heston::price(&params, &inputs) - bsm::price(&inputs)).abs()
        };
        assert!(gap(1e-3) > gap(1e-4), "above the floor the gap is the model, and falls");
        assert!(gap(1e-5) > gap(1e-4), "below the floor the gap is cancellation, and grows");
        assert!(gap(1e-6) > gap(1e-5));
        assert!(gap(1e-7) > 0.1, "by 1e-7 it is not subtle: {:.2e}", gap(1e-7));

        assert_eq!(
            heston::conditioning(&HestonParams { sigma: 0.0, ..realistic() }),
            f64::INFINITY
        );
    }

    #[test]
    fn put_call_parity_holds_exactly() {
        let params = realistic();
        for &(k, t) in &[(70.0, 0.08), (100.0, 1.0), (130.0, 2.0)] {
            let c = call(k, t);
            let p = Inputs { kind: OptionType::Put, ..c };
            let parity = heston::price(&params, &c) - heston::price(&params, &p);
            let expected = 100.0 * (-0.01f64 * t).exp() - k * (-0.03f64 * t).exp();
            assert!((parity - expected).abs() < 1e-12, "K {k} T {t}: {parity} vs {expected}");
        }
    }

    /// The Lewis integral at arbitrary resolution, not calling `heston::price`.
    fn reference_price(params: &HestonParams, inputs: &Inputs, upper: f64, panels: usize, nodes: usize) -> f64 {
        let x = (inputs.spot / inputs.strike).ln() + (inputs.rate - inputs.dividend) * inputs.time;
        let rule = Legendre::new(nodes);
        let mut integral = 0.0;
        for p in 0..panels {
            let lo = upper * ((p as f64) / (panels as f64)).powi(3);
            let hi = upper * (((p + 1) as f64) / (panels as f64)).powi(3);
            integral += rule.integrate(lo, hi, |u| {
                let phi = heston::characteristic(params, Complex::new(u, -0.5), inputs.time);
                Complex::new(0.0, u * x).exp().mul(phi).re / (u * u + 0.25)
            });
        }
        inputs.spot * (-inputs.dividend * inputs.time).exp()
            - (inputs.spot * inputs.strike).sqrt()
                * (-(inputs.rate + inputs.dividend) * inputs.time * 0.5).exp()
                * integral
                / core::f64::consts::PI
    }

    #[test]
    fn the_shipped_quadrature_grid_is_converged_at_the_corners_of_the_search_box() {
        // Not just at realistic parameters. The calibrator visits the corners,
        // and a grid converged in the middle and not at the edges produces a
        // fit that is an artefact of the quadrature.
        let corners = [
            realistic(),
            HestonParams { v0: 0.0025, theta: 0.64, kappa: 15.0, sigma: 3.0, rho: -0.95 },
            HestonParams { v0: 0.64, theta: 0.0025, kappa: 0.05, sigma: 0.02, rho: 0.95 },
            HestonParams { v0: 0.25, theta: 0.25, kappa: 0.5, sigma: 2.0, rho: 0.0 },
        ];
        let mut worst = 0.0f64;
        for params in corners {
            for &(k, t) in &[(70.0, 0.08), (100.0, 0.08), (130.0, 0.08), (70.0, 2.0), (100.0, 2.0), (130.0, 2.0)] {
                let inputs = call(k, t);
                let reference = reference_price(&params, &inputs, 400.0, 24, 40);
                worst = worst.max((heston::price(&params, &inputs) - reference).abs());
            }
        }
        // Measured at 7.13e-8; asserted an order of magnitude looser so a
        // reordering of the panels does not fail it spuriously, and tight
        // enough that dropping to 96 nodes (1.13e-5) would.
        assert!(worst < 1e-6, "worst quadrature error {worst:.2e}");
    }

    #[test]
    fn long_maturities_do_not_jump() {
        // The little Heston trap. The original 1993 formulation puts the
        // complex logarithm on a branch the principal `ln` crosses as maturity
        // grows, and the price jumps discontinuously when it does. This walks
        // maturity finely and requires the price to move smoothly — a branch
        // crossing shows up as a step between adjacent maturities far larger
        // than its neighbours.
        let params = HestonParams { v0: 0.09, theta: 0.09, kappa: 0.3, sigma: 1.0, rho: -0.5 };
        let mut previous = f64::NAN;
        let mut steps: Vec<f64> = Vec::new();
        let mut t = 0.1;
        while t <= 15.0 {
            let value = heston::price(&params, &call(100.0, t));
            assert!(value.is_finite() && value > 0.0, "T {t}: {value}");
            if previous.is_finite() {
                steps.push((value - previous).abs());
            }
            previous = value;
            t += 0.05;
        }
        // Compared locally, not against the median of the whole range. The
        // price rises fastest at the short end and flattens, so the largest
        // step is legitimately the first one — the median comparison this test
        // started with failed on that and said nothing about branches. A branch
        // crossing is a *local* anomaly: one step far larger than the steps
        // immediately either side of it, in a region where nothing else is
        // moving.
        let mut worst_ratio = 0.0f64;
        let mut worst_at = 0usize;
        for i in 1..steps.len() - 1 {
            let neighbours = steps[i - 1].max(steps[i + 1]).max(1e-12);
            let ratio = steps[i] / neighbours;
            if ratio > worst_ratio {
                worst_ratio = ratio;
                worst_at = i;
            }
        }
        // A smooth curve gives a ratio just above one everywhere. The trapped
        // formulation gives tens to hundreds at the crossing.
        assert!(
            worst_ratio < 1.5,
            "step {worst_at} is {worst_ratio:.2}x its neighbours, which is a branch crossing",
        );
    }

    #[test]
    fn the_price_rises_with_maturity_and_falls_with_strike() {
        let params = realistic();
        let mut previous = f64::NEG_INFINITY;
        for t in [0.08, 0.25, 0.5, 1.0, 2.0, 5.0, 10.0] {
            let value = heston::price(&params, &call(100.0, t));
            assert!(value > previous, "T {t}");
            previous = value;
        }
        let mut previous = f64::INFINITY;
        for k in [60.0, 80.0, 100.0, 120.0, 150.0] {
            let value = heston::price(&params, &call(k, 1.0));
            assert!(value < previous, "K {k}");
            previous = value;
        }
    }

    #[test]
    fn rho_is_the_skew() {
        // The reason anyone fits Heston rather than Black-Scholes. A negative
        // correlation makes a down move raise volatility, which fattens the
        // left tail, which lifts the implied vol of low strikes.
        let slope = |rho: f64| {
            let params = HestonParams { v0: 0.04, theta: 0.04, kappa: 2.0, sigma: 0.6, rho };
            let low = heston::implied_vol(&params, &call(80.0, 1.0));
            let high = heston::implied_vol(&params, &call(120.0, 1.0));
            high - low
        };
        assert!(slope(-0.8) < -0.05, "a negative rho must slope down: {}", slope(-0.8));
        assert!(slope(0.8) > 0.05, "a positive rho must slope up: {}", slope(0.8));
        assert!(slope(-0.8) < slope(0.0) && slope(0.0) < slope(0.8));
    }

    #[test]
    fn it_agrees_with_the_crate_s_own_heston_monte_carlo() {
        // The independent check: the Monte Carlo shares no code with the
        // characteristic function — a different discretisation of a different
        // representation of the same model.
        let params = realistic();
        let process = mc::Heston {
            rate: 0.03,
            dividend: 0.01,
            theta: params.theta,
            kappa: params.kappa,
            sigma: params.sigma,
            rho: params.rho,
            initial_variance: params.v0,
        };
        let config = McConfig {
            paths: 120_000, steps: 300, sampling: Sampling::Pseudo, antithetic: true, seed: 0xBEEF,
        };
        for &(k, t) in &[(80.0, 1.0), (100.0, 1.0), (120.0, 1.0)] {
            let closed = heston::price(&params, &call(k, t));
            let discount = (-0.03f64 * t).exp();
            let result = mc::simulate(
                &process, 100.0, t, &config, params.v0,
                |s| discount * (s - k).max(0.0),
                None,
            );
            // Four standard errors, and a floor: full-truncation Euler biases
            // the simulated price slightly, so the tolerance has to admit a
            // discretisation bias that is not an error in either routine.
            let tolerance = 4.0 * result.standard_error + 0.05;
            assert!(
                (closed - result.mean).abs() < tolerance,
                "K {k} T {t}: closed {closed:.5} mc {:.5} se {:.5}",
                result.mean, result.standard_error,
            );
        }
    }

    #[test]
    fn feller_is_reported_rather_than_enforced() {
        let breaks = HestonParams { v0: 0.04, theta: 0.04, kappa: 1.0, sigma: 0.8, rho: -0.7 };
        assert!(!breaks.satisfies_feller());
        assert!(breaks.feller() < 0.0);
        // And it still prices. Fitted equity surfaces routinely violate Feller,
        // and a pricer that refused them would refuse most real surfaces.
        assert!(heston::price(&breaks, &call(100.0, 1.0)) > 0.0);

        let holds = HestonParams { v0: 0.04, theta: 0.09, kappa: 3.0, sigma: 0.5, rho: -0.5 };
        assert!(holds.satisfies_feller());
    }
}

mod de_tests {
    use pricing_core::de::{minimize, Bound, DeConfig};

    fn config(seed: u64) -> DeConfig {
        DeConfig { population: 40, generations: 300, seed, ..DeConfig::default() }
    }

    #[test]
    fn it_finds_the_minimum_of_a_smooth_bowl() {
        let bounds = [Bound::new(-5.0, 5.0), Bound::new(-5.0, 5.0), Bound::new(-5.0, 5.0)];
        let target = [1.5, -2.25, 0.75];
        let result = minimize(&bounds, &config(1), |x| {
            x.iter().zip(target).map(|(v, t)| (v - t) * (v - t)).sum()
        });
        assert!(result.score < 1e-12, "score {}", result.score);
        for (got, want) in result.best.iter().zip(target) {
            assert!((got - want).abs() < 1e-5, "{got} vs {want}");
        }
    }

    #[test]
    fn it_finds_the_global_minimum_of_a_multimodal_one() {
        // Rastrigin: a bowl with a lattice of local minima on it, one per
        // integer point. A descent method finds whichever one it started in.
        // This is the landscape the PRD names DE for.
        let bounds = [Bound::new(-5.12, 5.12); 4];
        let result = minimize(&bounds, &config(7), |x| {
            10.0 * x.len() as f64
                + x.iter()
                    .map(|v| v * v - 10.0 * (2.0 * core::f64::consts::PI * v).cos())
                    .sum::<f64>()
        });
        assert!(result.score < 1e-6, "score {} at {:?}", result.score, result.best);
        for value in &result.best {
            assert!(value.abs() < 1e-3, "{value} should be at the origin");
        }
    }

    #[test]
    fn it_follows_a_curved_valley() {
        // Rosenbrock, the other classic: the minimum sits at the end of a long
        // flat curved trough. Heston's kappa-theta trade-off has the same
        // shape, which is why it is here.
        let bounds = [Bound::new(-3.0, 3.0), Bound::new(-3.0, 9.0)];
        let result = minimize(&bounds, &config(11), |x| {
            let (a, b) = (x[0], x[1]);
            (1.0 - a) * (1.0 - a) + 100.0 * (b - a * a) * (b - a * a)
        });
        assert!(result.score < 1e-8, "score {}", result.score);
        assert!((result.best[0] - 1.0).abs() < 1e-3);
        assert!((result.best[1] - 1.0).abs() < 1e-3);
    }

    #[test]
    fn every_answer_is_inside_the_box() {
        let bounds = [Bound::new(-1.0, 2.0), Bound::new(10.0, 11.0)];
        // A minimum well outside the box, so every trial is pushed at the wall.
        let result = minimize(&bounds, &config(3), |x| {
            (x[0] + 50.0) * (x[0] + 50.0) + (x[1] - 900.0) * (x[1] - 900.0)
        });
        assert!(result.best[0] >= -1.0 && result.best[0] <= 2.0, "{:?}", result.best);
        assert!(result.best[1] >= 10.0 && result.best[1] <= 11.0, "{:?}", result.best);
        // And it lands on the nearest corner, which is the right answer.
        assert!((result.best[0] + 1.0).abs() < 1e-6);
        assert!((result.best[1] - 11.0).abs() < 1e-6);
    }

    #[test]
    fn the_same_seed_gives_the_same_answer_and_a_different_one_does_not() {
        let bounds = [Bound::new(-5.0, 5.0); 3];
        let objective = |x: &[f64]| x.iter().map(|v| (v - 1.0) * (v - 1.0)).sum::<f64>() + 0.1;
        let a = minimize(&bounds, &config(42), objective);
        let b = minimize(&bounds, &config(42), objective);
        assert_eq!(a.best, b.best);
        assert_eq!(a.score, b.score);

        let c = minimize(&bounds, &config(43), objective);
        assert_ne!(a.best, c.best);
    }

    #[test]
    fn a_non_finite_objective_does_not_poison_the_population() {
        // A parameter set that produces a NaN is a bad member, not a broken
        // run. Propagating it would make every comparison against it false and
        // freeze whichever slot it landed in.
        let bounds = [Bound::new(-5.0, 5.0), Bound::new(-5.0, 5.0)];
        let result = minimize(&bounds, &config(5), |x| {
            if x[0] > 0.0 { f64::NAN } else { (x[0] + 2.0).powi(2) + (x[1] - 3.0).powi(2) }
        });
        assert!(result.score < 1e-10, "score {}", result.score);
        assert!((result.best[0] + 2.0).abs() < 1e-4);
        assert!((result.best[1] - 3.0).abs() < 1e-4);
    }

    #[test]
    fn the_target_stops_it_early() {
        let bounds = [Bound::new(-5.0, 5.0); 2];
        let objective = |x: &[f64]| x.iter().map(|v| v * v).sum::<f64>();
        let full = minimize(&bounds, &DeConfig { target: 0.0, ..config(9) }, objective);
        let early = minimize(&bounds, &DeConfig { target: 1e-4, ..config(9) }, objective);
        assert!(early.generations < full.generations);
        assert!(early.score <= 1e-4);
        assert!(early.evaluations < full.evaluations);
    }

    #[test]
    fn the_score_spread_reports_whether_it_converged() {
        let bounds = [Bound::new(-5.12, 5.12); 4];
        let rastrigin = |x: &[f64]| {
            10.0 * x.len() as f64
                + x.iter().map(|v| v * v - 10.0 * (2.0 * core::f64::consts::PI * v).cos()).sum::<f64>()
        };
        // Two generations is nowhere near converged, and the spread says so.
        let stopped = minimize(&bounds, &DeConfig { generations: 2, ..config(7) }, rastrigin);
        let converged = minimize(&bounds, &config(7), rastrigin);
        assert!(stopped.score_spread > 1.0, "{}", stopped.score_spread);
        assert!(converged.score_spread < stopped.score_spread / 10.0);
    }
}

mod calibration_tests {
    use pricing_core::bsm::OptionType;
    use pricing_core::de::DeConfig;
    use pricing_core::heston::{
        self, CalibrationConfig, HestonParams, Quote, Residual, Surface, DEFAULT_BOUNDS,
    };

    const SPOT: f64 = 100.0;
    const RATE: f64 = 0.03;
    const DIVIDEND: f64 = 0.01;

    fn truth() -> HestonParams {
        HestonParams { v0: 0.042, theta: 0.058, kappa: 1.8, sigma: 0.55, rho: -0.68 }
    }

    fn surface_quotes(params: &HestonParams) -> Vec<Quote> {
        let mut quotes = Vec::new();
        heston::synthetic_surface(
            params,
            SPOT,
            RATE,
            DIVIDEND,
            &[80.0, 90.0, 100.0, 110.0, 125.0],
            &[0.25, 1.0, 2.0],
            &mut quotes,
        );
        quotes
    }

    fn config(seed: u64) -> CalibrationConfig {
        CalibrationConfig {
            residual: Residual::ImpliedVol,
            // Population 50 rather than 30: the default F of 0.5 needs the
            // members to keep its difference vectors alive, and at 30 the
            // ordering of the F/CR settings reverses. See the measurement in
            // `de.rs`.
            de: DeConfig { population: 50, generations: 120, seed, ..DeConfig::default() },
            bounds: DEFAULT_BOUNDS,
        }
    }

    #[test]
    fn the_synthetic_surface_is_a_surface() {
        let quotes = surface_quotes(&truth());
        assert_eq!(quotes.len(), 15);
        for quote in &quotes {
            assert!(quote.vol > 0.05 && quote.vol < 1.0, "{quote:?}");
            assert!(quote.weight > 0.0);
        }
        // Out-of-the-money on both sides, which is where the skew lives.
        assert!(quotes.iter().any(|q| q.kind == OptionType::Put));
        assert!(quotes.iter().any(|q| q.kind == OptionType::Call));
        // And it carries the skew rho put in it.
        let short: Vec<&Quote> = quotes.iter().filter(|q| q.time == 0.25).collect();
        assert!(short[0].vol > short[short.len() - 1].vol, "the smile should slope down");
    }

    // The only honest test of a calibrator. A fit to real quotes has no right
    // answer, so "the RMSE is small" is all anybody can say about it — and a
    // calibrator that lands in the wrong valley says that too.
    #[test]
    fn it_recovers_the_parameters_the_surface_was_generated_from() {
        let want = truth();
        let quotes = surface_quotes(&want);
        let surface = Surface { spot: SPOT, rate: RATE, dividend: DIVIDEND, quotes: &quotes };

        // Tolerances an order of magnitude looser than the measured worst of
        // five seeds (rmse 1.1e-6, |d kappa| 1.3e-4), so a reseeding does not
        // fail this spuriously — and tight enough that landing in a different
        // valley, which is what a broken calibrator does, would.
        for seed in [0xA11CEu64, 0xB0B] {
            let fit = heston::calibrate(&surface, &config(seed));
            assert_eq!(fit.skipped, 0, "seed {seed:x}");
            assert!(fit.rmse < 1e-5, "seed {seed:x}: rmse {:.2e}", fit.rmse);
            let got = fit.params;
            assert!((got.v0 - want.v0).abs() < 1e-4, "seed {seed:x}: v0 {}", got.v0);
            assert!((got.theta - want.theta).abs() < 5e-4, "seed {seed:x}: theta {}", got.theta);
            assert!((got.kappa - want.kappa).abs() < 5e-3, "seed {seed:x}: kappa {}", got.kappa);
            assert!((got.sigma - want.sigma).abs() < 5e-3, "seed {seed:x}: sigma {}", got.sigma);
            assert!((got.rho - want.rho).abs() < 5e-3, "seed {seed:x}: rho {}", got.rho);
        }
    }

    #[test]
    fn it_reports_the_diagnostics_a_fit_should_be_read_with() {
        let quotes = surface_quotes(&truth());
        let surface = Surface { spot: SPOT, rate: RATE, dividend: DIVIDEND, quotes: &quotes };
        let fit = heston::calibrate(&surface, &config(0xA11CE));

        assert!(fit.worst >= fit.rmse, "the worst quote is at least the RMSE");
        assert!(fit.worst_quote < quotes.len());
        assert!(fit.evaluations >= fit.generations);
        assert!(fit.score_spread >= 0.0);
        // Feller and conditioning are reported at the fit, not at the truth.
        assert_eq!(fit.feller, fit.params.feller());
        assert_eq!(fit.conditioning, heston::conditioning(&fit.params));
        // This truth violates Feller, and the fit should say so rather than
        // having quietly avoided the region.
        assert!(!truth().satisfies_feller());
        assert!(fit.feller < 0.0, "the fit should land where the surface points");
    }

    #[test]
    fn quotes_it_cannot_price_are_counted_rather_than_dropped() {
        // A fit that ignored a third of the surface is a different claim from
        // one that fitted all of it, and the count is how they are told apart.
        let mut quotes = surface_quotes(&truth());
        // Degenerate quotes: zero maturity carries no volatility information.
        quotes.push(Quote { strike: 100.0, time: 0.0, kind: OptionType::Call, vol: 0.2, weight: 1.0 });
        quotes.push(Quote { strike: 100.0, time: -1.0, kind: OptionType::Call, vol: 0.2, weight: 1.0 });
        let surface = Surface { spot: SPOT, rate: RATE, dividend: DIVIDEND, quotes: &quotes };

        let fit = heston::calibrate(&surface, &config(0xB0B));
        assert_eq!(fit.skipped, 2, "the two degenerate quotes should be counted");
        // And the rest still fits.
        assert!(fit.rmse < 5e-4, "rmse {:.2e}", fit.rmse);
    }

    #[test]
    fn a_weight_moves_the_fit_toward_the_quote_it_is_on() {
        // A surface no Heston reproduces exactly, so the weights have something
        // to trade off: the wings are lifted away from the model's own smile.
        let mut quotes = surface_quotes(&truth());
        let wing = 0;
        quotes[wing].vol += 0.03;

        let even = Surface { spot: SPOT, rate: RATE, dividend: DIVIDEND, quotes: &quotes };
        let even_fit = heston::calibrate(&even, &config(0xC0FFEE));

        let mut weighted_quotes = quotes.clone();
        weighted_quotes[wing].weight = 50.0;
        let weighted = Surface { spot: SPOT, rate: RATE, dividend: DIVIDEND, quotes: &weighted_quotes };
        let weighted_fit = heston::calibrate(&weighted, &config(0xC0FFEE));

        let residual_at = |params: &HestonParams| {
            let q = &quotes[wing];
            let inputs = pricing_core::bsm::Inputs {
                spot: SPOT, strike: q.strike, time: q.time, rate: RATE, dividend: DIVIDEND,
                vol: q.vol, kind: q.kind,
            };
            (heston::implied_vol(params, &inputs) - q.vol).abs()
        };

        assert!(
            residual_at(&weighted_fit.params) < residual_at(&even_fit.params),
            "weighted {:.2e} should beat even {:.2e} on the quote it weighted",
            residual_at(&weighted_fit.params),
            residual_at(&even_fit.params),
        );
    }
}
