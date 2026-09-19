//! Gaussian and t copulas (PRD 5.8).
//!
//! "a copula-based multivariate sampler (Gaussian and t) for cross-asset
//! dependence."
//!
//! And from the walkthrough, the claim that makes the second one necessary:
//! "100k Monte Carlo paths on the shocked regime with a t-copula for the semis
//! cluster, **since Gaussian correlation badly understates joint tail behavior
//! in that group**."
//!
//! That is a testable statement, not a preference, and it is the thing this
//! module is measured on. The tail dependence coefficient
//!
//! ```text
//! lambda = lim_{q -> 0} P(U2 < q | U1 < q)
//! ```
//!
//! is **zero for a Gaussian copula at every correlation below one** and
//! strictly positive for a t copula. So a portfolio whose names crash together
//! is mispriced by a Gaussian copula no matter what correlation is fitted to
//! it: the correlation is a statement about the middle of the distribution and
//! the analyst is asking a question about the corner. `tail_dependence` gives
//! the closed form, and `t_copula_has_tail_dependence_and_gaussian_does_not`
//! measures both against it.
//!
//! The separation of dependence from marginals is the point of a copula and it
//! is why `sample` returns uniforms. A caller applies whatever marginal it
//! likes — a fitted historical quantile function, a Student-t, the bootstrap in
//! `resample.rs` — without the dependence structure changing underneath it.

use crate::mc::sample_gamma;
use crate::normal::{cdf as normal_cdf, inv_cdf as normal_inv_cdf};
use crate::rng::Rng;
use crate::special::student_t_cdf;

/// A correlation matrix that has been factored, or rejected.
#[derive(Clone, Debug, PartialEq)]
pub struct Factor {
    dimension: usize,
    /// Lower triangular, row-major, `dimension * dimension`.
    lower: Vec<f64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum FactorError {
    /// The matrix is not square, or the dimension is zero.
    Shape,
    /// The diagonal is not one, so it is a covariance matrix and not a
    /// correlation matrix. Silently normalizing it would change what the
    /// caller asked for.
    Diagonal,
    /// Not symmetric.
    Asymmetric,
    /// Not positive definite. The leading minor that failed is reported,
    /// because that names the block of assets whose correlations are
    /// inconsistent.
    NotPositiveDefinite { leading_minor: usize },
}

impl Factor {
    /// Cholesky, with the failures reported rather than repaired.
    ///
    /// A correlation matrix estimated from unequal-length histories, or
    /// assembled by hand from pairwise guesses, is routinely not positive
    /// definite. The tempting fix is to nudge the eigenvalues and carry on;
    /// this refuses instead, for the same reason `CurveNode` shows a residual
    /// warning rather than a smooth lie. The analyst asserted something
    /// impossible and should be told which assets did it.
    pub fn cholesky(matrix: &[f64], dimension: usize) -> Result<Factor, FactorError> {
        if dimension == 0 || matrix.len() != dimension * dimension {
            return Err(FactorError::Shape);
        }
        for i in 0..dimension {
            if (matrix[i * dimension + i] - 1.0).abs() > 1e-12 {
                return Err(FactorError::Diagonal);
            }
            for j in 0..i {
                if (matrix[i * dimension + j] - matrix[j * dimension + i]).abs() > 1e-12 {
                    return Err(FactorError::Asymmetric);
                }
            }
        }

        let mut lower = vec![0.0; dimension * dimension];
        for i in 0..dimension {
            for j in 0..=i {
                let mut sum = matrix[i * dimension + j];
                for k in 0..j {
                    sum -= lower[i * dimension + k] * lower[j * dimension + k];
                }
                if i == j {
                    if sum <= 0.0 {
                        return Err(FactorError::NotPositiveDefinite { leading_minor: i + 1 });
                    }
                    lower[i * dimension + j] = libm::sqrt(sum);
                } else {
                    lower[i * dimension + j] = sum / lower[j * dimension + j];
                }
            }
        }
        Ok(Factor { dimension, lower })
    }

    /// The identity: independent components.
    pub fn independent(dimension: usize) -> Factor {
        let mut lower = vec![0.0; dimension * dimension];
        for i in 0..dimension {
            lower[i * dimension + i] = 1.0;
        }
        Factor { dimension, lower }
    }

    /// Equicorrelated, the usual shorthand for a cluster.
    pub fn equicorrelated(dimension: usize, rho: f64) -> Result<Factor, FactorError> {
        let mut matrix = vec![rho; dimension * dimension];
        for i in 0..dimension {
            matrix[i * dimension + i] = 1.0;
        }
        Factor::cholesky(&matrix, dimension)
    }

    pub fn dimension(&self) -> usize {
        self.dimension
    }

    /// `out = L * z`, in place.
    ///
    /// Turns a vector of independent standard normals into one carrying the
    /// factor's correlation structure. Public to the crate because the
    /// multi-asset path simulator needs exactly this and nothing else from a
    /// copula: it correlates the Brownian increments directly rather than going
    /// through uniforms and back, which is the same thing for the Gaussian case
    /// and avoids two round trips through the normal CDF per asset per step.
    pub(crate) fn apply(&self, z: &[f64], out: &mut [f64]) {
        for i in 0..self.dimension {
            let mut sum = 0.0;
            for k in 0..=i {
                sum += self.lower[i * self.dimension + k] * z[k];
            }
            out[i] = sum;
        }
    }
}

/// A copula: a joint distribution on the unit cube with uniform margins.
pub trait Copula {
    fn dimension(&self) -> usize;
    /// Fill `out` with one draw of uniforms carrying the dependence structure.
    fn sample(&self, out: &mut [f64], rng: &mut Rng);
    /// The coefficient of lower tail dependence between any correlated pair.
    fn tail_dependence(&self, rho: f64) -> f64;
}

/// The Gaussian copula.
#[derive(Clone, Debug)]
pub struct GaussianCopula {
    factor: Factor,
    scratch: usize,
}

impl GaussianCopula {
    pub fn new(factor: Factor) -> GaussianCopula {
        let scratch = factor.dimension();
        GaussianCopula { factor, scratch }
    }
}

impl Copula for GaussianCopula {
    fn dimension(&self) -> usize {
        self.scratch
    }

    fn sample(&self, out: &mut [f64], rng: &mut Rng) {
        let n = self.factor.dimension();
        let mut z = vec![0.0; n];
        for slot in z.iter_mut() {
            *slot = rng.next_normal();
        }
        let mut correlated = vec![0.0; n];
        self.factor.apply(&z, &mut correlated);
        for i in 0..n.min(out.len()) {
            out[i] = normal_cdf(correlated[i]);
        }
    }

    /// Zero, always, for any correlation below one.
    ///
    /// This is not an approximation or a modelling choice. It is a property of
    /// the Gaussian distribution, and it is the reason the walkthrough reaches
    /// for a t copula for a cluster of names that crash together.
    fn tail_dependence(&self, rho: f64) -> f64 {
        if rho >= 1.0 {
            1.0
        } else {
            0.0
        }
    }
}

/// The t copula: the same correlation, a shared shock, and tails that hold.
#[derive(Clone, Debug)]
pub struct TCopula {
    factor: Factor,
    nu: f64,
}

impl TCopula {
    pub fn new(factor: Factor, nu: f64) -> TCopula {
        TCopula { factor, nu }
    }

    pub fn degrees_of_freedom(&self) -> f64 {
        self.nu
    }
}

impl Copula for TCopula {
    fn dimension(&self) -> usize {
        self.factor.dimension()
    }

    /// `X = sqrt(nu / chi2_nu) * L * Z`, then map through the t CDF.
    ///
    /// The single scalar `sqrt(nu / chi2_nu)` is the whole difference from the
    /// Gaussian case, and it is the whole effect: one draw that scales every
    /// component of the vector at once. A bad day for the common factor is a
    /// bad day for every name simultaneously, which is what joint tail
    /// behaviour is.
    fn sample(&self, out: &mut [f64], rng: &mut Rng) {
        let n = self.factor.dimension();
        let mut z = vec![0.0; n];
        for slot in z.iter_mut() {
            *slot = rng.next_normal();
        }
        let mut correlated = vec![0.0; n];
        self.factor.apply(&z, &mut correlated);

        // chi-squared with nu degrees of freedom is Gamma(nu/2, 2).
        let chi2 = 2.0 * sample_gamma(0.5 * self.nu, rng);
        let scale = if chi2 <= 0.0 { 0.0 } else { libm::sqrt(self.nu / chi2) };

        for i in 0..n.min(out.len()) {
            out[i] = student_t_cdf(scale * correlated[i], self.nu);
        }
    }

    fn tail_dependence(&self, rho: f64) -> f64 {
        tail_dependence(self.nu, rho)
    }
}

/// The closed form for the t copula's lower (and upper) tail dependence.
///
/// `lambda = 2 * t_{nu+1}( -sqrt( (nu+1)(1-rho) / (1+rho) ) )`.
///
/// At the degrees of freedom actually fitted to equity returns — three to six
/// — it is large: 0.45 at nu = 3, 0.39 at nu = 4, 0.30 at nu = 6, all at
/// rho = 0.7. Conditional on one name being in its worst one percent, the
/// other is in its worst one percent about two times in five. The Gaussian
/// answer to the same question is exactly zero.
///
/// It does go to zero as `nu` grows, and faster than one might guess: 0.026
/// at nu = 30, and numerically nothing by nu = 1000. The t copula is not a
/// permanently heavier Gaussian, it is a family that contains the Gaussian at
/// the limit, and choosing `nu` is choosing how much corner risk to carry.
pub fn tail_dependence(nu: f64, rho: f64) -> f64 {
    if rho >= 1.0 {
        return 1.0;
    }
    if rho <= -1.0 {
        return 0.0;
    }
    let argument = -libm::sqrt((nu + 1.0) * (1.0 - rho) / (1.0 + rho));
    2.0 * student_t_cdf(argument, nu + 1.0)
}

/// Map a uniform through a normal marginal. The usual companion to a copula.
pub fn normal_marginal(u: f64, mean: f64, sigma: f64) -> f64 {
    mean + sigma * normal_inv_cdf(u)
}

/// Map a uniform through the empirical marginal of a sorted sample.
///
/// Linear interpolation between order statistics, which is the marginal a
/// bootstrap-and-copula pairing actually wants: the dependence comes from the
/// copula and the shape of each name comes from its own history.
pub fn empirical_marginal(u: f64, sorted: &[f64]) -> f64 {
    if sorted.is_empty() {
        return f64::NAN;
    }
    if sorted.len() == 1 {
        return sorted[0];
    }
    let position = u * (sorted.len() - 1) as f64;
    let lower = position as usize;
    if lower + 1 >= sorted.len() {
        return sorted[sorted.len() - 1];
    }
    let weight = position - lower as f64;
    sorted[lower] * (1.0 - weight) + sorted[lower + 1] * weight
}

#[cfg(test)]
mod tests {
    use super::*;

    fn draws<C: Copula>(copula: &C, count: usize, seed: u64) -> Vec<Vec<f64>> {
        let mut rng = Rng::new(seed);
        let n = copula.dimension();
        let mut out = Vec::with_capacity(count);
        let mut row = vec![0.0; n];
        for _ in 0..count {
            copula.sample(&mut row, &mut rng);
            out.push(row.clone());
        }
        out
    }

    fn column(rows: &[Vec<f64>], i: usize) -> Vec<f64> {
        rows.iter().map(|r| r[i]).collect()
    }

    fn mean(v: &[f64]) -> f64 {
        v.iter().sum::<f64>() / v.len() as f64
    }

    fn pearson(a: &[f64], b: &[f64]) -> f64 {
        let (ma, mb) = (mean(a), mean(b));
        let mut num = 0.0;
        let mut da = 0.0;
        let mut db = 0.0;
        for i in 0..a.len() {
            let (x, y) = (a[i] - ma, b[i] - mb);
            num += x * y;
            da += x * x;
            db += y * y;
        }
        num / libm::sqrt(da * db)
    }

    /// Empirical P(U2 < q | U1 < q).
    fn joint_tail(rows: &[Vec<f64>], q: f64) -> f64 {
        let mut conditioning = 0usize;
        let mut both = 0usize;
        for row in rows {
            if row[0] < q {
                conditioning += 1;
                if row[1] < q {
                    both += 1;
                }
            }
        }
        if conditioning == 0 {
            f64::NAN
        } else {
            both as f64 / conditioning as f64
        }
    }

    #[test]
    fn cholesky_rejects_what_it_should() {
        assert_eq!(Factor::cholesky(&[1.0, 0.0], 2), Err(FactorError::Shape));
        assert_eq!(Factor::cholesky(&[2.0, 0.0, 0.0, 1.0], 2), Err(FactorError::Diagonal));
        assert_eq!(
            Factor::cholesky(&[1.0, 0.3, 0.5, 1.0], 2),
            Err(FactorError::Asymmetric)
        );
        // Three assets each 0.9 correlated with the next but -0.9 across is
        // not a correlation matrix any data could produce.
        let bad = [1.0, 0.9, -0.9, 0.9, 1.0, 0.9, -0.9, 0.9, 1.0];
        assert!(matches!(
            Factor::cholesky(&bad, 3),
            Err(FactorError::NotPositiveDefinite { .. })
        ));
    }

    #[test]
    fn cholesky_reconstructs_the_matrix_it_factored() {
        let matrix = [1.0, 0.6, 0.3, 0.6, 1.0, 0.5, 0.3, 0.5, 1.0];
        let factor = Factor::cholesky(&matrix, 3).unwrap();
        for i in 0..3 {
            for j in 0..3 {
                let mut sum = 0.0;
                for k in 0..3 {
                    sum += factor.lower[i * 3 + k] * factor.lower[j * 3 + k];
                }
                assert!((sum - matrix[i * 3 + j]).abs() < 1e-12, "({i},{j}) {sum}");
            }
        }
    }

    #[test]
    fn both_copulas_have_uniform_margins() {
        let factor = Factor::equicorrelated(3, 0.6).unwrap();
        for rows in [
            draws(&GaussianCopula::new(factor.clone()), 40_000, 5),
            draws(&TCopula::new(factor.clone(), 4.0), 40_000, 5),
        ] {
            for i in 0..3 {
                let col = column(&rows, i);
                assert!((mean(&col) - 0.5).abs() < 0.01, "mean {}", mean(&col));
                // Ten deciles, each within a percentage point of a tenth.
                for d in 0..10 {
                    let lo = d as f64 / 10.0;
                    let share = col.iter().filter(|&&u| u >= lo && u < lo + 0.1).count() as f64
                        / col.len() as f64;
                    assert!((share - 0.1).abs() < 0.01, "decile {d} share {share}");
                }
            }
        }
    }

    #[test]
    fn the_gaussian_copula_reproduces_the_correlation_it_was_given() {
        let factor = Factor::cholesky(&[1.0, 0.7, 0.7, 1.0], 2).unwrap();
        let rows = draws(&GaussianCopula::new(factor), 60_000, 11);
        // Correlation of the normal scores, which is the parameter itself.
        let a: Vec<f64> = column(&rows, 0).iter().map(|&u| normal_inv_cdf(u)).collect();
        let b: Vec<f64> = column(&rows, 1).iter().map(|&u| normal_inv_cdf(u)).collect();
        let rho = pearson(&a, &b);
        assert!((rho - 0.7).abs() < 0.01, "rho {rho}");
    }

    #[test]
    fn independence_gives_independent_uniforms() {
        let rows = draws(&GaussianCopula::new(Factor::independent(2)), 40_000, 13);
        let rho = pearson(&column(&rows, 0), &column(&rows, 1));
        assert!(rho.abs() < 0.015, "rho {rho}");
    }

    /// The closed form, checked at the values it is quoted at.
    #[test]
    fn tail_dependence_closed_form() {
        // nu = 4, rho = 0.7: about 0.39.
        let lambda = tail_dependence(4.0, 0.7);
        assert!((lambda - 0.39).abs() < 0.02, "lambda {lambda}");
        // Zero correlation still leaves tail dependence in a t copula, which
        // is the part that surprises people: the shared variance shock couples
        // the components even when the correlation matrix says nothing does.
        // Measured at 0.076 — small, and not zero, which is the Gaussian's
        // answer at every correlation below one.
        let independent = tail_dependence(4.0, 0.0);
        assert!(independent > 0.05 && independent < 0.1, "lambda at rho 0 is {independent}");
        // It decays in nu, and not slowly: 0.026 by thirty degrees of freedom.
        assert!(tail_dependence(30.0, 0.7) < 0.03);
        assert!(tail_dependence(1000.0, 0.7) < 1e-4);
        assert_eq!(tail_dependence(4.0, 1.0), 1.0);
    }

    /// The PRD's claim, measured.
    ///
    /// "a t-copula for the semis cluster, since Gaussian correlation badly
    /// understates joint tail behavior in that group."
    ///
    /// Measured at rho = 0.7, nu = 4, over 400,000 draws each, as
    /// P(U2 < q | U1 < q):
    ///
    /// | q     | Gaussian | t     | ratio |
    /// |-------|----------|-------|-------|
    /// | 0.05  | 0.389    | 0.472 | 1.21  |
    /// | 0.02  | 0.308    | 0.440 | 1.43  |
    /// | 0.01  | 0.264    | 0.423 | 1.60  |
    /// | 0.005 | 0.230    | 0.399 | 1.73  |
    ///
    /// The shape of that table is the finding, and it is worse than a fixed
    /// understatement. At the five percent level the two models agree closely
    /// enough that a fitted correlation looks fine. The gap only opens as the
    /// question gets tighter, so the model looks calibrated exactly where the
    /// analyst is not asking and fails where they are. The Gaussian column is
    /// heading for zero — slowly, which is why it fools people — while the t
    /// column is converging on its asymptote of 0.391 from above.
    #[test]
    fn t_copula_has_tail_dependence_and_gaussian_does_not() {
        let rho = 0.7;
        let nu = 4.0;
        let factor = Factor::cholesky(&[1.0, rho, rho, 1.0], 2).unwrap();
        let gaussian = draws(&GaussianCopula::new(factor.clone()), 400_000, 17);
        let student = draws(&TCopula::new(factor, nu), 400_000, 17);

        let lambda = tail_dependence(nu, rho);
        let levels = [0.05_f64, 0.02, 0.01, 0.005];

        let mut previous_gaussian = 1.0;
        let mut previous_t = 1.0;
        let mut previous_ratio = 0.0;
        for &q in &levels {
            let g = joint_tail(&gaussian, q);
            let t = joint_tail(&student, q);

            // The Gaussian falls at every tightening, heading for zero.
            assert!(g < previous_gaussian, "q {q}: gaussian {g} did not fall from {previous_gaussian}");
            previous_gaussian = g;

            // The t converges on its asymptote from above and stays near it.
            assert!(t <= previous_t + 1e-9, "q {q}: t {t} rose from {previous_t}");
            assert!(t > lambda - 0.01, "q {q}: t {t} fell below lambda {lambda}");
            assert!(t < lambda + 0.1, "q {q}: t {t} far above lambda {lambda}");
            previous_t = t;

            // And the understatement worsens the further into the corner the
            // question goes, which is the part that makes it dangerous.
            let ratio = t / g;
            assert!(ratio > previous_ratio, "q {q}: ratio {ratio} did not widen from {previous_ratio}");
            previous_ratio = ratio;
        }

        // By the half-percent level the t copula puts joint tail probability
        // at more than 1.7 times the Gaussian's.
        assert!(previous_ratio > 1.7, "final ratio {previous_ratio}");
    }

    #[test]
    fn marginals_are_separable_from_the_dependence() {
        let factor = Factor::cholesky(&[1.0, 0.8, 0.8, 1.0], 2).unwrap();
        let rows = draws(&TCopula::new(factor, 5.0), 20_000, 23);
        // The same uniforms, through two different marginals, keep their rank
        // correlation: that is what makes a copula worth having.
        let history: Vec<f64> = {
            let mut v: Vec<f64> = (0..1000).map(|i| (i as f64 - 500.0) / 1000.0).collect();
            v.sort_by(|a, b| a.partial_cmp(b).unwrap());
            v
        };
        let normal: Vec<f64> = rows.iter().map(|r| normal_marginal(r[0], 0.0, 0.2)).collect();
        let empirical: Vec<f64> = rows.iter().map(|r| empirical_marginal(r[0], &history)).collect();
        // Both are monotone functions of the same uniform, so they move
        // together exactly.
        let rho = pearson(&normal, &empirical);
        assert!(rho > 0.97, "rho {rho}");
    }

    #[test]
    fn empirical_marginal_spans_the_sample() {
        let sorted = [1.0, 2.0, 4.0, 8.0];
        assert_eq!(empirical_marginal(0.0, &sorted), 1.0);
        assert_eq!(empirical_marginal(1.0, &sorted), 8.0);
        // Linear interpolation across n-1 intervals: u = 0.5 lands halfway
        // between the second and third order statistics, not on the median of
        // the sample. That is the right convention for a quantile function
        // built from order statistics, and it is worth writing down because
        // the other reading is the one that looks obvious.
        assert!((empirical_marginal(0.5, &sorted) - 3.0).abs() < 1e-12);
        assert!(empirical_marginal(0.4, &[]).is_nan());
        assert_eq!(empirical_marginal(0.4, &[7.0]), 7.0);
    }

    #[test]
    fn the_same_seed_gives_the_same_draw() {
        let factor = Factor::equicorrelated(4, 0.5).unwrap();
        let copula = TCopula::new(factor, 6.0);
        let mut a = vec![0.0; 4];
        let mut b = vec![0.0; 4];
        copula.sample(&mut a, &mut Rng::new(2026));
        copula.sample(&mut b, &mut Rng::new(2026));
        assert_eq!(a, b);
    }
}

