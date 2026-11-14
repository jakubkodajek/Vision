//! Hygiene for user-typed display text (profile names, custom tool names and descriptions):
//! NFC normalisation, no control or format (bidi, zero-width) characters, at least one
//! visible character, lengths counted in `char`s after normalisation, and a uniqueness key.

use unicode_normalization::UnicodeNormalization;
use unicode_normalization::char::is_combining_mark;

use crate::ipc::{IpcError, IpcResult};

/// Unicode general category Cf (format characters) as of Unicode 16, plus the
/// interlinear annotation and tag ranges. These include the bidi controls
/// (U+202A..U+202E, U+2066..U+2069), zero-width characters (U+200B..U+200F, U+2060..U+2064)
/// and the BOM (U+FEFF), which can make two names look identical or reorder text.
const FORMAT_RANGES: &[(u32, u32)] = &[
    (0x00AD, 0x00AD),
    (0x0600, 0x0605),
    (0x061C, 0x061C),
    (0x06DD, 0x06DD),
    (0x070F, 0x070F),
    (0x0890, 0x0891),
    (0x08E2, 0x08E2),
    (0x180E, 0x180E),
    (0x200B, 0x200F),
    (0x202A, 0x202E),
    (0x2060, 0x2064),
    (0x2066, 0x206F),
    (0xFEFF, 0xFEFF),
    (0xFFF9, 0xFFFB),
    (0x110BD, 0x110BD),
    (0x110CD, 0x110CD),
    (0x13430, 0x1343F),
    (0x1BCA0, 0x1BCA3),
    (0x1D173, 0x1D17A),
    (0xE0001, 0xE0001),
    (0xE0020, 0xE007F),
];

/// Letters that render as blank space although they are not in category Z or Cf.
const BLANK_LETTERS: &[u32] = &[0x115F, 0x1160, 0x3164, 0xFFA0, 0x2800];

/// Returns whether `c` is a format character (category Cf).
#[must_use]
pub fn is_format(c: char) -> bool {
    let u = u32::from(c);
    FORMAT_RANGES.iter().any(|(a, b)| (*a..=*b).contains(&u))
}

/// Returns whether `c` draws something on its own: not whitespace, control, format,
/// combining mark, variation selector or a blank letter.
#[must_use]
pub fn is_visible(c: char) -> bool {
    !(c.is_whitespace()
        || c.is_control()
        || is_format(c)
        || is_combining_mark(c)
        || BLANK_LETTERS.contains(&u32::from(c))
        || ('\u{FE00}'..='\u{FE0F}').contains(&c))
}

/// Normalises and validates display text: trimmed, NFC, 1 to `max` characters after
/// normalisation, no control or format characters, at least one visible character.
///
/// # Errors
/// `invalid_input` mentioning `label` otherwise.
pub fn display_text(label: &str, s: &str, max: usize) -> IpcResult<String> {
    let n: String = s.trim().nfc().collect();
    let len = n.chars().count();
    if len == 0 || len > max {
        return Err(IpcError::invalid_input(format!(
            "{label} must be 1 to {max} characters"
        )));
    }
    if n.chars().any(|c| c.is_control() || is_format(c)) {
        return Err(IpcError::invalid_input(format!(
            "{label} cannot contain control, zero-width or text-direction characters"
        )));
    }
    if !n.chars().any(is_visible) {
        return Err(IpcError::invalid_input(format!(
            "{label} needs at least one visible character"
        )));
    }
    Ok(n)
}

/// Uniqueness key: NFKC (so compatibility forms such as full-width letters match) followed
/// by Unicode lower-casing (`str::to_lowercase`). This is not full case folding, but it makes
/// `Café` (NFC) and `Cafe\u{301}` (NFD), and `WORK` and `work`, the same name.
#[must_use]
pub fn name_key(s: &str) -> String {
    s.nfkc().collect::<String>().to_lowercase()
}

/// NFC form of `s` (for comparing a typed confirmation with a stored name).
#[must_use]
pub fn nfc(s: &str) -> String {
    s.nfc().collect()
}

/// Renders untrusted text for a confirmation dialog: control, format and other invisible
/// characters become `\u{…}` escapes so they cannot hide or reorder what is shown, and the
/// result is cut at `max` characters.
#[must_use]
pub fn make_visible(s: &str, max: usize) -> String {
    let mut out = String::new();
    for (i, c) in s.chars().enumerate() {
        if i >= max {
            out.push('…');
            break;
        }
        if c == ' ' || (!c.is_whitespace() && is_visible(c)) || (is_combining_mark(c) && i > 0) {
            out.push(c);
        } else {
            out.push_str(&format!("\\u{{{:x}}}", u32::from(c)));
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn nfd_input_is_stored_as_nfc() {
        assert_eq!(display_text("n", "Cafe\u{301}", 40).unwrap(), "Caf\u{e9}");
    }

    #[test]
    fn invisible_only_text_is_rejected() {
        for bad in ["\u{301}", "\u{3164}", "\u{fe0f}"] {
            assert!(display_text("n", bad, 40).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn format_characters_are_rejected() {
        for bad in ["Work\u{200b}", "\u{202e}kroW", "a\u{2066}b", "\u{feff}x"] {
            assert!(display_text("n", bad, 40).is_err(), "{bad:?}");
        }
    }

    #[test]
    fn key_matches_case_and_normalisation_variants() {
        assert_eq!(name_key("Caf\u{e9}"), name_key("CAFE\u{301}"));
        assert_eq!(name_key("\u{ff37}ork"), name_key("work"));
    }

    #[test]
    fn make_visible_escapes_bidi_and_controls() {
        assert_eq!(make_visible("a\u{202e}b\nc", 50), "a\\u{202e}b\\u{a}c");
        assert_eq!(make_visible("abcdef", 3), "abc…");
    }
}
