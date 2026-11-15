//! Redaction of key-like tokens in CLI and server output before it is shown or stored
//! (status `unknown` messages, warnings, MCP stderr lines, version labels).
//!
//! Recognised: `sk-…`, `ghp_…`, `gho_…`, `ghu_…`, `ghs_…`, `ghr_…`, `github_pat_…`,
//! `xox?-…` (Slack), `AKIA…` (AWS access key id), `AIza…` (Google API key), the token after
//! `Bearer`, and any run of 32 or more base64/hex characters that mixes letters and digits.
//! A recognised token is replaced by its prefix followed by `[redacted]`.

/// Replacement marker.
pub const REDACTED: &str = "[redacted]";

/// Characters that may be part of a token (`=` separates, so `key=<token>` is found).
fn is_token_char(c: char) -> bool {
    c.is_ascii_alphanumeric() || matches!(c, '_' | '-' | '+' | '/' | '.' | '*')
}

/// Prefixes of well-known credential formats, with the minimum length of what follows.
const PREFIXES: &[(&str, usize)] = &[
    ("github_pat_", 4),
    ("sk-", 4),
    ("ghp_", 4),
    ("gho_", 4),
    ("ghu_", 4),
    ("ghs_", 4),
    ("ghr_", 4),
    ("xoxa-", 4),
    ("xoxb-", 4),
    ("xoxp-", 4),
    ("xoxr-", 4),
    ("xoxs-", 4),
    ("xoxe-", 4),
    ("AKIA", 12),
    ("ASIA", 12),
    ("AIza", 16),
];

/// Returns the kept prefix if `token` is credential-like.
fn credential_prefix(token: &str) -> Option<&str> {
    for (p, min) in PREFIXES {
        if let Some(rest) = token.strip_prefix(p)
            && rest.chars().count() >= *min
        {
            return Some(p);
        }
    }
    // A long run of base64/hex characters mixing letters and digits (paths are excluded
    // because '/' separates their segments).
    for part in token.split(['/', '.']) {
        let core = part.trim_end_matches('=');
        if core.len() >= 32
            && core.chars().any(|c| c.is_ascii_digit())
            && core.chars().any(|c| c.is_ascii_alphabetic())
            && core
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '_'))
        {
            return Some("");
        }
    }
    None
}

/// Redacts credential-like tokens in `text`.
#[must_use]
pub fn redact(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut token = String::new();
    let mut after_bearer = false;
    let flush = |token: &mut String, out: &mut String, after_bearer: &mut bool| {
        if token.is_empty() {
            return;
        }
        if *after_bearer {
            out.push_str(REDACTED);
            *after_bearer = false;
        } else if let Some(p) = credential_prefix(token) {
            out.push_str(p);
            out.push_str(REDACTED);
        } else {
            if token.eq_ignore_ascii_case("bearer") {
                *after_bearer = true;
            }
            out.push_str(token);
        }
        token.clear();
    };
    for c in text.chars() {
        if is_token_char(c) {
            token.push(c);
        } else {
            let was_bearer = token.eq_ignore_ascii_case("bearer");
            flush(&mut token, &mut out, &mut after_bearer);
            // `Bearer` applies only to the next word on the same run of spaces.
            if !(was_bearer && c == ' ') && !c.is_whitespace() {
                after_bearer = false;
            }
            out.push(c);
        }
    }
    flush(&mut token, &mut out, &mut after_bearer);
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_prefixes_are_redacted_keeping_the_prefix() {
        assert_eq!(
            redact("Error: invalid API key sk-proj-AbCd1234 given"),
            "Error: invalid API key sk-[redacted] given"
        );
        assert_eq!(redact("token ghp_abcdEFGH1234"), "token ghp_[redacted]");
        assert_eq!(redact("github_pat_11ABCDEFG0123"), "github_pat_[redacted]");
        assert_eq!(redact("xoxb-1234-5678"), "xoxb-[redacted]");
        assert_eq!(redact("id AKIAIOSFODNN7EXAMPLE"), "id AKIA[redacted]");
        assert_eq!(
            redact("key=AIzaSyA1234567890abcdefgh"),
            "key=AIza[redacted]"
        );
    }

    #[test]
    fn bearer_tokens_are_redacted() {
        assert_eq!(
            redact("Authorization: Bearer abc.def-ghi"),
            "Authorization: Bearer [redacted]"
        );
    }

    #[test]
    fn long_mixed_runs_are_redacted_but_paths_and_words_are_not() {
        assert_eq!(
            redact("secret 0123456789abcdef0123456789abcdef01"),
            "secret [redacted]"
        );
        let path = "/home/someone/.config/a-very-long-directory-name-without-digits/x";
        assert_eq!(redact(path), path);
        assert_eq!(redact("Not logged in"), "Not logged in");
        assert_eq!(redact("version 2.1.325"), "version 2.1.325");
    }
}
