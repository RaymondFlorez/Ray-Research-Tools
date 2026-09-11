//! Quadrature and interpolation primitives for the Andersen-Lake solver.
//!
//! Two things, both stack-allocated: Gauss-Legendre nodes for the integrals and
//! Chebyshev-Lobatto collocation for the exercise boundary.
//!
//! Nothing here allocates. The grid path calls the solver once per cell per
//! leg — fifteen thousand times for the PRD's worked example — and a `Vec` per
//! call would cost more than the quadrature does.
//!
//! The nodes are *computed*, not tabulated. A table of twenty-five
//! sixteen-digit constants transcribed by hand is a silent wrong answer waiting
//! to happen; a Newton solve on the Legendre recurrence is checkable, and
//! `test::integrates_polynomials_exactly` checks it against the definition —
//! an l-point rule is exact for every polynomial up to degree 2l-1.

/// Largest rule this module builds. Andersen-Lake's published schemes top out
/// well below this; the cap exists so everything can live on the stack.
pub const MAX_NODES: usize = 40;

/// A fixed-order Gauss-Legendre rule on [-1, 1].
#[derive(Clone, Copy, Debug)]
pub struct Legendre {
    pub nodes: [f64; MAX_NODES],
    pub weights: [f64; MAX_NODES],
    pub len: usize,
}

impl Legendre {
    /// Builds the n-point rule by Newton iteration on P_n.
    ///
    /// The iteration terminates on a bit-level condition, so it runs the same
    /// number of steps on both targets and the nodes are identical on both.
    pub fn new(n: usize) -> Legendre {
        let n = n.clamp(1, MAX_NODES);
        let mut rule = Legendre { nodes: [0.0; MAX_NODES], weights: [0.0; MAX_NODES], len: n };
        let nf = n as f64;

        // The rule is symmetric, so only half the roots are solved for.
        for k in 0..n.div_ceil(2) {
            // Tricomi's starting estimate, good to about 1e-3.
            let mut x = libm::cos(core::f64::consts::PI * (k as f64 + 0.75) / (nf + 0.5));
            for _ in 0..100 {
                let (p, dp) = legendre(n, x);
                let step = p / dp;
                x -= step;
                if step == 0.0 || libm::fabs(step) < 1e-16 * libm::fabs(x).max(1e-3) {
                    break;
                }
            }
            let (_, dp) = legendre(n, x);
            let w = 2.0 / ((1.0 - x * x) * dp * dp);
            rule.nodes[k] = -x;
            rule.weights[k] = w;
            rule.nodes[n - 1 - k] = x;
            rule.weights[n - 1 - k] = w;
        }
        rule
    }

    /// Integrates `f` over [a, b].
    #[inline]
    pub fn integrate<F: FnMut(f64) -> f64>(&self, a: f64, b: f64, mut f: F) -> f64 {
        let half = 0.5 * (b - a);
        let mid = 0.5 * (b + a);
        let mut sum = 0.0;
        for i in 0..self.len {
            sum += self.weights[i] * f(mid + half * self.nodes[i]);
        }
        sum * half
    }
}

/// P_n(x) and its derivative, by the three-term recurrence.
fn legendre(n: usize, x: f64) -> (f64, f64) {
    let mut p_prev = 1.0;
    let mut p = x;
    if n == 0 {
        return (1.0, 0.0);
    }
    for k in 2..=n {
        let kf = k as f64;
        let next = ((2.0 * kf - 1.0) * x * p - (kf - 1.0) * p_prev) / kf;
        p_prev = p;
        p = next;
    }
    // d/dx P_n = n (x P_n - P_{n-1}) / (x^2 - 1)
    let dp = (n as f64) * (x * p - p_prev) / (x * x - 1.0);
    (p, dp)
}

/// Chebyshev-Lobatto collocation on [-1, 1]: z_i = cos(i·pi/n), i = 0..n.
///
/// Values live at the nodes and are read back by the barycentric formula, which
/// needs no coefficient transform and is stable right up to the endpoints —
/// where, for this solver, the boundary's only singularity sits.
#[derive(Clone, Copy, Debug)]
pub struct Chebyshev {
    pub nodes: [f64; MAX_NODES],
    /// Barycentric weights: alternating sign, halved at the two endpoints.
    weights: [f64; MAX_NODES],
    pub len: usize,
}

impl Chebyshev {
    /// `n` intervals, so `n + 1` nodes, ordered from z = 1 down to z = -1.
    pub fn new(n: usize) -> Chebyshev {
        let count = (n + 1).clamp(2, MAX_NODES);
        let mut cheb = Chebyshev { nodes: [0.0; MAX_NODES], weights: [0.0; MAX_NODES], len: count };
        let last = count - 1;
        for i in 0..count {
            cheb.nodes[i] = libm::cos(core::f64::consts::PI * (i as f64) / (last as f64));
            let sign = if i % 2 == 0 { 1.0 } else { -1.0 };
            cheb.weights[i] = if i == 0 || i == last { 0.5 * sign } else { sign };
        }
        cheb
    }

    /// Barycentric evaluation of the interpolant through `values` at `z`.
    pub fn eval(&self, values: &[f64; MAX_NODES], z: f64) -> f64 {
        let mut numerator = 0.0;
        let mut denominator = 0.0;
        for (i, &node) in self.nodes.iter().enumerate().take(self.len) {
            let diff = z - node;
            // Landing exactly on a node makes the formula 0/0; the node's own
            // value is the answer, and this is the common case at collocation.
            if diff == 0.0 {
                return values[i];
            }
            let term = self.weights[i] / diff;
            numerator += term * values[i];
            denominator += term;
        }
        numerator / denominator
    }
}

#[cfg(test)]
mod test {
    use super::*;

    /// The defining property: an l-point rule is exact through degree 2l-1.
    #[test]
    fn integrates_polynomials_exactly() {
        for l in [3usize, 5, 7, 13, 25] {
            let rule = Legendre::new(l);
            for degree in 0..(2 * l) {
                let got = rule.integrate(-1.0, 1.0, |x| libm::pow(x, degree as f64));
                // Integral of x^d over [-1,1] is 0 for odd d, 2/(d+1) for even.
                let want = if degree % 2 == 1 { 0.0 } else { 2.0 / (degree as f64 + 1.0) };
                assert!(
                    libm::fabs(got - want) < 1e-12,
                    "l={l} degree={degree}: {got} vs {want}",
                );
            }
        }
    }

    #[test]
    fn weights_are_positive_and_sum_to_the_interval() {
        for l in [1usize, 2, 7, 25, 40] {
            let rule = Legendre::new(l);
            let sum: f64 = (0..rule.len).map(|i| rule.weights[i]).sum();
            assert!(libm::fabs(sum - 2.0) < 1e-13, "l={l} weights sum to {sum}");
            assert!((0..rule.len).all(|i| rule.weights[i] > 0.0), "l={l} has a negative weight");
        }
    }

    #[test]
    fn nodes_are_ordered_and_inside_the_interval() {
        let rule = Legendre::new(13);
        for i in 1..rule.len {
            assert!(rule.nodes[i] > rule.nodes[i - 1]);
        }
        assert!(rule.nodes[0] > -1.0 && rule.nodes[rule.len - 1] < 1.0);
    }

    #[test]
    fn chebyshev_reproduces_a_polynomial_it_can_represent() {
        let cheb = Chebyshev::new(8);
        let f = |z: f64| 3.0 * z * z * z - z + 0.25;
        let mut values = [0.0; MAX_NODES];
        for i in 0..cheb.len {
            values[i] = f(cheb.nodes[i]);
        }
        for probe in [-1.0, -0.731, -0.25, 0.0, 0.4, 0.912, 1.0] {
            assert!(libm::fabs(cheb.eval(&values, probe) - f(probe)) < 1e-12, "at {probe}");
        }
    }

    #[test]
    fn chebyshev_returns_node_values_exactly() {
        let cheb = Chebyshev::new(6);
        let mut values = [0.0; MAX_NODES];
        for i in 0..cheb.len {
            values[i] = (i as f64) * 0.37;
        }
        for i in 0..cheb.len {
            assert_eq!(cheb.eval(&values, cheb.nodes[i]), values[i]);
        }
    }
}
