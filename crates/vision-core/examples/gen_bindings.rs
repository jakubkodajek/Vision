//! Writes the TypeScript IPC bindings (`src/ipc/bindings.ts`) generated from the Rust types.
//!
//! Usage: `cargo run -p vision-core --example gen_bindings -- <output path>`
//! (`make bindings` regenerates the committed file; `make lint` checks it is current).

use std::process::ExitCode;

fn main() -> ExitCode {
    let Some(out) = std::env::args_os().nth(1) else {
        eprintln!("usage: gen_bindings <output path>");
        return ExitCode::from(2);
    };
    match std::fs::write(&out, vision_core::ipc::typescript_bindings()) {
        Ok(()) => ExitCode::SUCCESS,
        Err(e) => {
            eprintln!("could not write {}: {e}", out.to_string_lossy());
            ExitCode::FAILURE
        }
    }
}
