//! Documents against real files: what's read is what's written back.

use oxide_editor::{Document, Encoding, Error, Indent, LineEnding, Movement, Range};

fn file(dir: &std::path::Path, name: &str, bytes: &[u8]) -> std::path::PathBuf {
    let p = dir.join(name);
    std::fs::write(&p, bytes).unwrap();
    p
}

#[test]
fn files_save_back_byte_for_byte() {
    let dir = tempfile::tempdir().unwrap();
    let cases: Vec<(&str, Vec<u8>)> = vec![
        ("lf.rs", b"fn main() {\n    println!(\"hi\");\n}\n".to_vec()),
        ("crlf.txt", b"one\r\ntwo\r\n".to_vec()),
        ("bom.cs", b"\xEF\xBB\xBFclass A {}\r\n".to_vec()),
        ("utf16.txt", [0xFF, 0xFE].into_iter().chain("h\u{e9}\n".encode_utf16().flat_map(|u| u.to_le_bytes())).collect()),
        ("latin1.txt", b"caf\xe9\n".to_vec()),
        ("no-newline.md", b"# Title".to_vec()),
        ("empty.txt", Vec::new()),
    ];
    for (name, bytes) in &cases {
        let p = file(dir.path(), name, bytes);
        let mut doc = Document::open(&p).unwrap();
        assert!(!doc.is_modified());
        doc.save().unwrap();
        assert_eq!(&std::fs::read(&p).unwrap(), bytes, "{name} changed on a save without edits");
    }
}

#[test]
fn encodings_and_line_endings_are_recognised() {
    let dir = tempfile::tempdir().unwrap();
    let doc = Document::open(file(dir.path(), "a", b"x\r\ny\r\n")).unwrap();
    assert_eq!((doc.encoding, doc.line_ending), (Encoding::Utf8, LineEnding::CrLf));
    assert_eq!(doc.text(), "x\ny\n", "kept with \\n inside");
    let doc = Document::open(file(dir.path(), "b", b"\xEF\xBB\xBFx")).unwrap();
    assert_eq!(doc.encoding, Encoding::Utf8Bom);
    let doc = Document::open(file(dir.path(), "c", b"na\xefve")).unwrap();
    assert_eq!((doc.encoding, doc.text().as_str()), (Encoding::Windows1252, "naïve"));
    assert!(matches!(Document::open(file(dir.path(), "d.bin", b"\x00\x01\x02\x03")), Err(Error::Binary(_))));
    assert!(matches!(Document::open(dir.path().join("missing")), Err(Error::Read { .. })));
}

#[test]
fn edits_are_saved_in_the_files_own_line_ending() {
    let dir = tempfile::tempdir().unwrap();
    let p = file(dir.path(), "win.txt", b"a\r\nb\r\n");
    let mut doc = Document::open(&p).unwrap();
    doc.set_cursor(doc.pos(1, 1), false);
    doc.insert("\n");
    doc.insert("c");
    assert!(doc.is_modified());
    doc.save().unwrap();
    assert_eq!(std::fs::read(&p).unwrap(), b"a\r\nb\r\nc\r\n");
    assert!(!doc.is_modified());
    // No leftover temporary file.
    assert_eq!(std::fs::read_dir(dir.path()).unwrap().count(), 1);
}

#[test]
fn typing_undoes_by_word_and_redoes() {
    let mut doc = Document::from_text("");
    for c in "hello".chars() {
        doc.insert(&c.to_string());
    }
    doc.insert(" ");
    for c in "world".chars() {
        doc.insert(&c.to_string());
    }
    assert_eq!(doc.text(), "hello world");
    assert!(doc.undo());
    assert_eq!(doc.text(), "hello ", "the last word goes in one step");
    assert!(doc.undo());
    assert_eq!(doc.text(), "hello");
    assert!(doc.undo());
    assert_eq!(doc.text(), "");
    assert!(!doc.undo());
    assert!(doc.redo() && doc.redo() && doc.redo());
    assert_eq!(doc.text(), "hello world");
    assert_eq!(doc.cursor.head, 11);
    // A new edit clears what could be redone.
    doc.undo();
    doc.insert("!");
    assert!(!doc.can_redo());
    // Undoing back to the saved text clears the modified mark.
    let mut doc = Document::from_text("x");
    doc.insert("y");
    assert!(doc.is_modified());
    doc.undo();
    assert!(doc.is_modified(), "the version moved on; an exact return isn't tracked");
}

#[test]
fn enter_keeps_indentation_and_tab_follows_the_file() {
    let mut doc = Document::from_text("fn a() {\n    let x = 1;\n}\n");
    assert_eq!(doc.indent, Indent::Spaces(4));
    doc.set_cursor(doc.pos(1, usize::MAX), false);
    doc.insert("\n");
    doc.insert("y");
    assert_eq!(doc.line(2), "    y");
    // Backspace in leading spaces goes back a whole stop.
    doc.set_cursor(doc.pos(2, 4), false);
    doc.backspace();
    assert_eq!(doc.line(2), "y");
    doc.tab();
    assert_eq!(doc.line(2), "    y");

    let tabs = Document::from_text("a\n\tb\n\tc\n");
    assert_eq!(tabs.indent, Indent::Tabs);
    let two = Document::from_text("a:\n  b:\n    c: 1\n  d: 2\n");
    assert_eq!(two.indent, Indent::Spaces(2));
}

#[test]
fn selected_lines_indent_and_outdent_together() {
    let mut doc = Document::from_text("a\nb\nc\n");
    doc.select(Range::new(0, doc.pos(1, 1)));
    doc.indent_lines(true);
    assert_eq!(doc.text(), "    a\n    b\nc\n");
    doc.indent_lines(false);
    assert_eq!(doc.text(), "a\nb\nc\n");
    doc.undo();
    assert_eq!(doc.text(), "    a\n    b\nc\n");
}

#[test]
fn the_cursor_moves_by_character_word_and_line() {
    let mut doc = Document::from_text("let value = 42;\nx\n    indented line here\n");
    doc.move_cursor(Movement::WordRight, false);
    assert_eq!(doc.cursor.head, 4, "past `let` and the space");
    doc.move_cursor(Movement::WordRight, true);
    assert_eq!(doc.selected_text(), "value ");
    doc.move_cursor(Movement::Left, false);
    assert_eq!(doc.cursor.head, 4, "Left collapses a selection to its start");
    // Down through a short line keeps the column it aims for.
    doc.set_cursor(doc.pos(0, 10), false);
    doc.move_cursor(Movement::Down, false);
    assert_eq!(doc.line_col(doc.cursor.head), (1, 1));
    doc.move_cursor(Movement::Down, false);
    assert_eq!(doc.line_col(doc.cursor.head), (2, 10));
    // Home goes to the first non-blank, then to column 0.
    doc.move_cursor(Movement::LineStart, false);
    assert_eq!(doc.line_col(doc.cursor.head), (2, 4));
    doc.move_cursor(Movement::LineStart, false);
    assert_eq!(doc.line_col(doc.cursor.head), (2, 0));
    doc.move_cursor(Movement::DocEnd, false);
    assert_eq!(doc.cursor.head, doc.len_chars());
}

#[test]
fn backspace_and_delete_take_whole_characters() {
    // é written as e + a combining accent is one character to the user.
    let mut doc = Document::from_text("cafe\u{301}!");
    doc.set_cursor(5, false);
    doc.backspace();
    assert_eq!(doc.text(), "caf!");
    doc.set_cursor(0, false);
    doc.delete();
    assert_eq!(doc.text(), "af!");
    // Joining lines.
    let mut doc = Document::from_text("a\nb");
    doc.set_cursor(2, false);
    doc.backspace();
    assert_eq!(doc.text(), "ab");
}

#[test]
fn find_and_replace() {
    let mut doc = Document::from_text("Foo foo FOO bar");
    assert_eq!(doc.find("foo", false).len(), 3);
    assert_eq!(doc.find("foo", true), vec![Range { start: 4, end: 7 }]);
    assert_eq!(doc.replace_all("foo", "baz", false), 3);
    assert_eq!(doc.text(), "baz baz baz bar");
    doc.undo();
    assert_eq!(doc.text(), "Foo foo FOO bar", "replace-all undoes in one step");
    assert_eq!(doc.replace_all("nothing", "x", false), 0);
}

#[test]
fn cut_and_select_all() {
    let mut doc = Document::from_text("one two");
    doc.select(Range::new(0, 4));
    assert_eq!(doc.cut(), "one ");
    assert_eq!(doc.text(), "two");
    doc.select_all();
    doc.insert("three");
    assert_eq!(doc.text(), "three");
}

#[test]
fn a_new_document_saves_where_asked() {
    let dir = tempfile::tempdir().unwrap();
    let mut doc = Document::from_text("");
    doc.insert("new");
    doc.insert("\n");
    assert!(matches!(doc.save(), Err(Error::NoPath)));
    let p = dir.path().join("new.txt");
    doc.save_as(&p).unwrap();
    assert_eq!(doc.title(), "new.txt");
    let want: &[u8] = if cfg!(windows) { b"new\r\n" } else { b"new\n" };
    assert_eq!(std::fs::read(&p).unwrap(), want, "a new file gets the platform's line ending");
}
