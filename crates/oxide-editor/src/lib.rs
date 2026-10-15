//! Text documents for the OXIDE Engine.
//!
//! A [`Document`] is one file's text: opened in whatever encoding and line
//! ending it was written with, edited, and saved back the same way. Text is
//! kept with `\n` line endings internally; the file's own ending is put
//! back on save. Edits go through one function, so undo, redo and the
//! "modified" mark always agree with the text.
//!
//! - [`Document::open`] and [`Document::save`] — encodings (UTF-8, with or
//!   without a BOM, UTF-16 LE/BE, and Windows-1252 for files that aren't
//!   valid UTF-8), line endings (LF, CRLF), binary files refused.
//! - Editing: [`Document::insert`], [`Document::backspace`],
//!   [`Document::delete`], with a selection and a cursor that moves by
//!   character, word, line and page.
//! - [`Document::undo`] and [`Document::redo`], typing grouped into words.
//! - [`Document::find`] and [`Document::replace_all`].
//! - Indentation detected from the file and kept when pressing Enter.

mod document;
mod encoding;

pub use document::{Cursor, Document, Indent, Movement, Range};
pub use encoding::{Encoding, LineEnding};

/// What can go wrong opening or saving a document.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("couldn't read {path}: {source}")]
    Read {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("couldn't save {path}: {source}")]
    Write {
        path: std::path::PathBuf,
        #[source]
        source: std::io::Error,
    },
    #[error("{0} looks like a binary file, not text")]
    Binary(std::path::PathBuf),
    #[error("{path} is {size} MB; files over {limit} MB aren't opened as text")]
    TooLarge { path: std::path::PathBuf, size: u64, limit: u64 },
    #[error("this document has no file yet; save it somewhere first")]
    NoPath,
}

pub type Result<T, E = Error> = std::result::Result<T, E>;
