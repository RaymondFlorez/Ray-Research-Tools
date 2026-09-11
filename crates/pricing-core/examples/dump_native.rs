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
    let cells = ffi::pc_grid_reprice(100.0, 0.045, 0.017, 25, 0.2, 15, 0.1, 7.0);
    let stride = ffi::pc_grid_stride() as usize;
    let data = unsafe { std::slice::from_raw_parts(ffi::pc_grid_data(), cells as usize * stride) };
    for (i, value) in data.iter().enumerate() {
        emit(format!("cell{}/{}", i / stride, i % stride), *value);
    }
    for which in 0..5 {
        emit(format!("guard{which}"), ffi::pc_guard_value(which));
    }

    println!("{}", rows.join("\n"));
}
