//! Greeks by adjoint differentiation (PRD 5.4, 9.2).
//!
//! > full Greeks including vanna, volga, charm, and speed, computed
//! > analytically where closed forms exist and by adjoint differentiation
//! > otherwise.
//!
//! An American option has no closed form, so its Greeks are the derivatives of
//! whatever computes its price. Here that is Andersen-Lake at the scheme a
//! pinned position is priced with, and the derivatives are taken by recording
//! the pricer's arithmetic on a tape and sweeping it backwards: one reverse
//! pass carries the sensitivity of the price to every intermediate, and from
//! them to the five inputs.
//!
//! # Why not the lattice the PRD names
//!
//! PRD 9.2 has detail views on "the CRR/lattice path with adjoint
//! differentiation". That was built first, and measured, and it does not work
//! for an American option — not because of the differentiation, whose exact
//! delta matched the lattice's own central difference to ten digits, but
//! because of what
//! was being differentiated.
//!
//! A lattice puts the exercise boundary on its nodes. As vol or rate moves,
//! nodes flip between exercise and hold one at a time, so the lattice price is
//! a staircase in the inputs with steps far below a tick, and its exact
//! derivative is the slope of the staircase. On 180 contracts at 400 steps
//! (`examples/adjoint_scan.rs`), a smoothed and extrapolated lattice's exact
//! vega missed Andersen-Lake's by up to 0.49 on 16.8, its rho by 1.2 on 32,
//! and its gamma by 0.051 on 0.073 near the boundary; doubling the steps
//! roughly halved the vega error, so a tenth of a vega point would take tens
//! of thousands of steps. A Leisen-Reimer tree fixes the European case — its
//! nodes are placed relative to the strike, and its exact volga matches the
//! closed form to 2e-4 — and not the American one, where the staircase is the
//! exercise decision itself.
//!
//! Andersen-Lake has no staircase. It runs a fixed number of fixed-point
//! iterations over fixed quadrature nodes, so its price is a smooth function of
//! every input, and the derivative of that function is a Greek.
//!
//! # How the second-order Greeks come out of a first-order sweep
//!
//! The tape stores each operation's local partials as hyper-dual numbers
//! rather than plain floats. Seed the inputs' hyper-dual parts on spot, and
//! every value and every partial carries its own derivative in spot; so does
//! every adjoint the reverse sweep accumulates. The adjoint of spot then comes
//! back as delta with gamma and speed attached, the adjoint of vol as vega with
//! vanna, and the adjoint of maturity with charm. A second sweep seeded on vol
//! gives volga, and vanna again from the other side, which a test holds equal
//! to the first.
//!
//! The same tape runs the Black-Scholes-Merton formula, and its ten Greeks
//! there are checked against the closed forms in `bsm`, which share no code
//! with it. That is the check on the machinery itself.

use crate::andersen_lake::Solver;
use crate::bsm::{self, Greeks, Inputs, OptionType};
use crate::normal::{cdf, pdf};
use core::cell::RefCell;
use core::ops::{Add, Div, Mul, Neg, Sub};

/// A number the pricers can be written over: `f64`, a dual or hyper-dual
/// number, or a variable on the adjoint tape.
pub trait Scalar:
    Copy + Add<Output = Self> + Sub<Output = Self> + Mul<Output = Self> + Div<Output = Self> + Neg<Output = Self>
{
    /// A constant: no derivative in anything.
    fn c(value: f64) -> Self;
    /// The value, every derivative dropped. Branches are taken on this, which
    /// is what makes the derivative of a `max` the derivative of the branch
    /// taken.
    fn v(self) -> f64;
    /// `f` applied, given `f` and its first three derivatives at the value.
    fn lift(self, f0: f64, f1: f64, f2: f64, f3: f64) -> Self;

    fn exp(self) -> Self {
        let e = libm::exp(self.v());
        self.lift(e, e, e, e)
    }
    fn ln(self) -> Self {
        let x = self.v();
        self.lift(libm::log(x), 1.0 / x, -1.0 / (x * x), 2.0 / (x * x * x))
    }
    fn sqrt(self) -> Self {
        let x = self.v();
        let r = libm::sqrt(x);
        self.lift(r, 0.5 / r, -0.25 / (x * r), 0.375 / (x * x * r))
    }
    /// The standard normal CDF, through `normal::cdf` so the value is the
    /// same bits the `f64` pricers produce.
    fn ncdf(self) -> Self {
        let x = self.v();
        let p = pdf(x);
        self.lift(cdf(x), p, -x * p, (x * x - 1.0) * p)
    }
    fn npdf(self) -> Self {
        let x = self.v();
        let p = pdf(x);
        self.lift(p, -x * p, (x * x - 1.0) * p, (3.0 * x - x * x * x) * p)
    }
}

impl Scalar for f64 {
    fn c(value: f64) -> Self {
        value
    }
    fn v(self) -> f64 {
        self
    }
    fn lift(self, f0: f64, _: f64, _: f64, _: f64) -> Self {
        f0
    }
}

/// `v + d ε`, with `ε² = 0`.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Dual {
    pub v: f64,
    pub d: f64,
}

impl Add for Dual {
    type Output = Dual;
    fn add(self, o: Dual) -> Dual {
        Dual { v: self.v + o.v, d: self.d + o.d }
    }
}
impl Sub for Dual {
    type Output = Dual;
    fn sub(self, o: Dual) -> Dual {
        Dual { v: self.v - o.v, d: self.d - o.d }
    }
}
impl Mul for Dual {
    type Output = Dual;
    fn mul(self, o: Dual) -> Dual {
        Dual { v: self.v * o.v, d: self.v * o.d + self.d * o.v }
    }
}
impl Div for Dual {
    type Output = Dual;
    fn div(self, o: Dual) -> Dual {
        let v = self.v / o.v;
        Dual { v, d: (self.d - v * o.d) / o.v }
    }
}
impl Neg for Dual {
    type Output = Dual;
    fn neg(self) -> Dual {
        Dual { v: -self.v, d: -self.d }
    }
}
impl Scalar for Dual {
    fn c(value: f64) -> Self {
        Dual { v: value, d: 0.0 }
    }
    fn v(self) -> f64 {
        self.v
    }
    fn lift(self, f0: f64, f1: f64, _: f64, _: f64) -> Self {
        Dual { v: f0, d: f1 * self.d }
    }
}

/// `v + a ε₁ + b ε₂ + ab ε₁ε₂`, with `ε₁² = ε₂² = 0`: two first derivatives
/// and their mixed second derivative, exactly, with no step size anywhere.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct HyperDual {
    pub v: f64,
    pub a: f64,
    pub b: f64,
    pub ab: f64,
}

impl Add for HyperDual {
    type Output = HyperDual;
    fn add(self, o: HyperDual) -> HyperDual {
        HyperDual { v: self.v + o.v, a: self.a + o.a, b: self.b + o.b, ab: self.ab + o.ab }
    }
}
impl Sub for HyperDual {
    type Output = HyperDual;
    fn sub(self, o: HyperDual) -> HyperDual {
        HyperDual { v: self.v - o.v, a: self.a - o.a, b: self.b - o.b, ab: self.ab - o.ab }
    }
}
impl Mul for HyperDual {
    type Output = HyperDual;
    fn mul(self, o: HyperDual) -> HyperDual {
        HyperDual {
            v: self.v * o.v,
            a: self.v * o.a + self.a * o.v,
            b: self.v * o.b + self.b * o.v,
            ab: self.v * o.ab + self.a * o.b + self.b * o.a + self.ab * o.v,
        }
    }
}
impl Div for HyperDual {
    type Output = HyperDual;
    fn div(self, o: HyperDual) -> HyperDual {
        let x = o.v;
        let mut q = self * o.lift(1.0 / x, -1.0 / (x * x), 2.0 / (x * x * x), 0.0);
        // The value as a true quotient, not a product with a reciprocal, so a
        // pricer's value comes back in the same bits as its `f64` instance.
        q.v = self.v / o.v;
        q
    }
}
impl Neg for HyperDual {
    type Output = HyperDual;
    fn neg(self) -> HyperDual {
        HyperDual { v: -self.v, a: -self.a, b: -self.b, ab: -self.ab }
    }
}
impl Scalar for HyperDual {
    fn c(value: f64) -> Self {
        HyperDual { v: value, a: 0.0, b: 0.0, ab: 0.0 }
    }
    fn v(self) -> f64 {
        self.v
    }
    fn lift(self, f0: f64, f1: f64, f2: f64, _: f64) -> Self {
        HyperDual { v: f0, a: f1 * self.a, b: f1 * self.b, ab: f1 * self.ab + f2 * self.a * self.b }
    }
}

impl HyperDual {
    /// `f'` at this point, as a hyper-dual: what the tape stores as a partial.
    fn derivative(self, f1: f64, f2: f64, f3: f64) -> HyperDual {
        HyperDual { v: f1, a: f2 * self.a, b: f2 * self.b, ab: f2 * self.ab + f3 * self.a * self.b }
    }
}

// ---------------------------------------------------------------------------
// The tape.
// ---------------------------------------------------------------------------

const CONSTANT: u32 = u32::MAX;

/// One recorded operation: up to two parents, each with its local partial.
#[derive(Clone, Copy)]
struct Entry {
    parents: [(u32, HyperDual); 2],
}

thread_local! {
    static TAPE: RefCell<Vec<Entry>> = const { RefCell::new(Vec::new()) };
}

/// A variable on the adjoint tape. Its value is hyper-dual, so a reverse sweep
/// over a tape recorded with seeded inputs yields first-order adjoints that
/// carry their own derivatives.
#[derive(Clone, Copy, Debug)]
pub struct Var {
    pub value: HyperDual,
    index: u32,
}

impl Var {
    fn record(value: HyperDual, parents: [(u32, HyperDual); 2]) -> Var {
        if parents[0].0 == CONSTANT && parents[1].0 == CONSTANT {
            return Var { value, index: CONSTANT };
        }
        TAPE.with(|t| {
            let mut t = t.borrow_mut();
            t.push(Entry { parents });
            Var { value, index: (t.len() - 1) as u32 }
        })
    }

    /// An input: a variable the sweep will report an adjoint for.
    pub fn input(value: HyperDual) -> Var {
        TAPE.with(|t| {
            let mut t = t.borrow_mut();
            t.push(Entry { parents: [(CONSTANT, HyperDual::default()); 2] });
            Var { value, index: (t.len() - 1) as u32 }
        })
    }
}

impl Add for Var {
    type Output = Var;
    fn add(self, o: Var) -> Var {
        Var::record(self.value + o.value, [(self.index, HyperDual::c(1.0)), (o.index, HyperDual::c(1.0))])
    }
}
impl Sub for Var {
    type Output = Var;
    fn sub(self, o: Var) -> Var {
        Var::record(self.value - o.value, [(self.index, HyperDual::c(1.0)), (o.index, HyperDual::c(-1.0))])
    }
}
impl Mul for Var {
    type Output = Var;
    fn mul(self, o: Var) -> Var {
        Var::record(self.value * o.value, [(self.index, o.value), (o.index, self.value)])
    }
}
impl Div for Var {
    type Output = Var;
    fn div(self, o: Var) -> Var {
        let inverse = HyperDual::c(1.0) / o.value;
        let value = self.value / o.value;
        Var::record(value, [(self.index, inverse), (o.index, -(value * inverse))])
    }
}
impl Neg for Var {
    type Output = Var;
    fn neg(self) -> Var {
        Var::record(-self.value, [(self.index, HyperDual::c(-1.0)), (CONSTANT, HyperDual::default())])
    }
}
impl Scalar for Var {
    fn c(value: f64) -> Self {
        Var { value: HyperDual::c(value), index: CONSTANT }
    }
    fn v(self) -> f64 {
        self.value.v
    }
    fn lift(self, f0: f64, f1: f64, f2: f64, f3: f64) -> Self {
        Var::record(
            self.value.lift(f0, f1, f2, f3),
            [(self.index, self.value.derivative(f1, f2, f3)), (CONSTANT, HyperDual::default())],
        )
    }
}

/// Records `f` on a fresh tape and sweeps it backwards from its output.
///
/// Returns the output and the adjoint of each input, in order. The tape is
/// cleared before and after, so nothing from one call can leak into the next.
pub fn adjoint<const N: usize>(inputs: [HyperDual; N], f: impl FnOnce([Var; N]) -> Var) -> (HyperDual, [HyperDual; N]) {
    TAPE.with(|t| t.borrow_mut().clear());
    let vars = inputs.map(Var::input);
    let out = f(vars);
    let adjoints = TAPE.with(|t| {
        let tape = t.borrow();
        let mut bar = vec![HyperDual::default(); tape.len()];
        if out.index != CONSTANT {
            bar[out.index as usize] = HyperDual::c(1.0);
        }
        for e in (0..tape.len()).rev() {
            let b = bar[e];
            if b == HyperDual::default() {
                continue;
            }
            for &(parent, partial) in &tape[e].parents {
                if parent != CONSTANT {
                    bar[parent as usize] = bar[parent as usize] + b * partial;
                }
            }
        }
        vars.map(|v| bar[v.index as usize])
    });
    // Cleared, and its capacity kept: an American's sweep records about
    // 119,000 operations, and a detail view asks again on every edit.
    TAPE.with(|t| t.borrow_mut().clear());
    (out.value, adjoints)
}

// ---------------------------------------------------------------------------
// The pricers, over any `Scalar`.
// ---------------------------------------------------------------------------

/// The five inputs, and the two that are not differentiated.
#[derive(Clone, Copy, Debug)]
pub struct Contract<F> {
    pub spot: F,
    pub strike: F,
    pub time: F,
    pub rate: F,
    pub dividend: F,
    pub vol: F,
    pub kind: OptionType,
}

/// Black-Scholes-Merton, operation for operation as `bsm::price` computes it,
/// so the `f64` instance returns the same bits.
pub fn european<F: Scalar>(c: &Contract<F>) -> F {
    let sign = F::c(match c.kind {
        OptionType::Call => 1.0,
        OptionType::Put => -1.0,
    });
    let sqrt_t = c.time.sqrt();
    let vol_sqrt_t = c.vol * sqrt_t;
    let d1 = ((c.spot / c.strike).ln() + (c.rate - c.dividend + F::c(0.5) * c.vol * c.vol) * c.time) / vol_sqrt_t;
    let d2 = d1 - vol_sqrt_t;
    let disc_r = (-(c.rate * c.time)).exp();
    let disc_q = (-(c.dividend * c.time)).exp();
    sign * (c.spot * disc_q * (sign * d1).ncdf() - c.strike * disc_r * (sign * d2).ncdf())
}

/// Every Greek of a pricer written over `Scalar`, by two reverse sweeps.
///
/// The first is seeded on spot in both hyper-dual directions: the adjoints'
/// values are delta, vega, rho and dV/dT, their first parts the spot
/// derivatives of those (gamma, vanna, and -charm), and the spot adjoint's
/// mixed part speed. The second is seeded on vol, for volga. Theta and charm
/// are in calendar time, as `bsm::greeks` reports them.
pub fn greeks_of(inputs: &Inputs, price: impl Fn(&Contract<Var>) -> Var) -> Greeks {
    let run = |seed_spot: (f64, f64), seed_vol: (f64, f64)| {
        let hd = |v: f64, (a, b): (f64, f64)| HyperDual { v, a, b, ab: 0.0 };
        adjoint(
            [
                hd(inputs.spot, seed_spot),
                hd(inputs.vol, seed_vol),
                HyperDual::c(inputs.rate),
                HyperDual::c(inputs.dividend),
                HyperDual::c(inputs.time),
            ],
            |[spot, vol, rate, dividend, time]| {
                price(&Contract { spot, strike: Var::c(inputs.strike), time, rate, dividend, vol, kind: inputs.kind })
            },
        )
    };
    let (value, [d_spot, d_vol, d_rate, _, d_time]) = run((1.0, 1.0), (0.0, 0.0));
    let (_, [_, by_vol, _, _, _]) = run((0.0, 0.0), (1.0, 0.0));
    Greeks {
        price: value.v,
        delta: d_spot.v,
        gamma: d_spot.a,
        vega: d_vol.v,
        theta: -d_time.v,
        rho: d_rate.v,
        vanna: d_vol.a,
        volga: by_vol.a,
        charm: -d_time.a,
        speed: d_spot.ab,
    }
}

/// Vanna from the vol-seeded sweep — the spot adjoint's vol derivative — for
/// holding the two sweeps to each other.
pub fn vanna_from_vol_side(inputs: &Inputs, price: impl Fn(&Contract<Var>) -> Var) -> f64 {
    let (_, [d_spot, ..]) = adjoint(
        [
            HyperDual::c(inputs.spot),
            HyperDual { v: inputs.vol, a: 1.0, b: 0.0, ab: 0.0 },
            HyperDual::c(inputs.rate),
            HyperDual::c(inputs.dividend),
            HyperDual::c(inputs.time),
        ],
        |[spot, vol, rate, dividend, time]| {
            price(&Contract { spot, strike: Var::c(inputs.strike), time, rate, dividend, vol, kind: inputs.kind })
        },
    );
    d_spot.a
}

/// The ten Greeks of an American option, by adjoint differentiation of
/// Andersen-Lake at the pinned-position scheme.
///
/// Where `andersen_lake` hands the price to Black-Scholes — degenerate inputs,
/// or a contract with no exercise region — so does this, and the Greeks are
/// the closed forms.
pub fn american_greeks(inputs: &Inputs) -> Greeks {
    if inputs.is_degenerate() || no_exercise_region(inputs) {
        return bsm::greeks(inputs);
    }
    let solver = crate::andersen_lake::solver_for(crate::andersen_lake::ACCURATE);
    greeks_of(inputs, |c| solver.price_over(c))
}

/// Whether the contract is its European twin: a put with no positive rate,
/// or a call with no positive dividend.
fn no_exercise_region(inputs: &Inputs) -> bool {
    match inputs.kind {
        OptionType::Put => inputs.rate <= 0.0,
        OptionType::Call => inputs.dividend <= 0.0,
    }
}

impl Solver {
    /// `price`, over any `Scalar`. Mirrors the `f64` arithmetic operation for
    /// operation, and `tests/pricing.rs` holds the `f64` instance to the same
    /// bits as `price` across the accuracy corpus.
    pub fn price_over<F: Scalar>(&self, c: &Contract<F>) -> F {
        let put = match c.kind {
            OptionType::Put => *c,
            OptionType::Call => Contract {
                spot: c.strike,
                strike: c.spot,
                rate: c.dividend,
                dividend: c.rate,
                kind: OptionType::Put,
                ..*c
            },
        };
        if put.rate.v() <= 0.0 {
            return european(c);
        }
        let (at_expiry, h) = self.unit_boundary_over(put.rate, put.dividend, put.vol, put.time);
        self.put_price_over(&put, &h, put.strike * at_expiry)
    }

    /// The unit-strike boundary: `(B(0), H at the collocation nodes)`.
    fn unit_boundary_over<F: Scalar>(&self, rate: F, dividend: F, vol: F, time: F) -> (F, Vec<F>) {
        let strike = F::c(1.0);
        let at_expiry = if dividend.v() <= 0.0 {
            strike
        } else {
            let ratio = rate / dividend;
            strike * if ratio.v() < 1.0 { ratio } else { F::c(1.0) }
        };
        let drift = rate - dividend;
        let half_var = F::c(0.5) * vol * vol;
        let gl = self.equation_rule();
        let cheb = self.collocation();
        let last = cheb.len - 1;
        let log_expiry_over_strike = (at_expiry / strike).ln();

        let mut h: Vec<F> = vec![F::c(0.0); cheb.len];
        for _ in 0..self.scheme.iterations {
            let mut next = h.clone();
            for (i, &node) in cheb.nodes.iter().enumerate().take(last) {
                let tau = time * F::c(sq(0.5 * (1.0 + node)));
                if tau.v() <= 0.0 {
                    continue;
                }
                let log_b_tau = neg_root(h[i]);
                let (dm, dp) = d_pair(log_expiry_over_strike + log_b_tau, tau, drift, half_var, vol);
                let mut numerator = (-(rate * tau)).exp() * dm.ncdf();
                let mut denominator = (-(dividend * tau)).exp() * dp.ncdf();
                let mut num_integral = F::c(0.0);
                let mut den_integral = F::c(0.0);
                for j in 0..gl.len {
                    let v = 0.5 * (1.0 + gl.nodes[j]);
                    let elapsed = tau * F::c(sq(v));
                    let log_ratio = log_b_tau - log_level(cheb, &h, tau - elapsed, time);
                    let (dm, dp) = d_pair(log_ratio, elapsed, drift, half_var, vol);
                    let jacobian = F::c(gl.weights[j]) * tau * F::c(v);
                    num_integral = num_integral + jacobian * (-(rate * elapsed)).exp() * dm.ncdf();
                    den_integral = den_integral + jacobian * (-(dividend * elapsed)).exp() * dp.ncdf();
                }
                numerator = numerator + rate * num_integral;
                denominator = denominator + dividend * den_integral;
                let usable = denominator.v().partial_cmp(&0.0) == Some(core::cmp::Ordering::Greater)
                    && numerator.v().partial_cmp(&0.0) == Some(core::cmp::Ordering::Greater);
                if !usable {
                    continue;
                }
                let raw = strike * numerator / denominator;
                let floor = 1e-12 * strike.v();
                let b_new = if raw.v() < floor {
                    F::c(floor)
                } else if raw.v() > at_expiry.v() {
                    at_expiry
                } else {
                    raw
                };
                let l = (b_new / at_expiry).ln();
                next[i] = l * l;
            }
            h = next;
        }
        (at_expiry, h)
    }

    fn put_price_over<F: Scalar>(&self, c: &Contract<F>, h: &[F], at_expiry: F) -> F {
        let cheb = self.collocation();
        let intrinsic = c.strike - c.spot;
        let log_spot_over_expiry = (c.spot / at_expiry).ln();
        if log_spot_over_expiry.v() <= log_level(cheb, h, c.time, c.time).v() {
            return intrinsic;
        }
        let european = european(c);
        let gl = self.pricing_rule();
        let drift = c.rate - c.dividend;
        let half_var = F::c(0.5) * c.vol * c.vol;
        let mut premium = F::c(0.0);
        for j in 0..gl.len {
            let v = 0.5 * (1.0 + gl.nodes[j]);
            let elapsed = c.time * F::c(sq(v));
            let log_ratio = log_spot_over_expiry - log_level(cheb, h, c.time - elapsed, c.time);
            let (dm, dp) = d_pair(log_ratio, elapsed, drift, half_var, c.vol);
            let integrand = c.rate * c.strike * (-(c.rate * elapsed)).exp() * (-dm).ncdf()
                - c.dividend * c.spot * (-(c.dividend * elapsed)).exp() * (-dp).ncdf();
            premium = premium + F::c(gl.weights[j]) * c.time * F::c(v) * integrand;
        }
        let total = european + premium;
        let bounded = if total.v() >= european.v() { total } else { european };
        if bounded.v() >= intrinsic.v() {
            bounded
        } else {
            intrinsic
        }
    }
}

#[inline]
fn sq(x: f64) -> f64 {
    x * x
}

/// `-√max(H, 0)`, with the derivative of the clamp: zero where it binds.
fn neg_root<F: Scalar>(h: F) -> F {
    if h.v() > 0.0 {
        -h.sqrt()
    } else {
        F::c(-0.0)
    }
}

/// `ln(B(τ)/B(0))` from the boundary's nodes, as `Boundary::log_level` reads it.
///
/// The Chebyshev abscissa is `2√(τ/T) - 1`, and every caller passes a `τ` that
/// is a fixed fraction of `T`, so it does not move with any input: it is taken
/// from the values and treated as a constant, which is exact.
fn log_level<F: Scalar>(cheb: &crate::quad::Chebyshev, h: &[F], tau: F, time: F) -> F {
    if tau.v() <= 0.0 {
        return F::c(0.0);
    }
    let z = 2.0 * libm::sqrt(tau.v() / time.v()) - 1.0;
    let mut numerator = F::c(0.0);
    let mut denominator = 0.0;
    for (i, &node) in cheb.nodes.iter().enumerate().take(cheb.len) {
        let diff = z - node;
        if diff == 0.0 {
            return neg_root(h[i]);
        }
        let term = cheb.weight(i) / diff;
        numerator = numerator + F::c(term) * h[i];
        denominator += term;
    }
    neg_root(numerator / F::c(denominator))
}

#[inline]
fn d_pair<F: Scalar>(log_ratio: F, u: F, drift: F, half_var: F, vol: F) -> (F, F) {
    let sqrt_u = u.sqrt();
    let scale = vol * sqrt_u;
    let base = (log_ratio + drift * u) / scale;
    let spread = half_var * u / scale;
    (base - spread, base + spread)
}
