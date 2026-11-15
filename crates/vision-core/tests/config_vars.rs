//! SEC-4 / BUG-8: the config variable of a custom tool is an allowlisted shape that cannot
//! redirect another program, and the environment builder never lets one entry silently
//! override another.
#![allow(clippy::unwrap_used)] // Test code: a panic is the failure report.

mod common;

use common::{Harness, create_profile};
use vision_core::Core;
use vision_core::ipc::{
    ConfigEnvKind, CustomToolInput, CustomToolSaveArgs, ErrorCode, IpcResult, KeyValueInput,
    McpSaveArgs, McpServerInput, McpTransportInput, ToolSpecView, ValueInput,
};

fn tool(id: &str, var: &str) -> CustomToolInput {
    CustomToolInput {
        id: id.into(),
        name: id.into(),
        description: None,
        binary: "mytool".into(),
        install_url: None,
        config_var: var.into(),
        config_kind: ConfigEnvKind::Dir,
        login: vec!["login".into()],
        status: None,
        logout: None,
    }
}

fn save(core: &Core, id: &str, var: &str) -> IpcResult<ToolSpecView> {
    core.custom_tool_save(CustomToolSaveArgs {
        tool: tool(id, var),
        replace: false,
    })
}

fn resave(core: &Core, id: &str, var: &str) -> IpcResult<ToolSpecView> {
    core.custom_tool_save(CustomToolSaveArgs {
        tool: tool(id, var),
        replace: true,
    })
}

fn code(var: &str) -> Option<ErrorCode> {
    save(&Harness::new().core(), "mytool", var)
        .err()
        .map(|e| e.code)
}

#[test]
fn a_config_dir_variable_is_accepted() {
    assert_eq!(code("MYTOOL_CONFIG_DIR"), None);
}

#[test]
fn a_java_home_style_variable_is_accepted() {
    assert_eq!(code("JAVA_HOME"), None);
}

#[test]
fn a_config_file_variable_is_accepted() {
    assert_eq!(code("MYTOOL_CONFIG_FILE"), None);
}

#[test]
fn a_variable_without_an_allowed_suffix_is_rejected() {
    assert_eq!(code("MYTOOL_TOKEN"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_bare_suffix_is_rejected() {
    assert_eq!(code("_DIR"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_lower_case_variable_is_rejected() {
    assert_eq!(code("mytool_config_dir"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_variable_longer_than_48_characters_is_rejected() {
    assert_eq!(
        code(&format!("{}_DIR", "A".repeat(45))),
        Some(ErrorCode::InvalidInput)
    );
}

#[test]
fn a_built_in_tools_variable_is_rejected() {
    assert_eq!(code("CLAUDE_CONFIG_DIR"), Some(ErrorCode::InvalidInput));
}

#[test]
fn the_codex_home_variable_is_rejected() {
    assert_eq!(code("CODEX_HOME"), Some(ErrorCode::InvalidInput));
}

#[test]
fn an_xdg_variable_is_rejected() {
    assert_eq!(code("XDG_CONFIG_HOME"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_git_variable_is_rejected() {
    assert_eq!(code("GIT_DIR"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_python_variable_is_rejected() {
    assert_eq!(code("PYTHONHOME"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_node_variable_is_rejected() {
    assert_eq!(code("NODE_CONFIG_DIR"), Some(ErrorCode::InvalidInput));
}

#[test]
fn an_npm_variable_is_rejected() {
    assert_eq!(code("NPM_CONFIG_DIR"), Some(ErrorCode::InvalidInput));
}

#[test]
fn an_aws_variable_is_rejected() {
    assert_eq!(code("AWS_CONFIG_FILE"), Some(ErrorCode::InvalidInput));
}

#[test]
fn an_ssh_variable_is_rejected() {
    assert_eq!(code("SSH_HOME"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_github_variable_is_rejected() {
    assert_eq!(code("GITHUB_CONFIG_DIR"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_google_variable_is_rejected() {
    assert_eq!(code("GOOGLE_CONFIG_DIR"), Some(ErrorCode::InvalidInput));
}

#[test]
fn zdotdir_is_rejected() {
    assert_eq!(code("ZDOTDIR"), Some(ErrorCode::InvalidInput));
}

#[test]
fn home_is_rejected() {
    assert_eq!(code("HOME"), Some(ErrorCode::InvalidInput));
}

#[test]
fn a_variable_of_another_custom_tool_is_rejected() {
    let core = Harness::new().core();
    save(&core, "first", "SHARED_CONFIG_DIR").unwrap();
    assert_eq!(
        save(&core, "second", "SHARED_CONFIG_DIR").unwrap_err().code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn resaving_a_custom_tool_keeps_its_own_variable() {
    let core = Harness::new().core();
    save(&core, "first", "SHARED_CONFIG_DIR").unwrap();
    assert!(resave(&core, "first", "SHARED_CONFIG_DIR").is_ok());
}

#[test]
fn an_mcp_variable_that_redirects_a_shared_login_is_rejected() {
    let h = Harness::new();
    let core = h.core();
    let pid = create_profile(&core, "Work").id;
    let e = core
        .mcp_save(McpSaveArgs {
            profile_id: pid,
            server: McpServerInput {
                id: None,
                name: "files".into(),
                transport: McpTransportInput::Stdio {
                    command: "npx".into(),
                    args: vec![],
                    env: vec![KeyValueInput {
                        key: "CLOUDSDK_CONFIG".into(),
                        value: ValueInput::Plain {
                            value: "/tmp/elsewhere".into(),
                        },
                    }],
                },
                tool_ids: vec!["gcloud".into()],
                enabled: true,
            },
        })
        .unwrap_err();
    assert_eq!(e.code, ErrorCode::InvalidInput);
}

// ---- A6: well-known names outside the suffix rule ----------------------------------------

#[test]
fn kubeconfig_is_accepted() {
    assert_eq!(code("KUBECONFIG"), None);
}

#[test]
fn docker_config_is_accepted() {
    assert_eq!(code("DOCKER_CONFIG"), None);
}

#[test]
fn helm_config_home_is_accepted() {
    assert_eq!(code("HELM_CONFIG_HOME"), None);
}

#[test]
fn a_name_that_only_contains_kubeconfig_is_rejected() {
    assert_eq!(code("MYKUBECONFIG"), Some(ErrorCode::InvalidInput));
}

#[test]
fn kubeconfig_used_by_another_custom_tool_is_rejected() {
    let core = Harness::new().core();
    save(&core, "first", "KUBECONFIG").unwrap();
    assert_eq!(
        save(&core, "second", "KUBECONFIG").unwrap_err().code,
        ErrorCode::InvalidInput
    );
}

#[test]
fn a_config_variable_error_names_the_config_var_field() {
    let e = save(&Harness::new().core(), "mytool", "HOME").unwrap_err();
    assert_eq!(e.field.as_deref(), Some("config_var"));
}
