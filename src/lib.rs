//! The allowlister terminal approval experience, as a reusable library.
//!
//! allowlister evaluates each shell command or tool call an AI coding agent
//! wants to run and, for anything it cannot settle statically, emits an `ask`
//! verdict over its [dynamic approval plugin protocol][protocol]: one JSON
//! payload on stdin, one `{ "verdict", "reason" }` object on stdout. This crate
//! turns that `ask` into a clear prompt on the operator's controlling terminal —
//! the flagged command fragments ("needs your attention"), the full command, the
//! cwd, and, for a tool call, its arguments as formatted JSON — then reads a
//! single `[a]llow`/`[d]eny` keystroke and returns the verdict.
//!
//! The binary ([`main.rs`](../src/main.rs)) is the thin I/O shell: read stdin,
//! short-circuit any non-`ask` verdict to `defer`, otherwise open the terminal
//! prompt and answer with it. Everything that is *not* process I/O — parsing the
//! payload, deciding whether a static verdict skips the prompt, reducing the
//! fragments to the ones that tripped, rendering the prompt text, and mapping a
//! keystroke onto a verdict — lives here so it is unit-testable without a
//! terminal, and so allowlister-remote can reuse the exact same prompt to power
//! its remote-approval race (it renders this prompt on `/dev/tty` while a phone
//! approves over the network, whichever answers first wins).
//!
//! [protocol]: https://github.com/nickderobertis/allowlister#dynamic-approval-plugins

use serde::Deserialize;
use serde_json::Value;

pub mod prompt;

pub use prompt::{start_local_prompt, LocalPrompt};

/// A decision captured from the operator at the local terminal.
pub struct LocalDecision {
    pub verdict: &'static str,
    pub reason: String,
}

/// The two product-specific lines of the prompt, so the same renderer serves
/// both the standalone plugin and allowlister-remote. `header` is the banner
/// line (e.g. `allowlister approval required`); `instruction` is the trailing
/// call to action that ends with the `[a]llow / [d]eny:` cue. Everything between
/// — the flagged fragments, the full command, the tool input, the cwd — is
/// identical across products, so only these two strings differ.
pub struct PromptLabels<'a> {
    pub header: &'a str,
    pub instruction: &'a str,
}

impl PromptLabels<'_> {
    /// The standalone terminal plugin's wording.
    pub const STANDALONE: PromptLabels<'static> = PromptLabels {
        header: "allowlister approval required",
        instruction: "Allow this action? [a]llow / [d]eny: ",
    };
}

/// A fragment allowlister flagged for the operator, reduced to what the terminal
/// prompt surfaces: the command text that tripped the gate and the rule that
/// flagged it (if any). This is one row of the web app's "needs your attention"
/// list, rendered as plain text instead of a card.
pub struct FlaggedFragment {
    pub display: String,
    pub rule: Option<String>,
}

/// The fragments the operator must actually weigh: allowlister already decided
/// the rest are `allow`, so anything else (ask/deny/defer) is what gets
/// surfaced, with a fallback to the full set when — unexpectedly — nothing is
/// flagged. A payload with no `fragments` (a tool call) yields an empty list, so
/// the prompt simply omits the fragment block and shows the action alone.
pub fn flagged_fragments(input: &Value) -> Vec<FlaggedFragment> {
    let Some(fragments) = input.get("fragments").and_then(Value::as_array) else {
        return Vec::new();
    };
    let to_flagged = |fragment: &Value| FlaggedFragment {
        display: fragment
            .get("display")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        rule: fragment
            .get("rule")
            .and_then(Value::as_str)
            .map(str::to_string),
    };
    let flagged: Vec<FlaggedFragment> = fragments
        .iter()
        .filter(|fragment| fragment.get("verdict").and_then(Value::as_str) != Some("allow"))
        .map(to_flagged)
        .collect();
    if flagged.is_empty() {
        fragments.iter().map(to_flagged).collect()
    } else {
        flagged
    }
}

/// A tool call's verbatim arguments (`tool.raw`), pretty-printed as indented
/// JSON for the terminal prompt — the terminal twin of a web approval UI's
/// tool-call detail, so approving a tool at the terminal is not blind to what it
/// will do, only its name. Returns `None` for a shell payload (no `tool`) or a
/// tool call that carried no arguments, so the prompt simply omits the block.
/// Reads `raw` (the agent's actual input) rather than any adapter-canonical
/// `params`.
pub fn tool_input_json(input: &Value) -> Option<String> {
    let raw = input.get("tool").and_then(|tool| tool.get("raw"))?;
    if raw.as_object().is_none_or(serde_json::Map::is_empty) {
        return None;
    }
    serde_json::to_string_pretty(raw).ok()
}

/// The exact text written to the controlling terminal to open an approval
/// prompt: first the fragments allowlister flagged ("needs your attention" — the
/// command that tripped plus its rule), then the full command, the cwd, and the
/// allow/deny instruction. For a tool call there are no fragments; instead
/// `tool_input` carries its arguments as formatted JSON (see [`tool_input_json`])
/// rendered under the action, so the operator sees what the tool will do. The
/// product-specific banner and instruction come from `labels`, so the same
/// renderer serves the standalone plugin and allowlister-remote. Extracted as a
/// pure function so the binary's real terminal surface is unit-testable. The
/// caller appends the trailing newline (`writeln!`), so this returns the block
/// without it.
pub fn local_prompt(
    labels: &PromptLabels,
    command: &str,
    cwd: &str,
    flagged: &[FlaggedFragment],
    tool_input: Option<&str>,
) -> String {
    let mut prompt = format!("\n{}\n", labels.header);

    if !flagged.is_empty() {
        prompt.push_str("\nNeeds your attention:\n");
        for fragment in flagged {
            prompt.push_str("  ");
            prompt.push_str(&fragment.display);
            prompt.push('\n');
            if let Some(rule) = &fragment.rule {
                prompt.push_str("    ");
                prompt.push_str(rule);
                prompt.push('\n');
            }
        }
    }

    // The full command always follows the flagged fragments, each line indented
    // so a multi-line script reads as one block (a tool call is a single line:
    // its name, with the arguments rendered as JSON in the block below).
    prompt.push_str("\nFull command:\n");
    for line in command.split('\n') {
        prompt.push_str("  ");
        prompt.push_str(line);
        prompt.push('\n');
    }

    // A tool call's formatted arguments, each line indented to match the command
    // block so the JSON reads as one unit beneath the action it belongs to.
    if let Some(tool_input) = tool_input {
        prompt.push_str("\nTool input:\n");
        for line in tool_input.split('\n') {
            prompt.push_str("  ");
            prompt.push_str(line);
            prompt.push('\n');
        }
    }

    prompt.push_str(&format!("\n  cwd: {cwd}\n{}", labels.instruction));
    prompt
}

/// Map a line typed at the terminal onto an allow/deny verdict, ignoring
/// anything we do not recognize so the operator can simply retry.
pub fn parse_local_input(line: &str) -> Option<LocalDecision> {
    match line.trim().to_ascii_lowercase().as_str() {
        "a" | "allow" | "y" | "yes" => Some(LocalDecision {
            verdict: "allow",
            reason: "approved at local terminal".to_string(),
        }),
        "d" | "deny" | "n" | "no" => Some(LocalDecision {
            verdict: "deny",
            reason: "denied at local terminal".to_string(),
        }),
        _ => None,
    }
}

/// The short human label for the terminal prompt: the shell command when
/// present, otherwise the tool name for a non-shell tool call, otherwise empty.
pub fn request_summary(input: &Value) -> String {
    if let Some(command) = input.get("command").and_then(Value::as_str) {
        if !command.is_empty() {
            return command.to_string();
        }
    }
    input
        .get("tool")
        .and_then(|tool| tool.get("name"))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_string()
}

/// The shared predicate behind [`is_static_decision`] and [`static_decision`]:
/// only an explicit `ask` verdict — allowlister wanting a human to decide —
/// needs a terminal prompt. Every other state settles without one: a terminal
/// `allow`/`deny`, a `defer` (allowlister abstains and runs its normal flow), or
/// a missing verdict. So only `ask` reaches the prompt.
fn is_static_verdict(verdict: Option<&str>) -> bool {
    verdict != Some("ask")
}

/// Whether allowlister settled this request without needing a human, so the
/// plugin can defer without prompting. Only an `ask` verdict reaches the prompt;
/// `allow`, `deny`, `defer`, and a missing verdict are all left to allowlister's
/// own flow.
pub fn is_static_decision(input: &Value) -> bool {
    is_static_verdict(input.get("current_verdict").and_then(Value::as_str))
}

/// A zero-copy probe over the payload that reads only `current_verdict` and
/// skips every other field without allocating it — `&str` borrows straight out
/// of the input buffer when the verdict has no escapes (it never does).
#[derive(Deserialize)]
struct StaticProbe<'a> {
    #[serde(borrow, default)]
    current_verdict: Option<&'a str>,
}

/// The hot path's cheap front door: decide whether a payload settles the request
/// without a prompt, reading only `current_verdict` rather than building the
/// whole [`Value`] tree. The binary runs this on every invocation, so the common
/// non-`ask` case (allow/deny/defer/missing) short-circuits to `defer` without
/// parsing the rest of the payload; only an `ask` verdict falls through to the
/// prompt path. Returns `None` when the payload does not parse, so the caller
/// falls back to a full parse that surfaces the precise error.
/// [`is_static_decision`] is the same predicate over an already-parsed value.
pub fn static_decision(stdin: &str) -> Option<bool> {
    let probe: StaticProbe = serde_json::from_str(stdin).ok()?;
    Some(is_static_verdict(probe.current_verdict))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn labels() -> PromptLabels<'static> {
        PromptLabels::STANDALONE
    }

    #[test]
    fn local_prompt_surfaces_flagged_fragments_then_the_full_command() {
        // A "needs your attention" block (each flagged fragment plus its rule)
        // precedes the full command and the cwd.
        let flagged = [
            FlaggedFragment {
                display: "npm publish --access public".to_string(),
                rule: Some("ask before publishing a package".to_string()),
            },
            FlaggedFragment {
                display: "git push origin main --tags".to_string(),
                rule: None,
            },
        ];
        assert_eq!(
            local_prompt(
                &labels(),
                "npm ci\nnpm publish --access public",
                "~/src/app",
                &flagged,
                None
            ),
            "\nallowlister approval required\n\nNeeds your attention:\n  npm publish --access public\n    ask before publishing a package\n  git push origin main --tags\n\nFull command:\n  npm ci\n  npm publish --access public\n\n  cwd: ~/src/app\nAllow this action? [a]llow / [d]eny: "
        );
    }

    #[test]
    fn local_prompt_without_fragments_shows_the_action_alone() {
        // A tool call has no fragments: no "needs your attention" block, just the
        // action under "Full command:". With no arguments there is no tool-input
        // block either.
        assert_eq!(
            local_prompt(&labels(), "mcp__github__create_issue", "~/src/app", &[], None),
            "\nallowlister approval required\n\nFull command:\n  mcp__github__create_issue\n\n  cwd: ~/src/app\nAllow this action? [a]llow / [d]eny: "
        );
    }

    #[test]
    fn local_prompt_renders_tool_input_as_indented_json() {
        // A tool call with arguments: the formatted JSON follows the action under
        // a "Tool input:" block, each line indented to match the command block.
        let tool = serde_json::json!({
            "tool": {
                "name": "mcp__github__create_issue",
                "capability": "mcp",
                "raw": {"repo": "allowlister", "title": "Ship it"},
            }
        });
        let tool_input = tool_input_json(&tool).expect("tool with raw args yields JSON");
        assert_eq!(
            local_prompt(&labels(), "mcp__github__create_issue", "~/src/app", &[], Some(&tool_input)),
            "\nallowlister approval required\n\nFull command:\n  mcp__github__create_issue\n\nTool input:\n  {\n    \"repo\": \"allowlister\",\n    \"title\": \"Ship it\"\n  }\n\n  cwd: ~/src/app\nAllow this action? [a]llow / [d]eny: "
        );
    }

    #[test]
    fn local_prompt_labels_are_the_only_product_specific_lines() {
        // allowlister-remote reuses this renderer with its own banner and
        // call-to-action; only those two lines change, proving the extraction is
        // faithful to remote's existing prompt.
        let remote = PromptLabels {
            header: "allowlister-remote approval required",
            instruction: "Approve here or in the web app. [a]llow / [d]eny: ",
        };
        assert_eq!(
            local_prompt(&remote, "gh pr merge 42", "~/src/app", &[], None),
            "\nallowlister-remote approval required\n\nFull command:\n  gh pr merge 42\n\n  cwd: ~/src/app\nApprove here or in the web app. [a]llow / [d]eny: "
        );
    }

    #[test]
    fn tool_input_json_pretty_prints_raw_and_skips_empty_or_shell() {
        // The agent's verbatim `raw` input is pretty-printed as indented JSON.
        let tool = serde_json::json!({
            "tool": {"name": "write", "raw": {"path": "/etc/hosts", "lines": 12}}
        });
        // serde_json renders object keys in sorted order (no `preserve_order`),
        // which keeps the prompt deterministic regardless of input key order.
        assert_eq!(
            tool_input_json(&tool).as_deref(),
            Some("{\n  \"lines\": 12,\n  \"path\": \"/etc/hosts\"\n}")
        );
        // A tool call with no arguments, or one whose `raw` is empty, has no block.
        assert_eq!(
            tool_input_json(&serde_json::json!({"tool": {"name": "ls"}})),
            None
        );
        assert_eq!(
            tool_input_json(&serde_json::json!({"tool": {"name": "ls", "raw": {}}})),
            None
        );
        // A shell payload (no `tool`) never renders a tool-input block.
        assert_eq!(tool_input_json(&serde_json::json!({"command": "ls"})), None);
    }

    #[test]
    fn flagged_fragments_picks_non_allow_then_falls_back_to_all() {
        // Only the ask/deny/defer fragments are flagged; the allowed ones drop.
        let shell = serde_json::json!({
            "fragments": [
                {"display": "npm ci", "verdict": "allow", "rule": "allow npm scripts"},
                {"display": "npm publish --access public", "verdict": "ask", "rule": "ask before publishing a package"},
                {"display": "echo done", "verdict": "defer", "rule": null},
            ]
        });
        let flagged = flagged_fragments(&shell);
        assert_eq!(flagged.len(), 2);
        assert_eq!(flagged[0].display, "npm publish --access public");
        assert_eq!(
            flagged[0].rule.as_deref(),
            Some("ask before publishing a package")
        );
        assert_eq!(flagged[1].display, "echo done");
        assert_eq!(flagged[1].rule, None);

        // All-allow is unexpected at a prompt, but falls back to the full set
        // rather than rendering an empty block.
        let all_allow = serde_json::json!({
            "fragments": [{"display": "npm ci", "verdict": "allow", "rule": "allow npm scripts"}]
        });
        let fallback = flagged_fragments(&all_allow);
        assert_eq!(fallback.len(), 1);
        assert_eq!(fallback[0].display, "npm ci");

        // A tool call (no fragments) yields an empty list.
        assert!(flagged_fragments(&serde_json::json!({"tool": {"name": "write"}})).is_empty());
    }

    #[test]
    fn local_input_maps_synonyms_and_ignores_noise() {
        assert_eq!(parse_local_input(" Allow ").unwrap().verdict, "allow");
        assert_eq!(parse_local_input("y").unwrap().verdict, "allow");
        assert_eq!(parse_local_input("DENY").unwrap().verdict, "deny");
        assert_eq!(parse_local_input("n").unwrap().verdict, "deny");
        assert!(parse_local_input("maybe").is_none());
    }

    #[test]
    fn request_summary_prefers_command_then_tool_name() {
        assert_eq!(
            request_summary(&serde_json::json!({"command":"npm test"})),
            "npm test"
        );
        assert_eq!(
            request_summary(&serde_json::json!({"command":"","tool":{"name":"write"}})),
            "write"
        );
        assert_eq!(request_summary(&serde_json::json!({})), "");
    }

    #[test]
    fn only_ask_reaches_the_prompt_other_verdicts_defer() {
        // The cheap stdin probe agrees with the Value-based predicate across the
        // verdicts allowlister sends: only `ask` needs a prompt.
        for (payload, expected_static) in [
            (
                r#"{"current_verdict":"allow","command":"git status"}"#,
                true,
            ),
            (r#"{"current_verdict":"deny"}"#, true),
            (r#"{"current_verdict":"defer","command":"x"}"#, true),
            (r#"{"current_verdict":"ask"}"#, false),
            (r#"{"command":"git status"}"#, true),
        ] {
            let input: Value = serde_json::from_str(payload).expect("valid");
            assert_eq!(static_decision(payload), Some(expected_static));
            assert_eq!(is_static_decision(&input), expected_static);
        }
        // Unparseable input yields None so the caller can fall back to a full
        // parse that surfaces the precise error.
        assert_eq!(static_decision("not json"), None);
    }
}
