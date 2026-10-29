//! src-tauri\src\rules\generate\mod.rs — agent-generated runes, the path an agent's reply must pass before it
//! can land. `envelope` parses the reply strictly
//! (every error collected) and adds the coverage and modal warnings; `render` turns it into rune files, the
//! generated set and `generate.json`, with `items` adding ticked local skills, agents and hooks as item runes;
//! `validate` builds the rendered library from a temp folder the way a Bare spawn would and splits structural errors
//! (nothing lands) from advisory size. The skill the agent runs under is `profiles/bare/rune-create/SKILL.md`;
//! `input_text` is the stdin form it documents. `land` writes a prepared library and nothing else. `chunk` splits the input into the parts
//! one call reads, `merge` joins the chunk envelopes, `pipeline` and `progress` schedule the calls and report them,
//! and `commands` runs it all (the `rules_generate*` IPC commands).
#![cfg_attr(not(test), allow(dead_code))] // `execute`, `Span::whole` and a few helpers are test-only callers.

pub mod chunk;
pub mod commands;
pub mod envelope;
pub mod home;
pub mod items;
pub mod land;
pub mod login_back;
pub mod merge;
pub mod payload;
pub mod pipeline;
pub mod progress;
pub mod render;
pub mod run;
pub mod validate;

/// One input file as the agent saw it: the `~` path it is cited by and its text.
#[derive(Clone, Debug)]
pub struct Input {
    pub path: String,
    pub text: String,
}

impl Input {
    /// Lines as the agent saw them numbered (CRLF tolerated, a final newline adds no line).
    pub fn lines(&self) -> Vec<&str> {
        self.text.lines().collect()
    }
}

/// Lines `first..=last` (1-based) of one input, as one call sees them; `total` is the file's line count.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Span {
    pub path: String,
    pub first: usize,
    pub last: usize,
    pub total: usize,
}

impl Span {
    /// Every line of `input`.
    pub fn whole(input: &Input) -> Span {
        let total = input.lines().len();
        Span { path: input.path.clone(), first: 1, last: total, total }
    }

    fn is_whole(&self) -> bool {
        self.first == 1 && self.last == self.total
    }
}

/// One numbered line as the agent sees it (`L<n>: text`, no trailing space on a blank line).
fn rendered_line(n: usize, l: &str) -> String {
    let l = l.trim_end();
    if l.is_empty() {
        format!("L{n}:\n")
    } else {
        format!("L{n}: {l}\n")
    }
}

/// The user message the skill's § Input describes: target agent, then each file headed by its `~` path
/// and line count with every line `L<n>:`-prefixed.
pub fn input_text(inputs: &[Input], agent: &str) -> String {
    let spans: Vec<Span> = inputs.iter().map(Span::whole).collect();
    chunk_text(inputs, &spans, agent)
}

/// The same message for the parts of files one call gets. A whole file renders as `input_text` does; a part is
/// headed `(lines a-b of n)`, keeps the original `L<n>` numbers, and one that starts mid-file carries its ancestor
/// headings as a non-citable `Context:` line right after the header.
pub fn chunk_text(inputs: &[Input], spans: &[Span], agent: &str) -> String {
    let mut out = format!("Target agent: {agent}\n");
    for s in spans {
        let Some(input) = inputs.iter().find(|i| i.path == s.path) else { continue };
        if s.is_whole() {
            out.push_str(&format!("\n=== FILE {} ({} lines)\n", s.path, s.total));
        } else {
            out.push_str(&format!("\n=== FILE {} (lines {}-{} of {})\n", s.path, s.first, s.last, s.total));
            let context = chunk::context(input, s.first);
            if !context.is_empty() {
                out.push_str(&format!("Context: {}\n", context.join(" \u{203a} ")));
            }
        }
        let lines = input.lines();
        for n in s.first..=s.last.min(lines.len()) {
            out.push_str(&rendered_line(n, lines[n - 1]));
        }
        out.push_str("=== END\n");
    }
    out
}

/// What a reply that passed becomes: the files to land (paths relative to the library folder, `/` separators,
/// `generate.json` last), the counts the IPC reports and the advisory lines.
#[derive(Debug)]
pub struct Prepared {
    pub files: Vec<(String, String)>,
    pub runes: usize,
    pub on: usize,
    pub encoded_chars: Option<usize>,
    pub warnings: Vec<String>,
    pub manifest: render::GenerateJson,
}

/// Reply → envelope → rendered library → validated. `Err` holds every structural error (Output Rejected);
/// the Codex payload size shows in `Prepared` as `encoded_chars`; there is no cap (E5).
pub fn prepare(
    reply: &str,
    inputs: &[Input],
    meta: &render::Meta,
    payload: &validate::PayloadCtx,
) -> Result<Prepared, Vec<String>> {
    let env = envelope::parse(reply, inputs)?;
    prepare_envelope(&env, inputs, meta, payload)
}

/// An already-checked envelope → rendered library → validated; what `prepare` does after parsing, so a merged
/// envelope takes the same path.
pub fn prepare_envelope(
    env: &envelope::Envelope,
    inputs: &[Input],
    meta: &render::Meta,
    payload: &validate::PayloadCtx,
) -> Result<Prepared, Vec<String>> {
    let mut warnings = envelope::warnings(env, inputs);
    let rendered = render::render(env, inputs, meta)?;
    let checked = validate::validate(&rendered, meta, payload);
    if !checked.structural.is_empty() {
        return Err(checked.structural);
    }
    warnings.extend(checked.warnings);
    let mut manifest = rendered.manifest;
    manifest.warnings = warnings.clone();
    manifest.encoded_chars = checked.encoded_chars;
    let mut files = rendered.files;
    files.push(("generate.json".into(), render::generate_json_text(&manifest)));
    Ok(Prepared {
        files,
        runes: env.runes.len(),
        on: rendered.on.len(),
        encoded_chars: checked.encoded_chars,
        warnings,
        manifest,
    })
}
