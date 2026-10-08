//! Non-interactive end-to-end tests: drive the compiled plugin binary as a
//! subprocess the way allowlister does — one JSON payload on stdin, one
//! `{verdict, reason}` object on stdout — and assert on its exit and output.
//!
//! Every case here settles *before* the terminal prompt: a static verdict
//! short-circuits to `defer`, malformed input returns `ask`, and `--version` /
//! `--help` answer before reading stdin. The interactive `ask` path — which
//! opens `/dev/tty` and blocks — is exercised under a real PTY in `terminal.rs`,
//! never here (piping an `ask` payload with no controlled terminal would hang on
//! whatever terminal the test runner inherited).

use assert_cmd::Command;
use serde_json::Value;

fn plugin() -> Command {
    Command::cargo_bin("allowlister-terminal-approval-plugin").expect("binary builds")
}

/// The plugin crate's version, read from its manifest at the repo root: this e2e
/// crate's own `CARGO_PKG_VERSION` is a placeholder (`0.0.0`), and the binary
/// reports the plugin crate's.
fn plugin_version() -> &'static str {
    const MANIFEST: &str = include_str!("../../Cargo.toml");
    let package = MANIFEST
        .split("\n[package]\n")
        .nth(1)
        .expect("the root Cargo.toml has a [package] table");
    package
        .lines()
        .find_map(|line| line.strip_prefix("version = \""))
        .and_then(|rest| rest.strip_suffix('"'))
        .expect("the root [package] states a literal version")
}

/// Run the plugin with `payload` on stdin, assert success, and return the parsed
/// `{verdict, reason}` response.
fn run(payload: &str) -> Value {
    let output = plugin().write_stdin(payload).assert().success();
    let stdout = &output.get_output().stdout;
    serde_json::from_slice(stdout).expect("plugin stdout is a JSON object")
}

#[test]
fn every_non_ask_verdict_defers_without_a_prompt() {
    // A terminal allow/deny, allowlister's no-opinion `defer`, and a missing
    // verdict all settle here without opening a terminal.
    for payload in [
        r#"{"current_verdict":"allow","command":"git status","cwd":"/repo"}"#,
        r#"{"current_verdict":"deny","command":"rm -rf /","cwd":"/repo"}"#,
        r#"{"current_verdict":"defer","command":"make","cwd":"/repo"}"#,
        r#"{"command":"ls","cwd":"/repo"}"#,
    ] {
        let response = run(payload);
        assert_eq!(response["verdict"], "defer", "payload: {payload}");
        assert_eq!(
            response["reason"], "allowlister verdict does not need terminal approval",
            "payload: {payload}"
        );
    }
}

#[test]
fn malformed_payload_surfaces_as_ask_with_the_parse_error() {
    let response = run("not json at all");
    assert_eq!(response["verdict"], "ask");
    assert!(
        response["reason"]
            .as_str()
            .unwrap()
            .contains("invalid allowlister plugin input"),
        "got {response}"
    );
}

#[test]
fn non_utf8_payload_defers_instead_of_crashing() {
    // A binary or otherwise non-UTF-8 payload can't be read as text. The plugin
    // must still exit 0 with a valid verdict — defer to allowlister — rather than
    // panic on the stdin read.
    let output = plugin()
        .write_stdin(vec![0xff, 0xfe, 0x00, 0x9c])
        .assert()
        .success();
    let response: Value = serde_json::from_slice(&output.get_output().stdout)
        .expect("plugin stdout is a JSON object");
    assert_eq!(response["verdict"], "defer");
    assert_eq!(
        response["reason"],
        "could not read allowlister plugin input, deferring to allowlister"
    );
}

#[test]
fn version_flag_prints_the_crate_version() {
    plugin()
        .arg("--version")
        .assert()
        .success()
        .stdout(predicates::str::starts_with(plugin_version()));
}

#[test]
fn help_flag_describes_the_plugin() {
    plugin()
        .arg("--help")
        .assert()
        .success()
        .stdout(predicates::str::contains("terminal approval"))
        .stdout(predicates::str::contains("allowlister"));
}
