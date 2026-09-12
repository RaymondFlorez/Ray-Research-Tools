//! Dumps native results for the WASM parity check, as raw f64 bit patterns.
//!
//! Bits, not decimals: the claim is bit-identical, and a decimal round trip
//! would hide exactly the last-digit disagreement the check exists to find.

use pricing_core::ffi;

fn main() {
    let mut rows: Vec<String> = Vec::new();
    let mut emit = |label: String, value: f64| {
        rows.push(format!("{}\t{:016x}", label, value.to_bits()));
    };

    for &x in &[-8.0, -6.0, -3.0, -1.0, -0.25, 0.0, 0.25, 1.0, 3.0, 6.0, 8.0] {
        emit(format!("norm_cdf({x})"), ffi::pc_norm_cdf(x));
    }

    for &is_call in &[1, 0] {
        for &m in &[0.7, 0.85, 1.0, 1.15, 1.3] {
            for &t in &[0.02, 0.25, 1.0, 2.0] {
                for &v in &[0.12, 0.3, 0.75] {
                    let (s, k, r, q) = (100.0, 100.0 * m, 0.045, 0.017);
                    let tag = format!("{is_call}/{m}/{t}/{v}");
                    for which in 0..10 {
                        emit(
                            format!("greek{which}({tag})"),
                            ffi::pc_greek(s, k, t, r, q, v, is_call, which),
                        );
                    }
                    emit(format!("fast({tag})"), ffi::pc_american_fast(s, k, t, r, q, v, is_call));
                    emit(format!("exact({tag})"), ffi::pc_american_exact(s, k, t, r, q, v, is_call));

                    let price = ffi::pc_price(s, k, t, r, q, v, is_call);
                    emit(format!("iv({tag})"), ffi::pc_implied_vol(s, k, t, r, q, price, is_call));
                }
            }
        }
    }

    // The grid path, driven through the same FFI the browser uses. Scalar
    // parity does not imply grid parity: the grid accumulates across legs and
    // cells, so a last-bit disagreement anywhere compounds into the number an
    // analyst actually reads.
    ffi::pc_book_reset();
    for i in 0..40 {
        ffi::pc_book_add_leg(
            80.0 + (i % 20) as f64 * 2.5,
            0.08 + (i % 5) as f64 * 0.24,
            if i % 2 == 0 { 1 } else { 0 },
            // American on both parities: an American call with q < r has no
            // early-exercise value, so a book of them never reaches the
            // lattice and the escalated path goes unchecked.
            if i % 4 < 2 { 1 } else { 0 },
            if i % 3 == 0 { -5.0 } else { 5.0 },
            100.0,
            0.22 + (i % 7) as f64 * 0.02,
        );
    }
    let cells = ffi::pc_grid_reprice(100.0, 0.045, 0.017, 25, 0.2, 15, 0.1, 7.0, 1);
    let stride = ffi::pc_grid_stride() as usize;
    let data = unsafe { std::slice::from_raw_parts(ffi::pc_grid_data(), cells as usize * stride) };
    for (i, value) in data.iter().enumerate() {
        emit(format!("cell{}/{}", i / stride, i % stride), *value);
    }
    for which in 0..5 {
        emit(format!("guard{which}"), ffi::pc_guard_value(which));
    }

    // Curves. The bootstrap is a bracketed solve that runs to the last
    // representable bit, so a single differing bit in the objective would send
    // the two targets to different pins — which makes this the sharpest test of
    // bit-identity in the crate.
    ffi::pc_curve_reset();
    ffi::pc_curve_add_deposit(0.0833, 0.0533);
    ffi::pc_curve_add_deposit(0.25, 0.0528);
    ffi::pc_curve_add_deposit(0.5, 0.0515);
    ffi::pc_curve_add_future(0.5, 0.75, 0.0496, 0.4);
    ffi::pc_curve_add_future(0.75, 1.0, 0.0471, 0.7);
    for (maturity, rate) in [
        (2.0, 0.0428),
        (3.0, 0.0401),
        (5.0, 0.0388),
        (7.0, 0.0387),
        (10.0, 0.0392),
        (20.0, 0.0407),
        (30.0, 0.0396),
    ] {
        ffi::pc_curve_add_swap(maturity, rate, 2.0);
    }
    emit("curve_pins".to_string(), ffi::pc_curve_bootstrap() as f64);
    for step in 0..=80 {
        let t = 0.25 + step as f64 * 0.5;
        emit(format!("curve_zero({t})"), ffi::pc_curve_zero(t));
        emit(format!("curve_df({t})"), ffi::pc_curve_discount(t));
        emit(format!("curve_fwd({t})"), ffi::pc_curve_forward(t, t + 0.5));
    }
    for index in 0..12 {
        emit(format!("curve_resid({index})"), ffi::pc_curve_residual(index));
    }

    // The same curve, rotated and shifted.
    for (shape, bps, pivot) in [(0, 50.0, 0.0), (1, 40.0, 2.0), (2, 25.0, 5.0), (3, 30.0, 5.0)] {
        ffi::pc_curve_bootstrap();
        ffi::pc_curve_shock(shape, bps, pivot);
        for step in 0..=12 {
            let t = 0.25 + step as f64 * 2.5;
            emit(format!("shock{shape}_zero({t})"), ffi::pc_curve_zero(t));
        }
    }

    // Nelson-Siegel-Svensson: a grid search over two decay times, so every
    // candidate has to score identically on both targets or the search lands
    // somewhere else entirely.
    ffi::pc_nss_reset();
    for (tenor, zero) in [
        (0.25, 0.0521),
        (0.5, 0.0508),
        (1.0, 0.0472),
        (2.0, 0.0428),
        (3.0, 0.0404),
        (5.0, 0.0389),
        (7.0, 0.0388),
        (10.0, 0.0394),
        (20.0, 0.0412),
        (30.0, 0.0399),
    ] {
        ffi::pc_nss_observe(tenor, zero);
    }
    emit("nss_status".to_string(), ffi::pc_nss_fit() as f64);
    for which in 0..6 {
        emit(format!("nss_param({which})"), ffi::pc_nss_param(which));
    }
    for which in 0..3 {
        emit(format!("nss_stat({which})"), ffi::pc_nss_stat(which));
    }
    for step in 0..=20 {
        let t = 0.25 + step as f64 * 1.5;
        emit(format!("nss_zero({t})"), ffi::pc_nss_zero(t));
    }
    for index in 0..10 {
        emit(format!("nss_resid({index})"), ffi::pc_nss_residual(index));
    }

    // Bond analytics and OAS. The lattice is a backward induction over a tree
    // fitted by forward induction, so a single bit out of place anywhere
    // propagates through every node of both passes.
    ffi::pc_curve_bootstrap();
    ffi::pc_bond_reset();
    for i in 1..=20 {
        let t = 0.5 * i as f64;
        ffi::pc_bond_add_flow(t, if i == 20 { 102.0 } else { 2.0 });
    }
    for (which, label) in
        [(0, "ytm"), (1, "macaulay"), (2, "modified"), (3, "convexity"), (4, "dv01")]
    {
        for &price in &[92.0, 100.0, 107.5] {
            emit(format!("bond_{label}({price})"), ffi::pc_bond_metric(which, price, 2.0));
        }
    }
    for &price in &[92.0, 100.0, 107.5] {
        emit(format!("bond_z({price})"), ffi::pc_bond_z_spread(price));
        emit(format!("bond_asw({price})"), ffi::pc_bond_asset_swap(price, 2.0, 100.0));
        emit(format!("bond_pay({price})"), ffi::pc_bond_price_at_yield(price / 2000.0, 2.0));
    }

    emit("hw_steps".to_string(), ffi::pc_hw_calibrate(0.05, 0.011, 0.5, 20) as f64);
    for step in 1..=20 {
        emit(format!("hw_zc({step})"), ffi::pc_hw_zero_coupon(step));
    }
    for (call_from, call_price) in [(-1, 0.0), (6, 100.0), (4, 102.0)] {
        emit(
            format!("hw_price({call_from})"),
            ffi::pc_hw_bond_price(2.0, 100.0, 20, call_from, call_price, 0.008),
        );
        emit(
            format!("hw_oas({call_from})"),
            ffi::pc_hw_oas(2.0, 100.0, 20, call_from, call_price, 96.5),
        );
        emit(
            format!("hw_opt({call_from})"),
            ffi::pc_hw_option_value(2.0, 100.0, 20, call_from, call_price, 0.008),
        );
    }

    println!("{}", rows.join("\n"));
}
