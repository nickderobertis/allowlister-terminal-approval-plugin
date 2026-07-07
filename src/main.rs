//! The standalone allowlister terminal approval plugin.
//!
//! allowlister runs this process for each gated shell command or tool call:
//! one JSON payload on stdin, one `{ "verdict", "reason" }` object on stdout.
//! The flow is deliberately thin — all judgment lives in the library:
//!
//!   1. Any non-`ask` verdict (a static allow/deny, allowlister's no-opinion
//!      `defer`, or a missing verdict) short-circuits to `defer` without reading
//!      the rest of the payload — the common, hot case.
//!   2. An `ask` verdict opens a prompt on the controlling terminal showing the
//!      flagged fragments (or the tool call) and blocks on the operator's
//!      `[a]llow`/`[d]eny`, returning it as the verdict.
//!   3. With no terminal to prompt on (CI, piped stdio, a non-unix host), it
//!      `defer`s so allowlister falls back to its own flow rather than blocking.

use allowlister_terminal_approval::{
    flagged_fragments, request_summary, start_local_prompt, static_decision, tool_input_json,
    LocalPrompt, PromptLabels,
};
use serde::Serialize;
use serde_json::Value;
use std::env;
use std::io::{self, Read};
use std::process;

#[derive(Serialize)]
struct PluginResponse<'a> {
    verdict: &'a str,
    reason: String,
}

/// Print the plugin's verdict on stdout and exit. Always exits `0` with valid
/// JSON: allowlister treats a non-zero exit or unparsable output as `defer`, and
/// this helper never risks that ambiguity.
fn write_response(verdict: &str, reason: impl Into<String>) -> ! {
    let response = PluginResponse {
        verdict,
        reason: reason.into(),
    };
    print!(
        "{}",
        serde_json::to_string(&response).expect("plugin response serializes")
    );
    process::exit(0);
}

const VERSION: &str = env!("CARGO_PKG_VERSION");

const HELP: &str = "\
allowlister-terminal-approval-plugin — the allowlister terminal approval experience.

An allowlister dynamic approval plugin. allowlister invokes it per gated command:
it reads the plugin JSON payload on stdin and prints a `{verdict, reason}` object
on stdout. On an `ask` verdict it prompts on the controlling terminal (/dev/tty)
and returns the operator's allow/deny; on any other verdict it defers.

Usage:
  allowlister-terminal-approval-plugin        read a payload on stdin, answer on stdout
  allowlister-terminal-approval-plugin --help  print this help
  allowlister-terminal-approval-plugin --version

Configure it in allowlister's config under \"plugins\"; see
https://github.com/nickderobertis/allowlister-terminal-approval-plugin
";

fn main() {
    let args: Vec<String> = env::args().collect();
    if args.iter().any(|a| a == "--version" || a == "-V") {
        println!("{VERSION}");
        return;
    }
    if args.iter().any(|a| a == "--help" || a == "-h") {
        print!("{HELP}");
        return;
    }

    let mut stdin = String::new();
    if io::stdin().read_to_string(&mut stdin).is_err() {
        // The payload could not be read as UTF-8 text — an I/O error, or non-UTF-8
        // bytes. There is no coherent request to put in front of a human, so defer
        // to allowlister's own flow rather than panic on a recoverable read.
        write_response(
            "defer",
            "could not read allowlister plugin input, deferring to allowlister",
        );
    }

    // Hot path: only an `ask` verdict needs a human. Every other state settles
    // here. Probe `current_verdict` alone — no full `Value` tree — and exit
    // before any of the prompt setup below.
    if static_decision(&stdin) == Some(true) {
        write_response(
            "defer",
            "allowlister verdict does not need terminal approval",
        );
    }

    // Non-static (or unparseable): full parse now, which also surfaces a precise
    // error for a malformed payload. A parse failure of an approval request is an
    // anomaly worth a human's eyes, so surface it with `ask` rather than defer.
    let input: Value = serde_json::from_str(&stdin).unwrap_or_else(|error| {
        write_response("ask", format!("invalid allowlister plugin input: {error}"))
    });

    // For a shell payload this names the command; for a tool call, the tool — so
    // the prompt always names the action awaiting approval. The flagged fragments
    // and tool-input JSON come straight off the same payload.
    let summary = request_summary(&input);
    let cwd = input
        .get("cwd")
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string();
    let flagged = flagged_fragments(&input);
    let tool_input = tool_input_json(&input);

    let LocalPrompt {
        decisions,
        status: _,
    } = start_local_prompt(
        &PromptLabels::STANDALONE,
        &summary,
        &cwd,
        &flagged,
        tool_input.as_deref(),
    );

    match decisions {
        Some(rx) => match rx.recv() {
            Ok(decision) => write_response(decision.verdict, decision.reason),
            // The terminal closed (EOF) before the operator answered: abstain and
            // let allowlister decide the request as it normally would.
            Err(_) => write_response(
                "defer",
                "no decision at the terminal, deferring to allowlister",
            ),
        },
        // No controlling terminal to prompt on (CI, piped stdio, a non-unix
        // host): there is no way to ask a human, so defer to allowlister's own
        // flow rather than block or force a verdict.
        None => write_response(
            "defer",
            "no controlling terminal for approval, deferring to allowlister",
        ),
    }
}
