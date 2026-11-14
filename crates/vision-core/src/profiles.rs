//! Profiles and app settings in `app.db` (spec §2.3, F-010).

use rusqlite::{Connection, OptionalExtension, params};

use crate::ipc::{Accent, IpcError, IpcResult, Profile, ProfileKind};

/// Setting key of the active profile id.
pub const ACTIVE_PROFILE_KEY: &str = "active_profile_id";

/// Validates and normalises a profile name: trimmed, 1 to 40 characters, no control
/// characters.
///
/// # Errors
/// `invalid_input` otherwise.
pub fn normalize_name(name: &str) -> IpcResult<String> {
    let n = name.trim();
    let len = n.chars().count();
    if len == 0 || len > 40 {
        return Err(IpcError::invalid_input(
            "Profile names must be 1 to 40 characters",
        ));
    }
    if n.chars().any(char::is_control) {
        return Err(IpcError::invalid_input(
            "Profile names cannot contain control characters",
        ));
    }
    Ok(n.to_owned())
}

/// Case-insensitive uniqueness key of a name.
#[must_use]
pub fn name_key(name: &str) -> String {
    name.to_lowercase()
}

fn kind_str(k: ProfileKind) -> &'static str {
    match k {
        ProfileKind::Work => "work",
        ProfileKind::Personal => "personal",
        ProfileKind::Other => "other",
    }
}

fn kind_from(s: &str) -> ProfileKind {
    match s {
        "work" => ProfileKind::Work,
        "personal" => ProfileKind::Personal,
        _ => ProfileKind::Other,
    }
}

fn accent_str(a: Accent) -> &'static str {
    match a {
        Accent::Iris => "iris",
        Accent::Teal => "teal",
        Accent::Amber => "amber",
        Accent::Rose => "rose",
        Accent::Green => "green",
    }
}

fn accent_from(s: &str) -> Accent {
    match s {
        "teal" => Accent::Teal,
        "amber" => Accent::Amber,
        "rose" => Accent::Rose,
        "green" => Accent::Green,
        _ => Accent::Iris,
    }
}

fn row_to_profile(r: &rusqlite::Row<'_>) -> rusqlite::Result<Profile> {
    Ok(Profile {
        id: r.get(0)?,
        name: r.get(1)?,
        kind: kind_from(&r.get::<_, String>(2)?),
        accent: accent_from(&r.get::<_, String>(3)?),
        created_at: r.get(4)?,
    })
}

/// All profiles, oldest first.
///
/// # Errors
/// Database errors.
pub fn list(conn: &Connection) -> IpcResult<Vec<Profile>> {
    let mut st = conn.prepare(
        "SELECT id, name, kind, accent, created_at FROM profiles ORDER BY created_at, rowid",
    )?;
    let rows = st.query_map([], row_to_profile)?;
    Ok(rows.collect::<Result<_, _>>()?)
}

/// One profile.
///
/// # Errors
/// `not_found` when absent.
pub fn get(conn: &Connection, id: &str) -> IpcResult<Profile> {
    conn.query_row(
        "SELECT id, name, kind, accent, created_at FROM profiles WHERE id = ?1",
        [id],
        row_to_profile,
    )
    .optional()?
    .ok_or_else(|| IpcError::not_found("Profile not found"))
}

fn name_taken(conn: &Connection, key: &str, except: Option<&str>) -> IpcResult<bool> {
    let found: Option<String> = conn
        .query_row("SELECT id FROM profiles WHERE name_key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?;
    Ok(found.is_some_and(|id| Some(id.as_str()) != except))
}

/// Inserts a profile row.
///
/// # Errors
/// `conflict` for a duplicate name.
pub fn insert(conn: &Connection, p: &Profile) -> IpcResult<()> {
    let key = name_key(&p.name);
    if name_taken(conn, &key, None)? {
        return Err(IpcError::conflict(
            "A profile with this name already exists",
        ));
    }
    conn.execute(
        "INSERT INTO profiles (id, name, name_key, kind, accent, created_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        params![p.id, p.name, key, kind_str(p.kind), accent_str(p.accent), p.created_at],
    )?;
    Ok(())
}

/// Updates name, kind and accent.
///
/// # Errors
/// `conflict` for a duplicate name, `not_found` when absent.
pub fn update(conn: &Connection, p: &Profile) -> IpcResult<()> {
    let key = name_key(&p.name);
    if name_taken(conn, &key, Some(&p.id))? {
        return Err(IpcError::conflict(
            "A profile with this name already exists",
        ));
    }
    let n = conn.execute(
        "UPDATE profiles SET name = ?2, name_key = ?3, kind = ?4, accent = ?5 WHERE id = ?1",
        params![p.id, p.name, key, kind_str(p.kind), accent_str(p.accent)],
    )?;
    if n == 0 {
        return Err(IpcError::not_found("Profile not found"));
    }
    Ok(())
}

/// Deletes a profile row.
///
/// # Errors
/// Database errors.
pub fn delete(conn: &Connection, id: &str) -> IpcResult<()> {
    conn.execute("DELETE FROM profiles WHERE id = ?1", [id])?;
    Ok(())
}

/// Reads a setting.
///
/// # Errors
/// Database errors.
pub fn get_setting(conn: &Connection, key: &str) -> IpcResult<Option<String>> {
    Ok(conn
        .query_row("SELECT value FROM settings WHERE key = ?1", [key], |r| {
            r.get(0)
        })
        .optional()?)
}

/// Writes (or with `None` removes) a setting.
///
/// # Errors
/// Database errors.
pub fn set_setting(conn: &Connection, key: &str, value: Option<&str>) -> IpcResult<()> {
    match value {
        Some(v) => conn.execute(
            "INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
            params![key, v],
        )?,
        None => conn.execute("DELETE FROM settings WHERE key = ?1", [key])?,
    };
    Ok(())
}
