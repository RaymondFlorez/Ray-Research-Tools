//! Every bit the Andersen-Lake and grid paths produce, folded into two digests.
//!
//! For a change that must not move a price: run it before and after, and the
//! digests agree or the change is not what it claims. 30,720 Andersen-Lake
//! prices over every scheme, boundary reads, and every cell of the grid over
//! three books, three qualities, three decays, three markets and two guard
//! tolerances (the tight one escalates, so the escalation path is in it).
//!
//!     cargo run --release --example bits_digest
use pricing_core::andersen_lake as al;
use pricing_core::bsm::{Inputs, OptionType};
use pricing_core::grid::{self, GridSpec, GuardConfig, Leg, Market, Quality, Style};

/// FNV-style, over the raw bits: a NaN with another payload is another digest.
struct H(u64);
impl H {
    fn f(&mut self, x: f64) {
        self.0 ^= x.to_bits();
        self.0 = self.0.wrapping_mul(0x100000001b3).rotate_left(7);
    }
}

fn main() {
    let mut h = H(0xcbf29ce484222325);
    let mut n = 0u64;
    let schemes = [al::DRAFT, al::FAST, al::GUARD, al::ACCURATE];
    for &kind in &[OptionType::Put, OptionType::Call] {
        for &spot in &[40.0, 70.0, 90.0, 99.5, 100.0, 104.0, 120.0, 180.0] {
            for &time in &[0.0, 1e-4, 0.02, 0.25, 1.0, 3.0] {
                for &rate in &[-0.01, 0.0, 0.01, 0.05, 0.12] {
                    for &dividend in &[0.0, 0.02, 0.06, 0.15] {
                        for &vol in &[1e-6, 0.05, 0.25, 0.8] {
                            let i = Inputs { spot, strike: 100.0, time, rate, dividend, vol, kind };
                            for s in schemes { h.f(al::price(&i, s)); n += 1; }
                            h.f(al::fast_price(&i)); h.f(al::guard_price(&i)); h.f(al::accurate_price(&i));
                            if rate > 0.0 && time > 0.0 {
                                let b = al::fast_solver().unit_put_boundary(rate, dividend, vol, time);
                                for k in 0..7 { h.f(b.at(time * k as f64 / 6.0)); }
                                h.f(al::fast_solver().price_with(&i, &b));
                            }
                        }
                    }
                }
            }
        }
    }
    println!("al values {n} hash {:016x}", h.0);
    let mut g = H(0x84222325cbf29ce4);
    for &(legs, style) in &[(40, Style::American), (40, Style::European), (13, Style::American)] {
        let book: Vec<Leg> = (0..legs).map(|i| Leg {
            strike: 80.0 + (i % 20) as f64 * 2.5, time: 0.08 + (i % 6) as f64 * 0.25,
            kind: if i % 2 == 0 { OptionType::Call } else { OptionType::Put },
            style: if i % 5 == 4 { Style::European } else { style },
            quantity: if i % 3 == 0 { -10.0 } else { 5.0 }, multiplier: 100.0, vol: 0.22 + (i % 7) as f64 * 0.03,
        }).collect();
        for &q in &[Quality::Draft, Quality::Standard, Quality::Exact] {
            for &decay in &[0.0, 10.0, 40.0] {
                for &(rate, div) in &[(0.04, 0.015), (0.05, 0.0), (0.0, 0.02)] {
                    let market = Market { spot: 100.0, rate, dividend: div };
                    let mut spec = GridSpec::linear(25, 0.25, 15, 0.1);
                    spec.quality = q; spec.time_decay_days = decay;
                    for cfg in [GuardConfig::default(), GuardConfig { tolerance_ticks: 0.01, tolerance_bps_of_notional: 0.01, ..GuardConfig::default() }] {
                        let r = grid::reprice_grid(&book, &market, &spec, &cfg);
                        for c in &r.cells { g.f(c.value); g.f(c.delta); g.f(c.gamma); g.f(c.vega); g.f(c.theta); g.f(c.exact as u8 as f64); }
                        g.f(r.guard.max_error); g.f(r.guard.escalated_cells as f64); g.f(r.repricings as f64);
                    }
                }
            }
        }
    }
    println!("grid hash {:016x}", g.0);
}
