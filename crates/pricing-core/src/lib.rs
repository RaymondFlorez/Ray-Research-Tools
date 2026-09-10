//! Picasso pricing core (PRD 2.2, 5.4).
//!
//! "Black-Scholes, binomial American exercise, SABR/SVI fits, and curve
//! bootstraps must run in the sub-millisecond range and must produce
//! bit-identical results on client and server. One codebase, two targets."
//!
//! Hence: no dependencies. Every crate added here is a thing that has to work
//! identically in a native service and in WASM in a browser, and the arithmetic
//! this crate does is arithmetic the standard library already has.

pub mod american;
pub mod ffi;
pub mod bsm;
pub mod grid;
pub mod implied;
pub mod normal;

pub use bsm::{Greeks, Inputs, OptionType};
