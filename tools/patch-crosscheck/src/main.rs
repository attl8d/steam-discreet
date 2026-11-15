//! Re-runs the hook fixtures through the real Rust `regex` crate, using a copy
//! of Millennium's patch engine (src/instrumentation/loopback/src/engine.rs at
//! v3.6.3, 6522c24) with logging and IPC removed. The bun harness writes the
//! cases and its own outputs (tests/hooks/crosscheck.ts); this program fails if
//! any pattern does not compile here or any output differs.
//!
//! Usage: cargo run --manifest-path tools/patch-crosscheck/Cargo.toml -- <cases.json>

use oxc_allocator::Allocator;
use oxc_parser::Parser;
use oxc_span::SourceType;
use regex::{Regex, RegexSet};
use serde::Deserialize;
use std::process::ExitCode;

#[derive(Deserialize)]
struct Transform {
    #[serde(rename = "match")]
    pattern: String,
    replace: String,
}

#[derive(Deserialize)]
struct Patch {
    file: String,
    find: String,
    transforms: Vec<Transform>,
}

#[derive(Deserialize)]
struct Case {
    label: String,
    patch: usize,
    filename: String,
    input: String,
    expected: String,
}

#[derive(Deserialize)]
struct MatchCase {
    pattern: String,
    text: String,
    expected: Vec<String>,
}

#[derive(Deserialize)]
struct Input {
    plugin: String,
    patches: Vec<Patch>,
    cases: Vec<Case>,
    matches: Vec<MatchCase>,
}

// --- copied from engine.rs ---------------------------------------------------

fn expand_self(s: &str, plugin_name: &str) -> String {
    s.replace("#{{self}}", &format!("window.PLUGIN_LIST['{}']", plugin_name))
}

fn re2_to_rust_rep(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    let mut chars = s.chars().peekable();
    while let Some(c) = chars.next() {
        if c == '$' {
            out.push_str("$$");
            continue;
        }
        if c == '\\' {
            if let Some(&d) = chars.peek() {
                if d.is_ascii_digit() {
                    out.push('$');
                    out.push(chars.next().unwrap());
                    continue;
                }
            }
        }
        out.push(c);
    }
    out
}

fn apply_scoped(buf: &mut Vec<u8>, from: usize, to: usize, pat: &Regex, rep: &str) -> usize {
    let region = match std::str::from_utf8(&buf[from..to]) {
        Ok(s) => s.to_owned(),
        Err(_) => return to,
    };
    let replaced = pat.replace_all(&region, rep);
    let new_bytes = replaced.as_bytes();
    let new_to = from + new_bytes.len();
    buf.splice(from..to, new_bytes.iter().copied());
    new_to
}

// syntax.rs `check`, without the error rendering.
fn syntax_errors(source: &str) -> Vec<String> {
    let alloc = Allocator::default();
    let ret = Parser::new(&alloc, source, SourceType::mjs()).parse();
    ret.errors.iter().map(|e| e.message.to_string()).collect()
}

// -----------------------------------------------------------------------------

struct Compiled {
    file_set: RegexSet,
    finds: Vec<Regex>,
    transforms: Vec<Vec<(Regex, String)>>,
}

/// Like PatchSet::build, except that every compile error is fatal: in
/// Millennium a bad `file` pattern drops every plugin's patches, and a bad
/// `find` or `match` is skipped with only a log line.
fn compile(input: &Input) -> Result<Compiled, String> {
    let files: Vec<&str> = input.patches.iter().map(|p| p.file.as_str()).collect();
    let file_set = RegexSet::new(&files).map_err(|e| format!("file pattern: {e}"))?;
    let mut finds = Vec::new();
    let mut transforms = Vec::new();
    for p in &input.patches {
        finds.push(Regex::new(&p.find).map_err(|e| format!("find {:?}: {e}", p.find))?);
        let mut ts = Vec::new();
        for t in &p.transforms {
            let re = Regex::new(&t.pattern).map_err(|e| format!("match {:?}: {e}", t.pattern))?;
            ts.push((re, re2_to_rust_rep(&expand_self(&t.replace, &input.plugin))));
        }
        transforms.push(ts);
    }
    Ok(Compiled { file_set, finds, transforms })
}

/// apply_patches for one patch of one plugin.
fn apply(c: &Compiled, index: usize, content: &str, filename: &str) -> String {
    if !c.file_set.matches(filename).matched(index) {
        return content.to_owned();
    }
    let m = match c.finds[index].find(content) {
        Some(m) => m,
        None => return content.to_owned(),
    };
    let mut buf = content.as_bytes().to_vec();
    let (from, mut to) = (m.start(), m.end());
    for (pat, rep) in &c.transforms[index] {
        to = apply_scoped(&mut buf, from, to, pat, rep);
    }
    String::from_utf8(buf).expect("patched output is UTF-8")
}

fn main() -> ExitCode {
    let path = match std::env::args().nth(1) {
        Some(p) => p,
        None => {
            eprintln!("usage: patch-crosscheck <cases.json>");
            return ExitCode::from(2);
        }
    };
    let text = std::fs::read_to_string(&path).expect("read cases file");
    let input: Input = serde_json::from_str(&text).expect("parse cases file");

    let compiled = match compile(&input) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("FAIL: does not compile with the Rust regex crate: {e}");
            return ExitCode::FAILURE;
        }
    };

    let mut failures = 0;
    for case in &input.cases {
        let got = apply(&compiled, case.patch, &case.input, &case.filename);
        if got != case.expected {
            failures += 1;
            eprintln!("FAIL {}: Rust output differs from the bun harness", case.label);
            eprintln!("  rust: {got}");
            eprintln!("  bun:  {}", case.expected);
        }
        // A fixture that oxc cannot parse would not tell us anything about Steam.
        if case.filename.ends_with(".js") {
            let input_errors = syntax_errors(&case.input);
            if !input_errors.is_empty() {
                failures += 1;
                eprintln!("FAIL {}: fixture does not parse as an ES module: {:?}", case.label, input_errors);
            }
        }
        // Millennium would revert the whole file, dropping every plugin's patches to it.
        if got != case.input {
            let errors = syntax_errors(&got);
            if !errors.is_empty() {
                failures += 1;
                eprintln!("FAIL {}: patched output fails Millennium's oxc check: {:?}", case.label, errors);
            }
        }
    }
    for mc in &input.matches {
        let re = match Regex::new(&mc.pattern) {
            Ok(r) => r,
            Err(e) => {
                failures += 1;
                eprintln!("FAIL /{}/ accepted by the harness but not by Rust: {e}", mc.pattern);
                continue;
            }
        };
        let got: Vec<String> = re.find_iter(&mc.text).map(|m| m.as_str().to_owned()).collect();
        if got != mc.expected {
            failures += 1;
            eprintln!("FAIL /{}/ on {:?}: rust {:?}, bun {:?}", mc.pattern, mc.text, got, mc.expected);
        }
    }

    println!(
        "{} patch case(s), {} match case(s), {} failure(s)",
        input.cases.len(),
        input.matches.len(),
        failures
    );
    if failures == 0 {
        ExitCode::SUCCESS
    } else {
        ExitCode::FAILURE
    }
}
