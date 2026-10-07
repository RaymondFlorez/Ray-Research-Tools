//! Discrete cash dividends (PRD 5.4: "discrete dividend handling").
//!
//! Every other pricer in the crate takes a continuous yield. That is the
//! right model for an index and the wrong one for a single name that pays a
//! known amount on a known date: a call on a stock about to go ex-dividend is
//! worth exercising the day before, and a continuous yield spreads the drop
//! over the whole life of the option so no single day ever looks like that.
//!
//! The model here is the **escrowed dividend** model. The dividends promised
//! before expiry are a riskless bond; the stock less that bond's present value
//! follows the lognormal process, and the stock itself is that process plus
//! the bond. So
//!
//! - a European option is Black-Scholes-Merton on the escrowed spot
//!   `S - sum D_i e^{-r t_i}`, and
//! - an American option is a Cox-Ross-Rubinstein tree on the escrowed spot,
//!   with the exercise decision at each node taken on the *actual* stock
//!   price — the escrowed level plus the present value, at that node, of the
//!   dividends still to come.
//!
//! The tree is checked against Roll-Geske-Whaley, the published closed form
//! for an American call with one cash dividend under exactly this model,
//! computed in the test suite with its own bivariate normal.
//!
//! What the escrowed model gets wrong is known and stated: it uses the vol of
//! the stock-less-dividends, so with a vol quoted on the stock itself it
//! understates the option a little, more for long-dated options with large
//! dividends. That is a calibration question for the vol fed in, not a bug in
//! the tree.

use crate::bsm::{self, Inputs, OptionType};

/// A cash dividend: `amount` per share, going ex `time` years from now.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct CashDividend {
    pub time: f64,
    pub amount: f64,
}

/// Present value now of the dividends that go ex strictly after `from` and at
/// or before `expiry`.
pub(crate) fn pv_between(dividends: &[CashDividend], rate: f64, from: f64, expiry: f64) -> f64 {
    dividends
        .iter()
        .filter(|d| d.time > from && d.time <= expiry && d.amount > 0.0)
        .map(|d| d.amount * libm::exp(-rate * (d.time - from)))
        .sum()
}

/// The stock less the present value of the dividends due before expiry.
pub fn escrowed_spot(inputs: &Inputs, dividends: &[CashDividend]) -> f64 {
    inputs.spot - pv_between(dividends, inputs.rate, 0.0, inputs.time)
}

/// A European option under the escrowed model.
pub fn european_price(inputs: &Inputs, dividends: &[CashDividend]) -> f64 {
    let escrowed = escrowed_spot(inputs, dividends);
    if !(escrowed > 0.0) {
        return f64::NAN;
    }
    bsm::price(&Inputs { spot: escrowed, ..*inputs })
}

/// An American option under the escrowed model, on a CRR tree of `steps`.
///
/// With no dividends this is the same tree, step for step, as
/// `american::binomial_price`, and a test holds the two bit-identical.
pub fn american_price(inputs: &Inputs, dividends: &[CashDividend], steps: usize) -> f64 {
    let escrowed = escrowed_spot(inputs, dividends);
    if !(escrowed > 0.0) {
        return f64::NAN;
    }
    if inputs.time <= 0.0 {
        return inputs.intrinsic();
    }
    let steps = steps.max(1);
    let dt = inputs.time / steps as f64;
    let u = libm::exp(inputs.vol * dt.sqrt());
    let d = 1.0 / u;
    let disc = libm::exp(-inputs.rate * dt);
    let growth = libm::exp(inputs.carry() * dt);
    let p = (growth - d) / (u - d);
    if !(0.0..=1.0).contains(&p) {
        return european_price(inputs, dividends);
    }

    let exercise = |stock: f64| match inputs.kind {
        OptionType::Call => stock - inputs.strike,
        OptionType::Put => inputs.strike - stock,
    };

    // Escrowed levels at expiry, built the way `american::binomial_price`
    // builds them so the no-dividend case is the same arithmetic.
    let mut levels = Vec::with_capacity(steps + 1);
    let mut level = escrowed;
    for _ in 0..steps {
        level *= d;
    }
    levels.push(level);
    let ratio = u / d;
    for _ in 0..steps {
        level *= ratio;
        levels.push(level);
    }

    // At expiry nothing is still to come, so the stock is the escrowed level.
    let mut values: Vec<f64> = levels.iter().map(|&s| exercise(s).max(0.0)).collect();

    let inv_d = 1.0 / d;
    let mut scale = 1.0;
    for step in (0..steps).rev() {
        scale *= inv_d;
        let t = step as f64 * dt;
        // What the stock carries on top of the escrowed level at this layer:
        // the dividends still ahead, discounted to here. Zero with none.
        let ahead = pv_between(dividends, inputs.rate, t, inputs.time);
        for i in 0..=step {
            let hold = disc * (p * values[i + 1] + (1.0 - p) * values[i]);
            let stock = levels[i] * scale + ahead;
            values[i] = hold.max(exercise(stock));
        }
    }
    values[0]
}

/// One option's American value under cash dividends, across a range of spots,
/// from two trees rather than one per spot.
///
/// The scenario grid needs the same leg priced at 25 spots, and nothing short
/// of the tree is accurate enough to stand in for it: measured over 160
/// options against an averaged 8,000-step tree (`examples/div_fastpath_scan.rs`),
/// the best closed-form stand-ins miss by 40 ticks on puts and 73 on calls —
/// against a guard tolerance of half a tick.
///
/// So each tree is rooted `m` steps *before* today. Its layer at today then
/// holds the option's value at `m + 1` spots, two log-steps apart, across the
/// range the grid spans, and a spot between nodes is read by quadratic
/// interpolation in log escrowed spot. Two trees, `n` and `n + 1` steps to
/// expiry, are averaged, which cancels most of CRR's odd-even oscillation. At
/// 200 steps the ladder is within 0.80 ticks of an averaged 4,000-step tree
/// over 150 option-spots (`tests/pricing.rs`); on the scan's harsher
/// schedules a single 200-step tree pair is within 1.5.
pub struct DividendLadder {
    escrowed_today: f64,
    pv_today: f64,
    reads: [(f64, usize, Vec<f64>); 2],
}

impl DividendLadder {
    /// `inputs.spot` is the centre of the range; `log_span` the largest
    /// distance, in log escrowed spot, a read will be asked for.
    pub fn new(inputs: &Inputs, dividends: &[CashDividend], steps: usize, log_span: f64) -> Option<DividendLadder> {
        let pv_today = pv_between(dividends, inputs.rate, 0.0, inputs.time);
        let escrowed_today = inputs.spot - pv_today;
        if !(escrowed_today > 0.0) || !(inputs.time > 0.0) || !(inputs.vol > 0.0) {
            return None;
        }
        let build = |n: usize| -> Option<(f64, usize, Vec<f64>)> {
            let dt = inputs.time / n as f64;
            let u = libm::exp(inputs.vol * libm::sqrt(dt));
            let d = 1.0 / u;
            let p = (libm::exp(inputs.carry() * dt) - d) / (u - d);
            if !(0.0..=1.0).contains(&p) {
                return None;
            }
            let disc = libm::exp(-inputs.rate * dt);
            // Layer m spans j in [-m, m] in steps of two log-steps each side,
            // plus one node of margin for the interpolation stencil.
            let mut m = (log_span / (inputs.vol * libm::sqrt(dt))) as usize + 3;
            m += m % 2;
            let total = n + m;
            let exercise = |stock: f64| match inputs.kind {
                OptionType::Call => stock - inputs.strike,
                OptionType::Put => inputs.strike - stock,
            };
            let mut level = escrowed_today;
            for _ in 0..total {
                level *= d;
            }
            let ratio = u / d;
            let mut levels = Vec::with_capacity(total + 1);
            for _ in 0..=total {
                levels.push(level);
                level *= ratio;
            }
            let mut values: Vec<f64> = levels.iter().map(|&s| exercise(s).max(0.0)).collect();
            let mut scale = 1.0;
            for step in (m..total).rev() {
                scale *= u;
                let t = (step - m) as f64 * dt;
                let ahead = pv_between(dividends, inputs.rate, t, inputs.time);
                for i in 0..=step {
                    let hold = disc * (p * values[i + 1] + (1.0 - p) * values[i]);
                    values[i] = hold.max(exercise(levels[i] * scale + ahead));
                }
            }
            values.truncate(m + 1);
            Some((libm::log(u), m, values))
        };
        Some(DividendLadder { escrowed_today, pv_today, reads: [build(steps)?, build(steps + 1)?] })
    }

    /// The value at `spot`, or NaN outside the span or with no escrowed stock left.
    pub fn value(&self, spot: f64) -> f64 {
        let escrowed = spot - self.pv_today;
        if !(escrowed > 0.0) {
            return f64::NAN;
        }
        let mut total = 0.0;
        for (log_u, m, values) in &self.reads {
            // Node i at today sits at log-step 2i - m from the centre.
            let x = (libm::log(escrowed / self.escrowed_today) / log_u + *m as f64) / 2.0;
            if !(x >= 0.5 && x <= *m as f64 - 0.5) {
                return f64::NAN;
            }
            let i = (libm::floor(x + 0.5) as usize).clamp(1, m - 1);
            let f = x - i as f64;
            let (a, b, c) = (values[i - 1], values[i], values[i + 1]);
            total += b + 0.5 * f * (c - a) + 0.5 * f * f * (c - 2.0 * b + a);
        }
        0.5 * total
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::american::binomial_price;

    fn call() -> Inputs {
        Inputs { spot: 100.0, strike: 95.0, time: 0.5, rate: 0.05, dividend: 0.0, vol: 0.3, kind: OptionType::Call }
    }

    #[test]
    fn no_dividends_is_the_existing_tree_bit_for_bit() {
        for kind in [OptionType::Call, OptionType::Put] {
            let inputs = Inputs { kind, ..call() };
            assert_eq!(american_price(&inputs, &[], 400).to_bits(), binomial_price(&inputs, 400).to_bits());
        }
    }

    #[test]
    fn a_dividend_after_expiry_changes_nothing() {
        let late = [CashDividend { time: 0.75, amount: 3.0 }];
        assert_eq!(european_price(&call(), &late), bsm::price(&call()));
        assert_eq!(american_price(&call(), &late, 300).to_bits(), binomial_price(&call(), 300).to_bits());
    }

    #[test]
    fn a_dividend_makes_early_exercise_of_a_call_worth_something() {
        // Without dividends an American call on a non-payer is the European
        // call; with a large dividend just before expiry it is not.
        let divs = [CashDividend { time: 0.45, amount: 4.0 }];
        let euro = european_price(&call(), &divs);
        let amer = american_price(&call(), &divs, 800);
        assert!(amer > euro + 0.5, "{amer} against {euro}");
        let none = american_price(&call(), &[], 800);
        assert!((none - bsm::price(&call())).abs() < 0.02);
    }

    #[test]
    fn a_dividend_raises_a_put() {
        let put = Inputs { kind: OptionType::Put, ..call() };
        let divs = [CashDividend { time: 0.2, amount: 3.0 }];
        let with = american_price(&put, &divs, 600);
        assert!(with > american_price(&put, &[], 600));
        assert!(with >= european_price(&put, &divs));
    }

    #[test]
    fn refuses_dividends_worth_more_than_the_stock() {
        let divs = [CashDividend { time: 0.1, amount: 150.0 }];
        assert!(european_price(&call(), &divs).is_nan());
        assert!(american_price(&call(), &divs, 100).is_nan());
    }
}
