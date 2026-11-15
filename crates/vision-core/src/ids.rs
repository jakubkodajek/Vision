//! Id generation and validation for every user-influenced identifier (spec §2.1, §2.5).

use crate::ipc::{IpcError, IpcResult};

const BASE32: &[u8; 32] = b"abcdefghijklmnopqrstuvwxyz234567";

/// Generates `<prefix>` + 12 lowercase base32 characters from the OS random generator.
///
/// # Errors
/// Returns `internal` if the OS random generator fails.
pub fn generate(prefix: &str) -> IpcResult<String> {
    let mut bytes = [0u8; 8];
    getrandom::fill(&mut bytes)
        .map_err(|_| IpcError::internal("The system random generator is unavailable"))?;
    let mut bits = u64::from_le_bytes(bytes);
    let mut id = String::with_capacity(prefix.len() + 12);
    id.push_str(prefix);
    for _ in 0..12 {
        id.push(char::from(BASE32[(bits & 31) as usize]));
        bits >>= 5;
    }
    Ok(id)
}

fn is_generated(prefix: &str, s: &str) -> bool {
    s.strip_prefix(prefix).is_some_and(|rest| {
        rest.len() == 12
            && rest
                .bytes()
                .all(|b| b.is_ascii_lowercase() || (b'2'..=b'7').contains(&b))
    })
}

/// Validates a profile id (`^p_[a-z2-7]{12}$`).
///
/// # Errors
/// Returns `invalid_input` for anything else.
pub fn validate_profile_id(s: &str) -> IpcResult<()> {
    if is_generated("p_", s) {
        Ok(())
    } else {
        Err(IpcError::invalid_input("Invalid profile id"))
    }
}

/// Validates an MCP server id (`^m_[a-z2-7]{12}$`).
///
/// # Errors
/// Returns `invalid_input` for anything else.
pub fn validate_server_id(s: &str) -> IpcResult<()> {
    if is_generated("m_", s) {
        Ok(())
    } else {
        Err(IpcError::invalid_input("Invalid server id"))
    }
}

/// Returns whether `s` matches `^[a-z][a-z0-9_-]{0,31}$`.
#[must_use]
pub fn is_valid_tool_id(s: &str) -> bool {
    let b = s.as_bytes();
    !b.is_empty()
        && b.len() <= 32
        && b[0].is_ascii_lowercase()
        && b[1..]
            .iter()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || *c == b'_' || *c == b'-')
}

/// Validates a tool id.
///
/// # Errors
/// Returns `invalid_input` when `s` does not match `^[a-z][a-z0-9_-]{0,31}$`.
pub fn validate_tool_id(s: &str) -> IpcResult<()> {
    if is_valid_tool_id(s) {
        Ok(())
    } else {
        Err(IpcError::invalid_input(
            "Tool ids use 1 to 32 lowercase letters, digits, '-' or '_' and start with a letter",
        ))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn generated_ids_match_the_pattern_and_differ() {
        let a = generate("p_").unwrap();
        let b = generate("p_").unwrap();
        assert!(validate_profile_id(&a).is_ok(), "{a}");
        assert_ne!(a, b);
        assert!(validate_server_id(&generate("m_").unwrap()).is_ok());
    }

    #[test]
    fn profile_ids_reject_traversal_and_wrong_shapes() {
        for bad in [
            "",
            "p_",
            "../etc",
            "p_abcdefghijk1",
            "p_ABCDEFGHIJKL",
            "p_abcdefghijkl/",
            "m_abcdefghijkl",
        ] {
            assert!(validate_profile_id(bad).is_err(), "{bad}");
        }
        assert!(validate_profile_id("p_abcdefghij23").is_ok());
    }

    #[test]
    fn tool_ids_follow_the_spec_pattern() {
        for ok in [
            "a",
            "claude",
            "my-tool_2",
            "a234567890123456789012345678901",
        ] {
            assert!(is_valid_tool_id(ok), "{ok}");
        }
        for bad in [
            "",
            "1abc",
            "-a",
            "A",
            "a b",
            "a/b",
            "a.b",
            "a234567890123456789012345678901xx",
            "ä",
        ] {
            assert!(!is_valid_tool_id(bad), "{bad}");
        }
    }
}
