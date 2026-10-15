//! Reading and writing text in the encodings and line endings files use.

/// How a file's bytes become text.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Encoding {
    Utf8,
    /// UTF-8 with a byte-order mark at the start (common on Windows).
    Utf8Bom,
    Utf16Le,
    Utf16Be,
    /// Files that aren't valid UTF-8 are read as Windows-1252 (a superset
    /// of Latin-1), so every byte means something and saving writes the
    /// same bytes back.
    Windows1252,
}

impl Encoding {
    pub fn label(self) -> &'static str {
        match self {
            Encoding::Utf8 => "UTF-8",
            Encoding::Utf8Bom => "UTF-8 with BOM",
            Encoding::Utf16Le => "UTF-16 LE",
            Encoding::Utf16Be => "UTF-16 BE",
            Encoding::Windows1252 => "Windows-1252",
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LineEnding {
    Lf,
    CrLf,
}

impl LineEnding {
    pub fn label(self) -> &'static str {
        match self {
            LineEnding::Lf => "LF",
            LineEnding::CrLf => "CRLF",
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            LineEnding::Lf => "\n",
            LineEnding::CrLf => "\r\n",
        }
    }

    /// The platform's usual ending, for new files.
    pub fn native() -> Self {
        if cfg!(windows) {
            LineEnding::CrLf
        } else {
            LineEnding::Lf
        }
    }
}

/// Bytes to text: the encoding found, or `None` if they look binary.
pub fn decode(bytes: &[u8]) -> Option<(String, Encoding)> {
    if let Some(rest) = bytes.strip_prefix(&[0xEF, 0xBB, 0xBF]) {
        return Some((String::from_utf8_lossy(rest).into_owned(), Encoding::Utf8Bom));
    }
    if bytes.starts_with(&[0xFF, 0xFE]) {
        let (text, _, _) = encoding_rs::UTF_16LE.decode(bytes);
        return Some((text.into_owned(), Encoding::Utf16Le));
    }
    if bytes.starts_with(&[0xFE, 0xFF]) {
        let (text, _, _) = encoding_rs::UTF_16BE.decode(bytes);
        return Some((text.into_owned(), Encoding::Utf16Be));
    }
    // A NUL byte early on means it isn't text (in an encoding without a
    // BOM, which is all that's left).
    if bytes.iter().take(8192).any(|b| *b == 0) {
        return None;
    }
    match std::str::from_utf8(bytes) {
        Ok(s) => Some((s.to_owned(), Encoding::Utf8)),
        Err(_) => {
            let (text, _, _) = encoding_rs::WINDOWS_1252.decode(bytes);
            Some((text.into_owned(), Encoding::Windows1252))
        }
    }
}

/// Text to bytes in `encoding`.
pub fn encode(text: &str, encoding: Encoding) -> Vec<u8> {
    match encoding {
        Encoding::Utf8 => text.as_bytes().to_vec(),
        Encoding::Utf8Bom => [&[0xEF, 0xBB, 0xBF][..], text.as_bytes()].concat(),
        Encoding::Utf16Le => [0xFF, 0xFE].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_le_bytes())).collect(),
        Encoding::Utf16Be => [0xFE, 0xFF].into_iter().chain(text.encode_utf16().flat_map(|u| u.to_be_bytes())).collect(),
        Encoding::Windows1252 => encoding_rs::WINDOWS_1252.encode(text).0.into_owned(),
    }
}

/// The line ending used most in `text` (LF if there are none), and the
/// text with every ending turned into `\n`.
pub fn normalize(text: &str) -> (String, LineEnding) {
    let crlf = text.matches("\r\n").count();
    let lf = text.matches('\n').count() - crlf;
    let ending = if crlf > lf {
        LineEnding::CrLf
    } else if lf == 0 && crlf == 0 {
        LineEnding::native()
    } else {
        LineEnding::Lf
    };
    // Lone CRs (old Mac files) become line breaks too.
    (text.replace("\r\n", "\n").replace('\r', "\n"), ending)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_every_encoding() {
        let text = "héllo, wörld — ✓\n";
        for enc in [Encoding::Utf8, Encoding::Utf8Bom, Encoding::Utf16Le, Encoding::Utf16Be] {
            let bytes = encode(text, enc);
            assert_eq!(decode(&bytes), Some((text.to_owned(), enc)), "{enc:?}");
        }
        let latin = encode("café", Encoding::Windows1252);
        assert_eq!(latin, b"caf\xe9");
        assert_eq!(decode(&latin), Some(("café".to_owned(), Encoding::Windows1252)));
    }

    #[test]
    fn binary_is_refused() {
        assert_eq!(decode(b"\x7fELF\x02\x01\x01\x00\x00"), None);
        assert!(decode(b"").is_some());
    }

    #[test]
    fn line_endings_are_found_and_normalised() {
        assert_eq!(normalize("a\r\nb\r\nc\n"), ("a\nb\nc\n".to_owned(), LineEnding::CrLf));
        assert_eq!(normalize("a\nb\n"), ("a\nb\n".to_owned(), LineEnding::Lf));
        assert_eq!(normalize("a\rb").0, "a\nb");
    }
}
