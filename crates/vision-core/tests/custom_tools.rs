//! AC7: custom tools reject invalid ids, binaries with path separators or shell
//! metacharacters, and non-https install URLs; valid ones are stored and usable.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use common::{Harness, create_profile};
use serde_json::json;
use vision_core::ipc::{
    ConfigEnvKind, CustomToolInput, CustomToolSaveArgs, ErrorCode, Isolation, ProfileScopeArgs,
    StatusParser, ToolArgs, ToolIdArgs, ToolStatus,
};

fn valid() -> CustomToolInput {
    CustomToolInput {
        id: "kubectl".into(),
        name: "kubectl".into(),
        description: Some("Kubernetes".into()),
        binary: "kubectl".into(),
        install_url: Some("https://kubernetes.io/docs/tasks/tools/".into()),
        config_var: "KUBECTL_CONFIG".into(),
        config_kind: ConfigEnvKind::File,
        login: vec!["config".into(), "view".into()],
        status: Some(vec!["config".into(), "current-context".into()]),
        logout: None,
    }
}

fn save_err(tool: CustomToolInput) -> ErrorCode {
    Harness::new()
        .core()
        .custom_tool_save(CustomToolSaveArgs {
            tool,
            replace: false,
        })
        .unwrap_err()
        .code
}

#[test]
fn valid_custom_tool_is_saved_as_unverified_exit_code_tool() {
    let v = Harness::new()
        .core()
        .custom_tool_save(CustomToolSaveArgs {
            tool: valid(),
            replace: false,
        })
        .unwrap();
    assert_eq!(
        (v.isolation, v.status_parser, v.builtin),
        (Isolation::Unverified, StatusParser::ExitCode, false)
    );
}

#[test]
fn id_with_uppercase_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            id: "Kube".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn id_with_path_traversal_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            id: "../x".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn id_starting_with_a_digit_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            id: "1tool".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn id_of_a_builtin_tool_conflicts() {
    assert_eq!(
        save_err(CustomToolInput {
            id: "claude".into(),
            ..valid()
        }),
        ErrorCode::Conflict
    );
}

#[test]
fn binary_with_a_slash_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            binary: "/usr/bin/kubectl".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn binary_with_a_backslash_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            binary: r"bin\kubectl".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn binary_with_a_semicolon_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            binary: "kubectl;rm".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn binary_with_command_substitution_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            binary: "$(id)".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn binary_with_a_space_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            binary: "kube ctl".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn binary_starting_with_a_dash_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            binary: "-kubectl".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn http_install_url_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            install_url: Some("http://example.com".into()),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn javascript_install_url_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            install_url: Some("javascript:alert(1)".into()),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn install_url_with_credentials_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            install_url: Some("https://u:p@example.com".into()),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn reserved_config_variable_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            config_var: "PATH".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn loader_config_variable_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            config_var: "LD_PRELOAD".into(),
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn empty_login_command_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            login: vec![],
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn argument_with_a_newline_is_rejected() {
    assert_eq!(
        save_err(CustomToolInput {
            login: vec!["a\nb".into()],
            ..valid()
        }),
        ErrorCode::InvalidInput
    );
}

#[test]
fn saved_custom_tool_appears_in_every_profiles_list_after_restart() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.custom_tool_save(CustomToolSaveArgs {
        tool: valid(),
        replace: false,
    })
    .unwrap();
    drop(core);
    let tools = h
        .core()
        .tools_list(ProfileScopeArgs { profile_id: p.id })
        .unwrap();
    assert!(tools.iter().any(|t| t.spec.id == "kubectl"));
}

#[test]
fn custom_tool_status_uses_its_exit_code_and_config_variable() {
    let h = Harness::new();
    let dump = h.path("env.txt");
    h.install_fake(
        "kubectl",
        json!({"dump_env": dump.to_str().unwrap(), "default": {"exit": 0}}),
    );
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.custom_tool_save(CustomToolSaveArgs {
        tool: valid(),
        replace: false,
    })
    .unwrap();
    let v = core
        .tool_check(ToolArgs {
            profile_id: p.id.clone(),
            tool_id: "kubectl".into(),
        })
        .unwrap();
    assert_eq!(
        v.status,
        Some(ToolStatus::SignedIn {
            account: None,
            warning: None
        })
    );
    let expected = core
        .data_root()
        .tool_dir(&p.id, "kubectl")
        .unwrap()
        .join("config");
    assert!(common::read(&dump).contains(&format!("KUBECTL_CONFIG={}", expected.display())));
}

#[test]
fn deleting_a_builtin_tool_is_rejected() {
    let err = Harness::new()
        .core()
        .custom_tool_delete(ToolIdArgs {
            tool_id: "gh".into(),
        })
        .unwrap_err();
    assert_eq!(err.code, ErrorCode::InvalidInput);
}

#[test]
fn deleting_a_custom_tool_removes_it() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    core.custom_tool_save(CustomToolSaveArgs {
        tool: valid(),
        replace: false,
    })
    .unwrap();
    core.custom_tool_delete(ToolIdArgs {
        tool_id: "kubectl".into(),
    })
    .unwrap();
    let tools = core
        .tools_list(ProfileScopeArgs { profile_id: p.id })
        .unwrap();
    assert!(!tools.iter().any(|t| t.spec.id == "kubectl"));
}

#[test]
fn install_page_opens_the_registry_url() {
    let h = Harness::new();
    h.core()
        .tool_open_install_page(ToolIdArgs {
            tool_id: "gh".into(),
        })
        .unwrap();
    assert_eq!(
        *h.opener.urls.lock().unwrap(),
        vec!["https://cli.github.com/".to_owned()]
    );
}

// ---- A1/A2: field attribution and add-versus-replace ----------------------------------------

fn save_field(tool: CustomToolInput) -> Option<String> {
    Harness::new()
        .core()
        .custom_tool_save(CustomToolSaveArgs {
            tool,
            replace: false,
        })
        .unwrap_err()
        .field
}

#[test]
fn an_invalid_id_names_the_id_field() {
    assert_eq!(
        save_field(CustomToolInput {
            id: "Kube".into(),
            ..valid()
        })
        .as_deref(),
        Some("id")
    );
}

#[test]
fn a_preset_id_names_the_id_field() {
    assert_eq!(
        save_field(CustomToolInput {
            id: "gh".into(),
            ..valid()
        })
        .as_deref(),
        Some("id")
    );
}

#[test]
fn an_empty_name_names_the_name_field() {
    assert_eq!(
        save_field(CustomToolInput {
            name: " ".into(),
            ..valid()
        })
        .as_deref(),
        Some("name")
    );
}

#[test]
fn a_binary_with_a_path_names_the_binary_field() {
    assert_eq!(
        save_field(CustomToolInput {
            binary: "/bin/x".into(),
            ..valid()
        })
        .as_deref(),
        Some("binary")
    );
}

#[test]
fn an_http_install_page_names_the_install_url_field() {
    assert_eq!(
        save_field(CustomToolInput {
            install_url: Some("http://example.com".into()),
            ..valid()
        })
        .as_deref(),
        Some("install_url")
    );
}

#[test]
fn an_empty_login_names_the_login_field() {
    assert_eq!(
        save_field(CustomToolInput {
            login: vec![],
            ..valid()
        })
        .as_deref(),
        Some("login")
    );
}

#[test]
fn a_bad_status_argument_names_the_status_field() {
    assert_eq!(
        save_field(CustomToolInput {
            status: Some(vec!["a\u{7}b".into()]),
            ..valid()
        })
        .as_deref(),
        Some("status")
    );
}

#[test]
fn a_bad_logout_argument_names_the_logout_field() {
    assert_eq!(
        save_field(CustomToolInput {
            logout: Some(vec![String::new()]),
            ..valid()
        })
        .as_deref(),
        Some("logout")
    );
}

#[test]
fn adding_an_existing_id_is_a_conflict_on_the_id_field() {
    let core = Harness::new().core();
    core.custom_tool_save(CustomToolSaveArgs {
        tool: valid(),
        replace: false,
    })
    .unwrap();
    let e = core
        .custom_tool_save(CustomToolSaveArgs {
            tool: valid(),
            replace: false,
        })
        .unwrap_err();
    assert_eq!(
        (e.code, e.field.as_deref()),
        (ErrorCode::Conflict, Some("id"))
    );
}

#[test]
fn replacing_an_existing_tool_updates_it() {
    let core = Harness::new().core();
    core.custom_tool_save(CustomToolSaveArgs {
        tool: valid(),
        replace: false,
    })
    .unwrap();
    let v = core
        .custom_tool_save(CustomToolSaveArgs {
            tool: CustomToolInput {
                name: "Kubernetes".into(),
                ..valid()
            },
            replace: true,
        })
        .unwrap();
    assert_eq!(v.name, "Kubernetes");
}

#[test]
fn replacing_a_missing_tool_is_not_found() {
    let e = Harness::new()
        .core()
        .custom_tool_save(CustomToolSaveArgs {
            tool: valid(),
            replace: true,
        })
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::NotFound);
}

#[test]
fn a_new_custom_tool_is_not_approved() {
    let v = Harness::new()
        .core()
        .custom_tool_save(CustomToolSaveArgs {
            tool: valid(),
            replace: false,
        })
        .unwrap();
    assert!(!v.approved);
}

#[test]
fn builtin_tools_are_approved() {
    let h = Harness::new();
    let core = h.core();
    let p = create_profile(&core, "Work");
    let tools = core
        .tools_list(ProfileScopeArgs { profile_id: p.id })
        .unwrap();
    assert!(
        tools
            .iter()
            .filter(|t| t.spec.builtin)
            .all(|t| t.spec.approved)
    );
}
