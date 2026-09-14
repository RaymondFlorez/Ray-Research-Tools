//! Deterministic random and quasi-random sequences (PRD 5.8).
//!
//! Everything here is integer arithmetic until the last step, which is the only
//! way a Monte Carlo can satisfy the crate's bit-identity requirement: a
//! floating-point generator can differ in its last bit between targets and then
//! diverge completely, because the next draw depends on the last.
//!
//! Uniforms become normals through `normal::inv_cdf` rather than Box-Muller.
//! Box-Muller consumes two uniforms to make two normals and pairs them by
//! rotation, which destroys the one property quasi-random sequences are for —
//! the *i*th coordinate of a Sobol point has to become the *i*th normal, or the
//! stratification it was built with is thrown away.

use crate::normal;

/// SplitMix64. Small, fast, and identical on every target.
#[derive(Clone, Copy, Debug)]
pub struct Rng {
    state: u64,
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        Rng { state: seed }
    }

    pub fn next_u64(&mut self) -> u64 {
        self.state = self.state.wrapping_add(0x9E37_79B9_7F4A_7C15);
        let mut z = self.state;
        z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
        z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
        z ^ (z >> 31)
    }

    /// Uniform on the open interval, never returning 0 or 1.
    ///
    /// Open, not half-open: `inv_cdf(0)` is negative infinity, and a single
    /// infinite draw poisons a whole path. Shifting into `(0, 1)` costs one ulp
    /// of range and removes the failure entirely.
    pub fn next_uniform(&mut self) -> f64 {
        let bits = self.next_u64() >> 11;
        ((bits as f64) + 0.5) * (1.0 / 9_007_199_254_740_992.0)
    }

    pub fn next_normal(&mut self) -> f64 {
        normal::inv_cdf(self.next_uniform())
    }
}

/// Largest Sobol dimension this table supports.
pub const MAX_SOBOL_DIMENSIONS: usize = 16;

/// Bits of resolution: the sequence repeats after 2^32 points.
const SOBOL_BITS: u32 = 32;

/// Primitive polynomials (as bit patterns of the inner coefficients) and the
/// initial direction numbers for the first sixteen dimensions.
///
/// The standard Joe-Kuo table. Dimension zero is the van der Corput sequence
/// and needs neither.
const SOBOL_POLYNOMIALS: [(u32, u32, &[u32]); MAX_SOBOL_DIMENSIONS - 1] = [
    (1, 0, &[1]),
    (2, 1, &[1, 3]),
    (3, 1, &[1, 3, 1]),
    (3, 2, &[1, 1, 1]),
    (4, 1, &[1, 1, 3, 3]),
    (4, 4, &[1, 3, 5, 13]),
    (5, 2, &[1, 1, 5, 5, 17]),
    (5, 4, &[1, 1, 5, 5, 5]),
    (5, 7, &[1, 1, 7, 11, 19]),
    (5, 11, &[1, 1, 5, 1, 1]),
    (5, 13, &[1, 1, 1, 3, 11]),
    (5, 14, &[1, 3, 5, 5, 31]),
    (6, 1, &[1, 3, 3, 9, 7, 49]),
    (6, 13, &[1, 1, 1, 15, 21, 21]),
    (6, 16, &[1, 3, 1, 13, 27, 49]),
];

/// A Sobol low-discrepancy sequence.
///
/// PRD 5.8 asks for "quasi-random Sobol sequences with Brownian bridge
/// construction". The point is that Sobol points are *stratified*: the first
/// 2^k of them put exactly one point in every elementary interval of that
/// resolution, so a integral converges at close to 1/N instead of 1/sqrt(N).
/// `test::fills_every_stratum` checks that property directly rather than
/// comparing against a table of published values.
#[derive(Clone, Debug)]
pub struct Sobol {
    dimensions: usize,
    /// `direction[d][bit]`, already shifted into place.
    direction: Vec<[u32; SOBOL_BITS as usize]>,
    /// Running Gray-code state per dimension.
    current: Vec<u32>,
    index: u32,
}

impl Sobol {
    pub fn new(dimensions: usize) -> Sobol {
        let dimensions = dimensions.clamp(1, MAX_SOBOL_DIMENSIONS);
        let mut direction = Vec::with_capacity(dimensions);

        // Dimension zero: v_i = 2^(31-i), the van der Corput sequence.
        let mut first = [0u32; SOBOL_BITS as usize];
        for (i, value) in first.iter_mut().enumerate() {
            *value = 1u32 << (SOBOL_BITS - 1 - i as u32);
        }
        direction.push(first);

        for d in 1..dimensions {
            let (degree, coefficients, initial) = SOBOL_POLYNOMIALS[d - 1];
            let degree = degree as usize;
            let mut v = [0u32; SOBOL_BITS as usize];

            // The seeded directions, scaled into the top bits.
            for i in 0..degree.min(SOBOL_BITS as usize) {
                v[i] = initial[i] << (SOBOL_BITS - 1 - i as u32);
            }
            // The recurrence, which is the polynomial's whole content.
            for i in degree..SOBOL_BITS as usize {
                let mut value = v[i - degree] ^ (v[i - degree] >> degree as u32);
                for k in 1..degree {
                    if (coefficients >> (degree - 1 - k)) & 1 == 1 {
                        value ^= v[i - k];
                    }
                }
                v[i] = value;
            }
            direction.push(v);
        }

        Sobol { dimensions, direction, current: vec![0; dimensions], index: 0 }
    }

    pub fn dimensions(&self) -> usize {
        self.dimensions
    }

    /// The next point, written into `out`.
    ///
    /// Gray-code order: successive points differ in one direction number, so
    /// each step is a single XOR per dimension rather than a rebuild.
    ///
    /// The origin is emitted, not skipped. Skipping it is a common shortcut —
    /// it maps to zero, and zero through the inverse normal is negative
    /// infinity — but it also breaks the property the sequence exists for: the
    /// stratification holds over points `x_0 .. x_{2^k - 1}`, and dropping the
    /// first one leaves a duplicated stratum at every power of two. The
    /// half-ulp offset below already keeps the value off zero, so there is
    /// nothing left to skip for.
    pub fn next_point(&mut self, out: &mut [f64]) {
        for d in 0..self.dimensions.min(out.len()) {
            // Shifted off the closed interval for the same reason as `next_uniform`.
            out[d] = ((self.current[d] as f64) + 0.5) * (1.0 / 4_294_967_296.0);
        }
        let bit = (self.index.trailing_ones() as usize).min(SOBOL_BITS as usize - 1);
        self.index = self.index.wrapping_add(1);
        for d in 0..self.dimensions {
            self.current[d] ^= self.direction[d][bit];
        }
    }

    /// The next point as standard normals.
    pub fn next_normals(&mut self, out: &mut [f64]) {
        self.next_point(out);
        for value in out.iter_mut().take(self.dimensions) {
            *value = normal::inv_cdf(*value);
        }
    }
}

/// Brownian bridge construction (PRD 5.8).
///
/// A Brownian path can be built forwards, one increment at a time, or by
/// bisection: fix the endpoint first, then the midpoint, then the quarters.
/// Both give the same distribution and they are not equally useful with a
/// quasi-random sequence.
///
/// Sobol's early dimensions are far better distributed than its late ones, and
/// the bridge spends them where they matter. Almost all the variance of a
/// path-dependent payoff lives in the terminal value and the coarse shape, so
/// building those from dimensions 0, 1, 2 and the fine detail from dimension 40
/// concentrates the sequence's quality on the part of the problem that has it.
#[derive(Clone, Debug)]
pub struct BrownianBridge {
    steps: usize,
    /// Order in which time points are filled.
    order: Vec<usize>,
    left: Vec<usize>,
    right: Vec<usize>,
    left_weight: Vec<f64>,
    right_weight: Vec<f64>,
    stdev: Vec<f64>,
}

impl BrownianBridge {
    pub fn new(steps: usize) -> BrownianBridge {
        let steps = steps.max(1);
        let mut bridge = BrownianBridge {
            steps,
            order: Vec::with_capacity(steps),
            left: vec![0; steps],
            right: vec![0; steps],
            left_weight: vec![0.0; steps],
            right_weight: vec![0.0; steps],
            stdev: vec![0.0; steps],
        };

        // The terminal point first: it carries the most variance, so it gets
        // the best dimension.
        let mut filled = vec![false; steps];
        bridge.order.push(steps - 1);
        filled[steps - 1] = true;
        bridge.left[0] = usize::MAX;
        bridge.right[0] = steps - 1;
        bridge.stdev[0] = libm::sqrt(steps as f64);

        // Then bisect, always splitting the widest unfilled gap.
        for k in 1..steps {
            let (mut best_from, mut best_to, mut best_width) = (0usize, 0usize, 0usize);
            let mut start = 0usize;
            for (i, &done) in filled.iter().enumerate() {
                if done {
                    if i > start && i - start > best_width {
                        best_width = i - start;
                        best_from = start;
                        best_to = i;
                    }
                    start = i + 1;
                }
            }
            if best_width == 0 {
                // Everything to the right of the last filled point.
                break;
            }
            let middle = best_from + (best_to - best_from - 1) / 2;
            filled[middle] = true;
            bridge.order.push(middle);

            let left_index = if best_from == 0 { usize::MAX } else { best_from - 1 };
            let left_time = if best_from == 0 { 0.0 } else { best_from as f64 };
            let right_time = (best_to + 1) as f64;
            let middle_time = (middle + 1) as f64;

            bridge.left[k] = left_index;
            bridge.right[k] = best_to;
            bridge.left_weight[k] = (right_time - middle_time) / (right_time - left_time);
            bridge.right_weight[k] = (middle_time - left_time) / (right_time - left_time);
            bridge.stdev[k] = libm::sqrt(
                (middle_time - left_time) * (right_time - middle_time) / (right_time - left_time),
            );
        }

        bridge
    }

    pub fn steps(&self) -> usize {
        self.steps
    }

    /// Builds a Brownian path from `normals`, one per step.
    ///
    /// `path[i]` is the Brownian motion at time `i + 1`, in units where each
    /// step is one. Scale by `sqrt(dt)` for a real timescale.
    pub fn build(&self, normals: &[f64], path: &mut [f64]) {
        if self.steps == 0 || path.len() < self.steps {
            return;
        }
        for (k, &index) in self.order.iter().enumerate() {
            let noise = normals.get(k).copied().unwrap_or(0.0);
            let right_value = if self.right[k] == index { 0.0 } else { path[self.right[k]] };
            let left_value = if self.left[k] == usize::MAX { 0.0 } else { path[self.left[k]] };
            path[index] = if k == 0 {
                self.stdev[0] * noise
            } else {
                self.left_weight[k] * left_value
                    + self.right_weight[k] * right_value
                    + self.stdev[k] * noise
            };
        }
    }
}

#[cfg(test)]
mod test {
    use super::*;

    #[test]
    fn uniforms_stay_strictly_inside_the_interval() {
        let mut rng = Rng::new(12345);
        for _ in 0..200_000 {
            let u = rng.next_uniform();
            assert!(u > 0.0 && u < 1.0, "{u}");
        }
    }

    #[test]
    fn normals_have_the_moments_they_should() {
        let mut rng = Rng::new(7);
        let n = 400_000;
        let (mut sum, mut square) = (0.0f64, 0.0f64);
        for _ in 0..n {
            let z = rng.next_normal();
            assert!(z.is_finite());
            sum += z;
            square += z * z;
        }
        let mean = sum / n as f64;
        let variance = square / n as f64 - mean * mean;
        assert!(libm::fabs(mean) < 0.01, "mean {mean}");
        assert!(libm::fabs(variance - 1.0) < 0.01, "variance {variance}");
    }

    #[test]
    fn the_same_seed_is_the_same_stream() {
        let draw = |seed| {
            let mut rng = Rng::new(seed);
            (0..64).map(|_| rng.next_u64()).collect::<Vec<_>>()
        };
        assert_eq!(draw(99), draw(99));
        assert_ne!(draw(99), draw(100));
    }

    /// Sobol's defining property, checked directly rather than against a table
    /// of published values.
    ///
    /// The first 2^k points put *exactly one* point in each of the 2^k equal
    /// subintervals of every dimension. That is what low discrepancy means
    /// here, and a generator with a wrong direction number fails it
    /// immediately.
    #[test]
    fn fills_every_stratum() {
        for dimensions in [1usize, 2, 5, 16] {
            let mut sobol = Sobol::new(dimensions);
            let k = 8;
            let count = 1usize << k;
            let mut seen = vec![vec![false; count]; dimensions];
            let mut point = vec![0.0; dimensions];

            for _ in 0..count {
                sobol.next_point(&mut point);
                for (d, strata) in seen.iter_mut().enumerate() {
                    let bucket = ((point[d] * count as f64) as usize).min(count - 1);
                    assert!(
                        !strata[bucket],
                        "dimension {d} hit stratum {bucket} twice in {count} points",
                    );
                    strata[bucket] = true;
                }
            }
            for (d, strata) in seen.iter().enumerate() {
                assert!(strata.iter().all(|&hit| hit), "dimension {d} left a gap");
            }
        }
    }

    #[test]
    fn sobol_points_stay_inside_the_interval() {
        let mut sobol = Sobol::new(8);
        let mut point = vec![0.0; 8];
        for _ in 0..10_000 {
            sobol.next_point(&mut point);
            for value in &point {
                assert!(*value > 0.0 && *value < 1.0, "{value}");
            }
        }
    }

    /// The reason to use it: a smooth integral converges far faster than it
    /// does under pseudorandom sampling.
    #[test]
    fn beats_pseudorandom_on_a_smooth_integral() {
        // The mean of a product over the unit cube, which has a known answer.
        let dimensions = 4;
        let truth = libm::pow(0.5, dimensions as f64);
        let count = 4096;

        let mut sobol = Sobol::new(dimensions);
        let mut point = vec![0.0; dimensions];
        let mut quasi = 0.0;
        for _ in 0..count {
            sobol.next_point(&mut point);
            quasi += point.iter().product::<f64>();
        }
        let quasi_error = libm::fabs(quasi / count as f64 - truth);

        let mut rng = Rng::new(4242);
        let mut pseudo = 0.0;
        for _ in 0..count {
            let mut term = 1.0;
            for _ in 0..dimensions {
                term *= rng.next_uniform();
            }
            pseudo += term;
        }
        let pseudo_error = libm::fabs(pseudo / count as f64 - truth);

        assert!(
            quasi_error < pseudo_error,
            "sobol {quasi_error:e} should beat pseudorandom {pseudo_error:e}",
        );
    }

    #[test]
    fn the_bridge_reproduces_brownian_motion() {
        // Whatever order the points are filled in, the result has to be a
        // Brownian path: increments independent, each with unit variance.
        let steps = 16;
        let bridge = BrownianBridge::new(steps);
        let mut rng = Rng::new(31337);
        let n = 60_000;

        let mut increment_square = vec![0.0f64; steps];
        let mut terminal_square = 0.0f64;
        let mut normals = vec![0.0; steps];
        let mut path = vec![0.0; steps];

        for _ in 0..n {
            for value in normals.iter_mut() {
                *value = rng.next_normal();
            }
            bridge.build(&normals, &mut path);
            let mut previous = 0.0;
            for i in 0..steps {
                let increment = path[i] - previous;
                increment_square[i] += increment * increment;
                previous = path[i];
            }
            terminal_square += path[steps - 1] * path[steps - 1];
        }

        for (i, total) in increment_square.iter().enumerate() {
            let variance = total / n as f64;
            assert!(libm::fabs(variance - 1.0) < 0.05, "increment {i} variance {variance}");
        }
        // Var(W_T) = T, which is the whole point of getting the weights right.
        let terminal = terminal_square / n as f64;
        assert!(libm::fabs(terminal - steps as f64) < 0.5, "terminal variance {terminal}");
    }

    #[test]
    fn the_bridge_fills_the_terminal_point_first() {
        let bridge = BrownianBridge::new(8);
        assert_eq!(bridge.order[0], 7);
        assert_eq!(bridge.order.len(), 8);
        // Every time point exactly once.
        let mut sorted = bridge.order.clone();
        sorted.sort_unstable();
        assert_eq!(sorted, (0..8).collect::<Vec<_>>());
    }
}
