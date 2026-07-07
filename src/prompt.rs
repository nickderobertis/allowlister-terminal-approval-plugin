//! The controlling-terminal approval prompt.
//!
//! [`start_local_prompt`] opens the controlling terminal (`/dev/tty`), writes
//! the rendered [`local_prompt`], and spawns a reader thread that turns the
//! operator's keystroke into a [`LocalDecision`] on a channel.
//! The binary blocks on that channel; allowlister-remote races it against a
//! decision arriving over the network. When there is no controlling terminal (a
//! non-interactive run, piped stdio, or a non-unix host), it returns an empty
//! [`LocalPrompt`] so the caller can fall back to deferring.
//!
//! The read/parse loop is factored into a `run_prompt_loop` seam so it is
//! exercised directly with in-memory pipes — the retry-on-unrecognized-input
//! behavior does not need a real terminal to be tested.

use std::fs::{File, OpenOptions};
use std::io::{BufRead, BufReader, Write};
use std::sync::mpsc::{self, Receiver, Sender};
use std::thread;

use crate::{local_prompt, parse_local_input, FlaggedFragment, LocalDecision, PromptLabels};

/// The handles [`start_local_prompt`] hands back: a channel that yields the
/// operator's decision once, and a writer onto the same terminal for status
/// updates (e.g. confirming a decision that arrived elsewhere). Both are `None`
/// when there is no controlling terminal to prompt on, so the caller defers.
pub struct LocalPrompt {
    pub decisions: Option<Receiver<LocalDecision>>,
    pub status: Option<File>,
}

/// Write the prompt to the terminal, then read lines from it: re-prompt on any
/// unrecognized input and send the first recognized allow/deny decision,
/// stopping at EOF or a read error. Generic over the reader/writer so it runs
/// against in-memory pipes in tests instead of a real `/dev/tty`.
fn run_prompt_loop<R: BufRead, W: Write>(
    reader: R,
    mut writer: W,
    tx: &Sender<LocalDecision>,
    prompt_text: &str,
) {
    let _ = writeln!(writer, "{prompt_text}");
    for line in reader.lines() {
        let Ok(line) = line else { break };
        match parse_local_input(&line) {
            Some(decision) => {
                let _ = tx.send(decision);
                break;
            }
            None => {
                let _ = writeln!(writer, "Please type 'a' to allow or 'd' to deny: ");
            }
        }
    }
}

/// Open a prompt on the controlling terminal for an `ask` request. Returns the
/// decision channel and a status writer, or an empty [`LocalPrompt`] when no
/// terminal can be opened (CI, piped stdio, non-unix). `labels` selects the
/// product-specific banner and instruction; the rest of the prompt is built by
/// [`local_prompt`] from the same fragments/tool-input the web app shows.
pub fn start_local_prompt(
    labels: &PromptLabels,
    command: &str,
    cwd: &str,
    flagged: &[FlaggedFragment],
    tool_input: Option<&str>,
) -> LocalPrompt {
    // `/dev/tty` is the process's controlling terminal regardless of where stdin
    // and stdout are wired — so the JSON payload can arrive on a piped stdin
    // while the human still answers at the keyboard. On a host without one (or a
    // non-unix host) this open fails and we defer.
    let Ok(tty) = OpenOptions::new().read(true).write(true).open("/dev/tty") else {
        return LocalPrompt {
            decisions: None,
            status: None,
        };
    };
    let (Ok(prompt_writer), Ok(status_writer)) = (tty.try_clone(), tty.try_clone()) else {
        return LocalPrompt {
            decisions: None,
            status: None,
        };
    };

    let prompt_text = local_prompt(labels, command, cwd, flagged, tool_input);
    let (tx, rx) = mpsc::channel();
    thread::spawn(move || {
        run_prompt_loop(BufReader::new(tty), prompt_writer, &tx, &prompt_text);
    });

    LocalPrompt {
        decisions: Some(rx),
        status: Some(status_writer),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::Cursor;

    #[test]
    fn loop_sends_the_first_recognized_decision_and_writes_the_prompt() {
        let (tx, rx) = mpsc::channel();
        let mut written = Vec::new();
        run_prompt_loop(Cursor::new(b"a\n".to_vec()), &mut written, &tx, "PROMPT");

        let decision = rx.try_recv().expect("a decision was sent");
        assert_eq!(decision.verdict, "allow");
        // The prompt text is written to the terminal before reading.
        assert!(String::from_utf8(written).unwrap().starts_with("PROMPT\n"));
    }

    #[test]
    fn loop_reprompts_on_unrecognized_input_then_accepts_a_deny() {
        let (tx, rx) = mpsc::channel();
        let mut written = Vec::new();
        // Garbage, then a blank line, then a valid deny.
        run_prompt_loop(
            Cursor::new(b"maybe\n\nd\n".to_vec()),
            &mut written,
            &tx,
            "PROMPT",
        );

        assert_eq!(rx.try_recv().expect("a decision was sent").verdict, "deny");
        // Each unrecognized line drew a re-prompt (two before the accepted deny).
        let out = String::from_utf8(written).unwrap();
        assert_eq!(
            out.matches("Please type 'a' to allow or 'd' to deny:")
                .count(),
            2
        );
    }

    #[test]
    fn loop_stops_at_eof_without_a_decision() {
        let (tx, rx) = mpsc::channel::<LocalDecision>();
        let mut written = Vec::new();
        // Only unrecognized input, then EOF: no decision is ever sent.
        run_prompt_loop(Cursor::new(b"nope\n".to_vec()), &mut written, &tx, "PROMPT");
        drop(tx);
        assert!(rx.try_recv().is_err());
    }
}
