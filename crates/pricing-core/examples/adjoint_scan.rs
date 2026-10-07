//! The measurements behind `adjoint`: why the Greeks are taken through
//! Andersen-Lake rather than a lattice, how close they are, and what they cost.
//! `cargo run --release --example adjoint_scan`.

use pricing_core::adjoint::{american_greeks, european, greeks_of, Contract, Scalar};
use pricing_core::andersen_lake::accurate_price;
use pricing_core::bsm::{self, Greeks, Inputs, OptionType};
use std::time::Instant;

fn cases() -> Vec<Inputs> {
    let mut out = Vec::new();
    for &kind in &[OptionType::Call, OptionType::Put] {
        for &k in &[80.0, 95.0, 100.0, 105.0, 120.0] {
            for &t in &[0.1, 0.5, 2.0] {
                for &(r, q) in &[(0.05, 0.0), (0.03, 0.04), (0.08, 0.02)] {
                    for &v in &[0.15, 0.35] {
                        out.push(Inputs { spot: 100.0, strike: k, time: t, rate: r, dividend: q, vol: v, kind });
                    }
                }
            }
        }
    }
    out
}

/// Broadie-Detemple (Black-Scholes at the last step) with Richardson
/// extrapolation over n and n/2: the smoothest plain lattice.
fn bdr<F: Scalar>(c: &Contract<F>, american: bool, n: usize) -> F {
    F::c(2.0) * bd(c, american, n) - bd(c, american, n / 2)
}

fn bd<F: Scalar>(c: &Contract<F>, american: bool, n: usize) -> F {
    let dt = c.time / F::c(n as f64);
    let a = c.vol * dt.sqrt();
    let (u, d) = (a.exp(), (-a).exp());
    let p = (((c.rate - c.dividend) * dt).exp() - d) / (u - d);
    let disc = (-(c.rate * dt)).exp();
    let sign = F::c(if c.kind == OptionType::Call { 1.0 } else { -1.0 });
    let level = |k: usize, i: usize| c.spot * (a * F::c(2.0 * i as f64 - k as f64)).exp();
    let top = n - 1;
    let tau = Contract { time: dt, ..*c };
    let mut v: Vec<F> = (0..=top)
        .map(|i| {
            let s = level(top, i);
            let e = european(&Contract { spot: s, ..tau });
            let x = sign * (s - c.strike);
            if american && x.v() > e.v() { x } else { e }
        })
        .collect();
    for k in (0..top).rev() {
        for i in 0..=k {
            let held = disc * (p * v[i + 1] + (F::c(1.0) - p) * v[i]);
            let x = sign * (level(k, i) - c.strike);
            v[i] = if american && x.v() > held.v() { x } else { held };
        }
    }
    v[0]
}

/// Leisen-Reimer, with Peizer-Pratt written smoothly through zero.
fn lr<F: Scalar>(c: &Contract<F>, american: bool, n: usize) -> F {
    let n = n | 1;
    let nf = n as f64;
    let den = nf + 1.0 / 3.0 + 0.1 / (nf + 1.0);
    let cc = nf + 1.0 / 6.0;
    let h = |z: F| {
        let w = z * z * F::c(cc / (den * den));
        let phi = if w.v() < 1e-8 { F::c(1.0) - w * F::c(0.5) } else { (F::c(1.0) - (-w).exp()) / w };
        F::c(0.5) + F::c(0.5 * cc.sqrt() / den) * z * phi.sqrt()
    };
    let dt = c.time / F::c(nf);
    let vst = c.vol * c.time.sqrt();
    let d1 = ((c.spot / c.strike).ln() + (c.rate - c.dividend + F::c(0.5) * c.vol * c.vol) * c.time) / vst;
    let (p, pd) = (h(d1 - vst), h(d1));
    let g = ((c.rate - c.dividend) * dt).exp();
    let u = g * pd / p;
    let d = (g - p * u) / (F::c(1.0) - p);
    let disc = (-(c.rate * dt)).exp();
    let sign = F::c(if c.kind == OptionType::Call { 1.0 } else { -1.0 });
    let (lu, ld) = (u.ln(), d.ln());
    let level = |k: usize, i: usize| c.spot * (lu * F::c(i as f64) + ld * F::c((k - i) as f64)).exp();
    let mut v: Vec<F> = (0..=n).map(|i| {
        let x = sign * (level(n, i) - c.strike);
        if x.v() > 0.0 { x } else { F::c(0.0) }
    }).collect();
    for k in (0..n).rev() {
        for i in 0..=k {
            let held = disc * (p * v[i + 1] + (F::c(1.0) - p) * v[i]);
            let x = sign * (level(k, i) - c.strike);
            v[i] = if american && x.v() > held.v() { x } else { held };
        }
    }
    v[0]
}

/// Central differences of Andersen-Lake: delta, gamma, vega, rho, theta.
fn bumped(c: &Inputs) -> [f64; 5] {
    let p = |i: Inputs| accurate_price(&i);
    [
        (p(Inputs { spot: c.spot + 0.01, ..*c }) - p(Inputs { spot: c.spot - 0.01, ..*c })) / 0.02,
        (p(Inputs { spot: c.spot + 0.5, ..*c }) - 2.0 * p(*c) + p(Inputs { spot: c.spot - 0.5, ..*c })) / 0.25,
        (p(Inputs { vol: c.vol + 1e-3, ..*c }) - p(Inputs { vol: c.vol - 1e-3, ..*c })) / 2e-3,
        (p(Inputs { rate: c.rate + 1e-4, ..*c }) - p(Inputs { rate: c.rate - 1e-4, ..*c })) / 2e-4,
        -(p(Inputs { time: c.time + 1e-4, ..*c }) - p(Inputs { time: c.time - 1e-4, ..*c })) / 2e-4,
    ]
}

fn first(g: &Greeks) -> [f64; 5] {
    [g.delta, g.gamma, g.vega, g.rho, g.theta]
}

fn report(label: &str, worst: &[(f64, f64, String); 5]) {
    let names = ["delta", "gamma", "vega", "rho", "theta"];
    println!("{label}");
    for j in 0..5 {
        println!("  {:5} worst {:.2e} (of {:.3}) at {}", names[j], worst[j].0, worst[j].1, worst[j].2);
    }
}

fn worst_against(cases: &[Inputs], greeks: impl Fn(&Inputs) -> Greeks) -> [(f64, f64, String); 5] {
    let mut worst: [(f64, f64, String); 5] = Default::default();
    for c in cases {
        let (a, b) = (first(&greeks(c)), bumped(c));
        for j in 0..5 {
            if (a[j] - b[j]).abs() > worst[j].0 {
                worst[j] = ((a[j] - b[j]).abs(), b[j], format!("{:?} K{} T{} r{} q{} v{}", c.kind, c.strike, c.time, c.rate, c.dividend, c.vol));
            }
        }
    }
    worst
}

fn main() {
    let cases = cases();
    println!("{} contracts", cases.len());

    // 1. The lattice, differentiated exactly through the tape, on Americans.
    for n in [200usize, 400] {
        let w = worst_against(&cases, |c| greeks_of(c, |x| bdr(x, true, n)));
        report(&format!("smoothed lattice (Broadie-Detemple, Richardson) at {n} steps, exact derivatives, against Andersen-Lake differences:"), &w);
    }

    // 1b. The tape is not the problem: on one contract, the lattice's exact
    // delta and vega against its own central differences.
    let c = Inputs { spot: 100.0, strike: 105.0, time: 0.5, rate: 0.05, dividend: 0.02, vol: 0.3, kind: OptionType::Put };
    let g = greeks_of(&c, |x| bdr(x, true, 400));
    let f = |i: Inputs| bdr(&Contract { spot: i.spot, strike: i.strike, time: i.time, rate: i.rate, dividend: i.dividend, vol: i.vol, kind: i.kind }, true, 400);
    let h = 1e-4;
    let fd_delta = (f(Inputs { spot: c.spot + h, ..c }) - f(Inputs { spot: c.spot - h, ..c })) / (2.0 * h);
    let fd_vega = (f(Inputs { vol: c.vol + h, ..c }) - f(Inputs { vol: c.vol - h, ..c })) / (2.0 * h);
    println!("lattice exact against its own differences: delta {:.10} vs {:.10}, vega {:.8} vs {:.8}", g.delta, fd_delta, g.vega, fd_vega);

    // 2. Leisen-Reimer: smooth on Europeans, not on Americans.
    let mut eur = [0.0f64; 4];
    for c in &cases {
        let a = greeks_of(c, |x| lr(x, false, 201));
        let b = bsm::greeks(c);
        let rel = |x: f64, y: f64| (x - y).abs() / 1.0f64.max(y.abs());
        for (j, (x, y)) in [(a.delta, b.delta), (a.gamma, b.gamma), (a.vega, b.vega), (a.volga, b.volga)].iter().enumerate() {
            eur[j] = eur[j].max(rel(*x, *y));
        }
    }
    println!("Leisen-Reimer 201 steps, European, exact derivatives against the closed form (rel above 1): delta {:.1e} gamma {:.1e} vega {:.1e} volga {:.1e}", eur[0], eur[1], eur[2], eur[3]);
    let w = worst_against(&cases, |c| greeks_of(c, |x| lr(x, true, 201)));
    report("Leisen-Reimer 201 steps, American, against Andersen-Lake differences:", &w);

    // 3. Andersen-Lake's own adjoint Greeks against its own differences.
    let w = worst_against(&cases, american_greeks);
    report("Andersen-Lake adjoint, against Andersen-Lake differences:", &w);

    // 4. Cost.
    let c = Inputs { spot: 100.0, strike: 105.0, time: 0.5, rate: 0.05, dividend: 0.02, vol: 0.3, kind: OptionType::Put };
    let reps = 200;
    let time = |f: &dyn Fn() -> f64| {
        let t0 = Instant::now();
        let mut sink = 0.0;
        for _ in 0..reps {
            sink += f();
        }
        (t0.elapsed().as_secs_f64() / reps as f64 * 1e6, sink)
    };
    let (price_us, _) = time(&|| accurate_price(&c));
    let (adj_us, _) = time(&|| american_greeks(&c).speed);
    let (bump_us, _) = time(&|| {
        // Ten Greeks by bumping: price, five first-order pairs, gamma, and the
        // four cross or second-order stencils — twenty-five prices.
        let mut s = 0.0;
        for _ in 0..25 {
            s += accurate_price(&c);
        }
        s
    });
    println!("cost: one price {price_us:.0}us; ten Greeks by adjoint {adj_us:.0}us ({:.1}x a price); by bumping, 25 prices {bump_us:.0}us", adj_us / price_us);
}
