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
