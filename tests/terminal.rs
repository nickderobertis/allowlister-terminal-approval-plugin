//! Interactive end-to-end tests for the real `/dev/tty` approval prompt.
//!
//! The prompt only opens on a controlling terminal, so these drive the compiled
//! binary the way a human does: a payload arrives on a piped stdin while the
//! answer is typed at a terminal. To make that deterministic (independent of
//! whatever terminal the test runner was launched from), each test allocates a
//! PTY and makes the child its own session leader with that PTY as its
//! controlling terminal (`setsid` + `TIOCSCTTY`) — so `/dev/tty` resolves to a
//! terminal *this test* drives. The no-terminal case uses `setsid` alone (a
//! session with no controlling terminal) to prove the defer path.
//!
//! Unix-only: the terminal approval experience is `/dev/tty`.
#![cfg(unix)]

use std::fs::File;
use std::io::{self, Read, Write};
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use nix::pty::openpty;
use serde_json::Value;

fn plugin_path() -> &'static str {
    env!("CARGO_BIN_EXE_allowlister-terminal-approval-plugin")
}

/// Drive the plugin against a real controlling terminal: deliver `payload` on
/// stdin, wait for the allow/deny cue on the terminal, type `keystrokes`, and
/// return the parsed `{verdict, reason}` response together with the full terminal
/// transcript (so tests can assert on what the operator actually saw).
fn run_interactive(payload: &str, keystrokes: &str) -> (Value, String) {
    let pty = openpty(None, None).expect("allocate a PTY");
    let slave_raw = pty.slave.as_raw_fd();

    let mut cmd = Command::new(plugin_path());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: the closure runs in the forked child before exec and calls only
    // async-signal-safe libc functions (setsid, ioctl).
    unsafe {
        cmd.pre_exec(move || {
            // New session (drops any inherited controlling terminal), then adopt
            // the PTY slave as this session's controlling terminal so the plugin's
            // `/dev/tty` open resolves to it.
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            if libc::ioctl(slave_raw, libc::TIOCSCTTY as _, 0) == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().expect("spawn plugin");
    // The child adopted the slave as its controlling terminal; the parent drives
    // the master and no longer needs its own slave handle.
    drop(pty.slave);

    // Deliver the payload and close stdin so the plugin finishes reading it and
    // moves on to open the terminal prompt.
    {
        let mut stdin = child.stdin.take().expect("child stdin");
        stdin.write_all(payload.as_bytes()).expect("write payload");
    }

    // Drain the terminal in the background into a shared transcript.
    let master = File::from(pty.master);
    let mut master_reader = master.try_clone().expect("clone PTY master");
    let transcript = Arc::new(Mutex::new(Vec::<u8>::new()));
    let transcript_reader = Arc::clone(&transcript);
    let reader = thread::spawn(move || {
        let mut buf = [0u8; 1024];
        loop {
            match master_reader.read(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(n) => transcript_reader
                    .lock()
                    .unwrap()
                    .extend_from_slice(&buf[..n]),
            }
        }
    });

    // Wait for the allow/deny cue before answering.
    let deadline = Instant::now() + Duration::from_secs(10);
    loop {
        let so_far = String::from_utf8_lossy(&transcript.lock().unwrap()).into_owned();
        if so_far.contains("[a]llow / [d]eny:") {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "never saw the approval prompt; terminal so far: {so_far:?}"
        );
        thread::sleep(Duration::from_millis(20));
    }

    let mut master_writer = master;
    master_writer
        .write_all(keystrokes.as_bytes())
        .expect("type keystrokes");
    master_writer.flush().ok();

    let output = child.wait_with_output().expect("plugin exits");
    let _ = reader.join();
    assert!(output.status.success(), "plugin should exit 0");
    let response = serde_json::from_slice(&output.stdout).expect("plugin stdout is JSON");
    let seen = String::from_utf8_lossy(&transcript.lock().unwrap()).into_owned();
    (response, seen)
}

/// Drive the plugin in a session with no controlling terminal (`setsid` only),
/// proving the no-terminal defer path.
fn run_without_terminal(payload: &str) -> Value {
    let mut cmd = Command::new(plugin_path());
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    // SAFETY: only the async-signal-safe `setsid` runs in the child before exec.
    unsafe {
        cmd.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = cmd.spawn().expect("spawn plugin");
    {
        let mut stdin = child.stdin.take().expect("child stdin");
        stdin.write_all(payload.as_bytes()).expect("write payload");
    }
    let output = child.wait_with_output().expect("plugin exits");
    assert!(output.status.success(), "plugin should exit 0");
    serde_json::from_slice(&output.stdout).expect("plugin stdout is JSON")
}

const SHELL_ASK: &str = r#"{
  "protocol_version": 3,
  "subject": "shell",
  "current_verdict": "ask",
  "command": "gh pr merge 42 --squash",
  "cwd": "/workspace/app",
  "fragments": [
    {"display": "gh pr merge 42 --squash", "argv": ["gh","pr","merge","42","--squash"],
     "role": "standalone", "verdict": "ask", "rule": "ask before merging a PR",
     "reason": "needs approval per rule 'ask before merging a PR'"}
  ]
}"#;

const TOOL_ASK: &str = r#"{
  "protocol_version": 3,
  "subject": "tool",
  "current_verdict": "ask",
  "cwd": "/workspace/app",
  "tool": {"name": "mcp__github__create_issue", "capability": "mcp", "params": {},
           "raw": {"owner": "acme", "repo": "app", "title": "Production is down"}}
}"#;

#[test]
fn shell_ask_surfaces_the_flagged_fragment_and_returns_the_typed_allow() {
    let (response, transcript) = run_interactive(SHELL_ASK, "a\n");

    assert_eq!(response["verdict"], "allow");
    assert_eq!(response["reason"], "approved at local terminal");

    // The operator saw the flagged fragment, its rule, the full command, and cwd.
    assert!(transcript.contains("Needs your attention"), "{transcript}");
    assert!(
        transcript.contains("gh pr merge 42 --squash"),
        "{transcript}"
    );
    assert!(
        transcript.contains("ask before merging a PR"),
        "{transcript}"
    );
    assert!(transcript.contains("cwd: /workspace/app"), "{transcript}");
}

#[test]
fn tool_ask_shows_the_tool_input_json_and_returns_the_typed_deny() {
    let (response, transcript) = run_interactive(TOOL_ASK, "d\n");

    assert_eq!(response["verdict"], "deny");
    assert_eq!(response["reason"], "denied at local terminal");

    // A tool call names the tool and renders its verbatim arguments as JSON.
    assert!(
        transcript.contains("mcp__github__create_issue"),
        "{transcript}"
    );
    assert!(transcript.contains("Tool input:"), "{transcript}");
    assert!(transcript.contains("Production is down"), "{transcript}");
}

#[test]
fn unrecognized_input_reprompts_then_accepts_the_answer() {
    let (response, transcript) = run_interactive(SHELL_ASK, "huh?\na\n");

    assert_eq!(response["verdict"], "allow");
    assert!(
        transcript.contains("Please type 'a' to allow or 'd' to deny:"),
        "{transcript}"
    );
}

#[test]
fn no_controlling_terminal_defers_to_allowlister() {
    let response = run_without_terminal(SHELL_ASK);

    assert_eq!(response["verdict"], "defer");
    assert_eq!(
        response["reason"],
        "no controlling terminal for approval, deferring to allowlister"
    );
}
