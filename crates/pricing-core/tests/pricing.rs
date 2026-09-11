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
