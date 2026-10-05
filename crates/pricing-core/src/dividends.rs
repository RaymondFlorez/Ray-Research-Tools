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
fn pv_between(dividends: &[CashDividend], rate: f64, from: f64, expiry: f64) -> f64 {
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
