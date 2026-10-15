//! Syntax highlighting with tree-sitter grammars, chosen by file name or a
//! `#!` line, with plain text for anything without one. Each language's
//! highlighting setup is built the first time it's needed.

use std::path::Path;
use std::sync::OnceLock;

use tree_sitter_highlight::{HighlightConfiguration, HighlightEvent, Highlighter};

/// What a piece of code is, for colouring. Themes map these to colours.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Kind {
    Keyword,
    String,
    Comment,
    Number,
    Function,
    Type,
    Constant,
    Variable,
    Property,
    Operator,
    Punctuation,
    Tag,
    Attribute,
    Escape,
    Module,
    Plain,
}

/// The capture names asked of every grammar's highlight query, and what
/// each means. Longest names first doesn't matter: tree-sitter matches the
/// most specific configured name itself.
const NAMES: &[(&str, Kind)] = &[
    ("attribute", Kind::Attribute),
    ("boolean", Kind::Constant),
    ("character", Kind::String),
    ("comment", Kind::Comment),
    ("constant", Kind::Constant),
    ("constant.builtin", Kind::Constant),
    ("constructor", Kind::Type),
    ("escape", Kind::Escape),
    ("float", Kind::Number),
    ("function", Kind::Function),
    ("function.builtin", Kind::Function),
    ("function.macro", Kind::Function),
    ("function.method", Kind::Function),
    ("keyword", Kind::Keyword),
    ("label", Kind::Attribute),
    ("method", Kind::Function),
    ("module", Kind::Module),
    ("namespace", Kind::Module),
    ("number", Kind::Number),
    ("operator", Kind::Operator),
    ("property", Kind::Property),
    ("punctuation", Kind::Punctuation),
    ("punctuation.bracket", Kind::Punctuation),
    ("punctuation.delimiter", Kind::Punctuation),
    ("punctuation.special", Kind::Operator),
    ("string", Kind::String),
    ("string.special", Kind::String),
    ("string.escape", Kind::Escape),
    ("tag", Kind::Tag),
    ("type", Kind::Type),
    ("type.builtin", Kind::Type),
    ("variable", Kind::Variable),
    ("variable.builtin", Kind::Keyword),
    ("variable.parameter", Kind::Variable),
];

/// A language OXIS can highlight.
pub struct Language {
    pub name: &'static str,
    extensions: &'static [&'static str],
    /// Whole file names (Makefile-style) that mean this language.
    files: &'static [&'static str],
    /// Words in a `#!` line that mean this language.
    shebang: &'static [&'static str],
    build: fn() -> Option<HighlightConfiguration>,
    config: OnceLock<Option<HighlightConfiguration>>,
}

impl Language {
    fn config(&self) -> Option<&HighlightConfiguration> {
        self.config
            .get_or_init(|| {
                let mut c = (self.build)()?;
                let names: Vec<&str> = NAMES.iter().map(|(n, _)| *n).collect();
                c.configure(&names);
                Some(c)
            })
            .as_ref()
    }

    /// Whether this language's grammar and queries load.
    pub fn works(&self) -> bool {
        self.config().is_some()
    }
}

macro_rules! lang {
    ($name:expr, [$($ext:expr),*], [$($file:expr),*], [$($sb:expr),*], $build:expr) => {
        Language { name: $name, extensions: &[$($ext),*], files: &[$($file),*], shebang: &[$($sb),*], build: $build, config: OnceLock::new() }
    };
}

fn cfg(lang: tree_sitter_language::LanguageFn, name: &str, highlights: &str) -> Option<HighlightConfiguration> {
    match HighlightConfiguration::new(lang.into(), name, highlights, "", "") {
        Ok(c) => Some(c),
        Err(e) => {
            eprintln!("oxide-editor: the {name} highlighting queries didn't load: {e}");
            None
        }
    }
}

/// Every language, in the order they're checked.
pub fn languages() -> &'static [Language] {
    static ALL: OnceLock<Vec<Language>> = OnceLock::new();
    ALL.get_or_init(|| {
        vec![
            lang!("Rust", ["rs"], [], [], || cfg(tree_sitter_rust::LANGUAGE, "rust", tree_sitter_rust::HIGHLIGHTS_QUERY)),
            lang!("JavaScript", ["js", "mjs", "cjs", "jsx"], [], ["node"], || cfg(
                tree_sitter_javascript::LANGUAGE,
                "javascript",
                &format!("{}\n{}", tree_sitter_javascript::JSX_HIGHLIGHT_QUERY, tree_sitter_javascript::HIGHLIGHT_QUERY)
            )),
            lang!("TypeScript", ["ts", "mts", "cts"], [], ["deno", "ts-node"], || cfg(
                tree_sitter_typescript::LANGUAGE_TYPESCRIPT,
                "typescript",
                &format!("{}\n{}", tree_sitter_typescript::HIGHLIGHTS_QUERY, tree_sitter_javascript::HIGHLIGHT_QUERY)
            )),
            lang!("TSX", ["tsx"], [], [], || cfg(
                tree_sitter_typescript::LANGUAGE_TSX,
                "tsx",
                &format!(
                    "{}\n{}\n{}",
                    tree_sitter_javascript::JSX_HIGHLIGHT_QUERY,
                    tree_sitter_typescript::HIGHLIGHTS_QUERY,
                    tree_sitter_javascript::HIGHLIGHT_QUERY
                )
            )),
            lang!("Python", ["py", "pyw", "pyi"], [], ["python", "python3"], || cfg(
                tree_sitter_python::LANGUAGE,
                "python",
                tree_sitter_python::HIGHLIGHTS_QUERY
            )),
            lang!("Go", ["go"], [], [], || cfg(tree_sitter_go::LANGUAGE, "go", tree_sitter_go::HIGHLIGHTS_QUERY)),
            lang!("C", ["c", "h"], [], [], || cfg(tree_sitter_c::LANGUAGE, "c", tree_sitter_c::HIGHLIGHT_QUERY)),
            lang!("C++", ["cpp", "cc", "cxx", "hpp", "hh", "hxx", "ino"], [], [], || cfg(
                tree_sitter_cpp::LANGUAGE,
                "cpp",
                &format!("{}\n{}", tree_sitter_cpp::HIGHLIGHT_QUERY, tree_sitter_c::HIGHLIGHT_QUERY)
            )),
            lang!("C#", ["cs", "csx"], [], [], || cfg(tree_sitter_c_sharp::LANGUAGE, "c_sharp", tree_sitter_c_sharp::HIGHLIGHTS_QUERY)),
            lang!("Java", ["java"], [], [], || cfg(tree_sitter_java::LANGUAGE, "java", tree_sitter_java::HIGHLIGHTS_QUERY)),
            lang!("JSON", ["json", "jsonc", "json5"], [".prettierrc", ".eslintrc"], [], || cfg(
                tree_sitter_json::LANGUAGE,
                "json",
                tree_sitter_json::HIGHLIGHTS_QUERY
            )),
            lang!("HTML", ["html", "htm", "xhtml"], [], [], || cfg(tree_sitter_html::LANGUAGE, "html", tree_sitter_html::HIGHLIGHTS_QUERY)),
            lang!("CSS", ["css"], [], [], || cfg(tree_sitter_css::LANGUAGE, "css", tree_sitter_css::HIGHLIGHTS_QUERY)),
            lang!(
                "Shell",
                ["sh", "bash", "zsh", "ksh"],
                [".bashrc", ".bash_profile", ".zshrc", ".profile", "PKGBUILD"],
                ["sh", "bash", "zsh", "ksh", "dash"],
                || cfg(tree_sitter_bash::LANGUAGE, "bash", tree_sitter_bash::HIGHLIGHT_QUERY)
            ),
            lang!("TOML", ["toml"], ["Cargo.lock", "Pipfile", "poetry.lock"], [], || cfg(
                tree_sitter_toml_ng::LANGUAGE,
                "toml",
                tree_sitter_toml_ng::HIGHLIGHTS_QUERY
            )),
            lang!("YAML", ["yml", "yaml"], [".clang-format"], [], || cfg(tree_sitter_yaml::LANGUAGE, "yaml", tree_sitter_yaml::HIGHLIGHTS_QUERY)),
        ]
    })
}

/// The language for a file, by its name and then its first line.
pub fn detect(path: Option<&Path>, first_line: &str) -> Option<&'static Language> {
    let all = languages();
    if let Some(path) = path {
        let name = path.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if let Some(l) = all.iter().find(|l| l.files.contains(&name)) {
            return Some(l);
        }
        if let Some(ext) = path.extension().and_then(|e| e.to_str()).map(|e| e.to_ascii_lowercase()) {
            if let Some(l) = all.iter().find(|l| l.extensions.contains(&ext.as_str())) {
                return Some(l);
            }
        }
    }
    // `#!/usr/bin/env python3`, `#!/bin/bash`.
    let line = first_line.strip_prefix("#!")?;
    let words: Vec<&str> = line.split(|c: char| c == '/' || c.is_whitespace()).filter(|w| !w.is_empty() && *w != "env").collect();
    let prog = words.iter().find(|w| !w.starts_with('-') && !["usr", "bin", "local"].contains(w))?;
    all.iter().find(|l| l.shebang.contains(prog))
}

/// A run of one kind in a line: columns (in characters) `start..end`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Span {
    pub start: usize,
    pub end: usize,
    pub kind: Kind,
}

/// Files bigger than this are shown plain: highlighting the whole text on
/// each change would make typing lag.
pub const MAX_BYTES: usize = 2 * 1024 * 1024;

/// The highlighted spans of `text`, line by line (plain stretches left
/// out). `None` if the language's grammar didn't load or the text is too
/// big; then it's shown plain.
pub fn highlight(lang: &Language, text: &str) -> Option<Vec<Vec<Span>>> {
    if text.len() > MAX_BYTES {
        return None;
    }
    let config = lang.config()?;
    let mut hl = Highlighter::new();
    let events = hl.highlight(config, text.as_bytes(), None, |_| None).ok()?;
    let mut lines: Vec<Vec<Span>> = vec![Vec::new()];
    let mut stack: Vec<Kind> = Vec::new();
    let (mut line, mut col) = (0usize, 0usize);
    for event in events {
        match event.ok()? {
            HighlightEvent::HighlightStart(h) => stack.push(NAMES.get(h.0).map(|(_, k)| *k).unwrap_or(Kind::Plain)),
            HighlightEvent::HighlightEnd => {
                stack.pop();
            }
            HighlightEvent::Source { start, end } => {
                let kind = stack.last().copied().unwrap_or(Kind::Plain);
                let mut span_start = col;
                for ch in text[start..end].chars() {
                    if ch == '\n' {
                        if kind != Kind::Plain && col > span_start {
                            lines[line].push(Span { start: span_start, end: col, kind });
                        }
                        line += 1;
                        col = 0;
                        span_start = 0;
                        lines.push(Vec::new());
                    } else if ch != '\r' {
                        col += 1;
                    }
                }
                if kind != Kind::Plain && col > span_start {
                    lines[line].push(Span { start: span_start, end: col, kind });
                }
            }
        }
    }
    Some(lines)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_language_loads() {
        for l in languages() {
            assert!(l.works(), "{} didn't load", l.name);
        }
        assert!(languages().len() >= 15);
    }

    #[test]
    fn languages_are_found_by_name_and_first_line() {
        let name = |p: &str| detect(Some(Path::new(p)), "").map(|l| l.name);
        assert_eq!(name("src/main.rs"), Some("Rust"));
        assert_eq!(name("App.TSX"), Some("TSX"));
        assert_eq!(name("Cargo.lock"), Some("TOML"));
        assert_eq!(name(".bashrc"), Some("Shell"));
        assert_eq!(name("notes.txt"), None);
        assert_eq!(detect(Some(Path::new("deploy")), "#!/usr/bin/env python3").map(|l| l.name), Some("Python"));
        assert_eq!(detect(None, "#!/bin/bash -e").map(|l| l.name), Some("Shell"));
        assert!(detect(None, "plain text").is_none());
    }

    #[test]
    fn code_is_highlighted_by_kind() {
        let rust = detect(Some(Path::new("a.rs")), "").unwrap();
        let lines = highlight(rust, "// hi\nfn main() {\n    let s = \"x\"; 42\n}\n").unwrap();
        let kind_at = |line: usize, col: usize| lines[line].iter().find(|s| s.start <= col && col < s.end).map(|s| s.kind);
        assert_eq!(kind_at(0, 0), Some(Kind::Comment));
        assert_eq!(kind_at(1, 0), Some(Kind::Keyword), "fn");
        assert_eq!(kind_at(1, 3), Some(Kind::Function), "main");
        assert_eq!(kind_at(2, 12), Some(Kind::String));
        // The Rust grammar tags numbers as built-in constants.
        assert!(matches!(kind_at(2, 17), Some(Kind::Number | Kind::Constant)));
        let py = detect(Some(Path::new("a.py")), "").unwrap();
        let lines = highlight(py, "def f(x):\n    return 'y'\n").unwrap();
        assert_eq!(lines[0][0].kind, Kind::Keyword);
    }
}
