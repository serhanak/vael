//! Encoding / BOM / EOL core (PLAN.md §6.c, docs/design/03-encoding-io.md).
//!
//! One deterministic name↔byte table, no silent rewrites. This is the
//! structural counter-example to Notepad++'s BOM bugs: the encoding *label*
//! and the *BOM flag* are always separate inputs (`label` + `add_bom`), so the
//! "Convert to UTF-8 produced a BOM" class of bug is impossible by construction.
//!
//! Kept Tauri-free so it can be unit-tested without a WebView.

use std::borrow::Cow;

use encoding_rs::{
    Encoding, BIG5, EUC_KR, GBK, ISO_8859_15, SHIFT_JIS, UTF_16BE, UTF_16LE, UTF_8, WINDOWS_1250,
    WINDOWS_1251, WINDOWS_1252, WINDOWS_1254, WINDOWS_1256,
};

// ---------------------------------------------------------------------------
// BOM
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Bom {
    None,
    Utf8,
    Utf16Le,
    Utf16Be,
    Utf32Le,
    Utf32Be,
}

/// Returns the detected BOM and the byte offset of the content after it.
///
/// Critical ordering: the UTF-32 LE BOM (`FF FE 00 00`) MUST be checked before
/// the UTF-16 LE BOM (`FF FE`), otherwise a UTF-32 LE file is misread as
/// UTF-16 LE followed by a NUL. Many editors (incl. Notepad++) fall into this.
pub fn sniff_bom(bytes: &[u8]) -> (Bom, usize) {
    match bytes {
        [0xFF, 0xFE, 0x00, 0x00, ..] => (Bom::Utf32Le, 4),
        [0x00, 0x00, 0xFE, 0xFF, ..] => (Bom::Utf32Be, 4),
        [0xEF, 0xBB, 0xBF, ..] => (Bom::Utf8, 3),
        [0xFF, 0xFE, ..] => (Bom::Utf16Le, 2),
        [0xFE, 0xFF, ..] => (Bom::Utf16Be, 2),
        _ => (Bom::None, 0),
    }
}

// ---------------------------------------------------------------------------
// EOL
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Eol {
    Lf,
    Crlf,
    Mixed,
}

impl Eol {
    pub fn from_label(s: &str) -> Eol {
        match s {
            "CRLF" => Eol::Crlf,
            "Mixed" => Eol::Mixed,
            _ => Eol::Lf,
        }
    }

    pub fn as_str(self) -> &'static str {
        match self {
            Eol::Lf => "LF",
            Eol::Crlf => "CRLF",
            Eol::Mixed => "Mixed",
        }
    }
}

pub fn detect_eol(s: &str) -> Eol {
    let crlf = s.matches("\r\n").count();
    let lf = s.matches('\n').count() - crlf; // bare \n only (exclude those in \r\n)
    match (crlf, lf) {
        (0, 0) => Eol::Lf, // no line breaks → treat as LF (new-file default family)
        (_, 0) => Eol::Crlf,
        (0, _) => Eol::Lf,
        _ => Eol::Mixed,
    }
}

/// Normalize line endings to the requested EOL. `Mixed` is left untouched
/// (we never silently "fix" a mixed file — the user is warned instead).
pub fn apply_eol(text: &str, eol: Eol) -> Cow<'_, str> {
    match eol {
        Eol::Mixed => Cow::Borrowed(text),
        Eol::Lf => {
            if text.contains('\r') {
                Cow::Owned(text.replace("\r\n", "\n").replace('\r', "\n"))
            } else {
                Cow::Borrowed(text)
            }
        }
        Eol::Crlf => {
            // Collapse to LF first to avoid turning existing CRLF into CR-CRLF.
            let lf = text.replace("\r\n", "\n").replace('\r', "\n");
            Cow::Owned(lf.replace('\n', "\r\n"))
        }
    }
}

// ---------------------------------------------------------------------------
// Label <-> Encoding (single deterministic table)
// ---------------------------------------------------------------------------

/// UI label → encoding_rs Encoding. `UTF-8` and `UTF-8-BOM` both map to UTF_8;
/// the BOM is decided by the separate `add_bom` flag, never the name.
pub fn encoding_for_label(label: &str) -> Option<&'static Encoding> {
    match label {
        "UTF-8" | "UTF-8-BOM" => Some(UTF_8),
        "UTF-16 LE" => Some(UTF_16LE),
        "UTF-16 BE" => Some(UTF_16BE),
        "Windows-1254" => Some(WINDOWS_1254),
        "Windows-1252" => Some(WINDOWS_1252),
        "Windows-1250" => Some(WINDOWS_1250),
        "Windows-1251" => Some(WINDOWS_1251),
        "Windows-1256" => Some(WINDOWS_1256),
        // WHATWG unifies ISO-8859-9 with windows-1254; we expose the canonical label.
        "ISO-8859-9" => Some(WINDOWS_1254),
        "ISO-8859-15" => Some(ISO_8859_15),
        "Shift_JIS" => Some(SHIFT_JIS),
        "GBK" => Some(GBK),
        "EUC-KR" => Some(EUC_KR),
        "Big5" => Some(BIG5),
        other => Encoding::for_label(other.as_bytes()),
    }
}

/// Whether a file in this encoding can be safely streamed by splitting on the
/// lone `\n` (0x0A) byte. UTF-16/UTF-32 encode the newline as a multi-byte unit
/// (e.g. `0A 00`), so 0x0A splitting misaligns byte parity → mojibake; and
/// encoding_rs has no UTF-32 codec at all. The >1 GB stream viewer refuses
/// these rather than show garbage. UTF-8 and single-byte legacy charsets (the
/// vast majority of multi-GB logs) are streamable.
pub fn is_streamable_label(label: &str) -> bool {
    !(label.starts_with("UTF-16") || label.starts_with("UTF-32"))
}

/// encoding_rs Encoding → friendly UI label.
pub fn label_for_encoding(enc: &'static Encoding) -> String {
    match enc.name() {
        "UTF-8" => "UTF-8",
        "UTF-16LE" => "UTF-16 LE",
        "UTF-16BE" => "UTF-16 BE",
        "windows-1254" => "Windows-1254",
        "windows-1252" => "Windows-1252",
        "windows-1250" => "Windows-1250",
        "windows-1251" => "Windows-1251",
        "windows-1256" => "Windows-1256",
        "ISO-8859-15" => "ISO-8859-15",
        "Shift_JIS" => "Shift_JIS",
        "GBK" => "GBK",
        "EUC-KR" => "EUC-KR",
        "Big5" => "Big5",
        other => return other.to_string(),
    }
    .to_string()
}

// ---------------------------------------------------------------------------
// Open / analyze
// ---------------------------------------------------------------------------

pub struct Analysis {
    pub content: String,
    pub encoding: String, // UI label, e.g. "UTF-8-BOM"
    pub has_bom: bool,
    pub eol: String,
    pub confidence: String, // "High" | "Medium" | "Low"
    pub can_save: bool,     // false for UTF-32 (detect + read-only)
}

fn build(content: String, encoding: &str, has_bom: bool, confidence: &str, can_save: bool) -> Analysis {
    let eol = detect_eol(&content).as_str().to_string();
    Analysis {
        content,
        encoding: encoding.to_string(),
        has_bom,
        eol,
        confidence: confidence.to_string(),
        can_save,
    }
}

fn decode_with(enc: &'static Encoding, body: &[u8], label: &str, has_bom: bool, confidence: &str) -> Analysis {
    let (cow, _had_errors) = enc.decode_without_bom_handling(body);
    build(cow.into_owned(), label, has_bom, confidence, true)
}

fn decode_utf32(body: &[u8], le: bool) -> String {
    let mut s = String::with_capacity(body.len() / 4);
    for chunk in body.chunks_exact(4) {
        let v = if le {
            u32::from_le_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        } else {
            u32::from_be_bytes([chunk[0], chunk[1], chunk[2], chunk[3]])
        };
        s.push(char::from_u32(v).unwrap_or('\u{FFFD}'));
    }
    s
}

/// Analyze raw file bytes. `forced` reinterprets the bytes with a user-chosen
/// encoding (Reopen-with-encoding); when `None`, detection runs.
pub fn analyze(bytes: &[u8], forced: Option<&str>) -> Analysis {
    let (bom, off) = sniff_bom(bytes);

    if let Some(label) = forced {
        return analyze_forced(bytes, label, bom);
    }

    match bom {
        Bom::Utf32Le | Bom::Utf32Be => {
            let le = bom == Bom::Utf32Le;
            let content = decode_utf32(&bytes[off..], le);
            let label = if le { "UTF-32 LE" } else { "UTF-32 BE" };
            return build(content, label, true, "High", false);
        }
        Bom::Utf8 => return decode_with(UTF_8, &bytes[off..], "UTF-8-BOM", true, "High"),
        Bom::Utf16Le => return decode_with(UTF_16LE, &bytes[off..], "UTF-16 LE", true, "High"),
        Bom::Utf16Be => return decode_with(UTF_16BE, &bytes[off..], "UTF-16 BE", true, "High"),
        Bom::None => {}
    }

    // No BOM: prefer a strict UTF-8 check (fast, common, unambiguous).
    if std::str::from_utf8(bytes).is_ok() {
        return decode_with(UTF_8, bytes, "UTF-8", false, "High");
    }

    // Fall back to legacy charset detection.
    let mut det = chardetng::EncodingDetector::new(chardetng::Iso2022JpDetection::Deny);
    det.feed(bytes, true);
    let enc = det.guess(None, chardetng::Utf8Detection::Allow);
    let (cow, had_errors) = enc.decode_without_bom_handling(bytes);
    let confidence = if had_errors { "Low" } else { "Medium" };
    build(cow.into_owned(), &label_for_encoding(enc), false, confidence, true)
}

fn analyze_forced(bytes: &[u8], label: &str, bom: Bom) -> Analysis {
    if let Some(stripped) = label.strip_prefix("UTF-32 ") {
        let le = stripped == "LE";
        let off = if matches!(bom, Bom::Utf32Le | Bom::Utf32Be) { 4 } else { 0 };
        let content = decode_utf32(&bytes[off..], le);
        return build(content, label, off == 4, "High", false);
    }

    // Strip a leading BOM only when it belongs to the chosen encoding family.
    let strip = matches!(
        (label, bom),
        ("UTF-8-BOM", Bom::Utf8) | ("UTF-16 LE", Bom::Utf16Le) | ("UTF-16 BE", Bom::Utf16Be)
    );
    let off = if strip { sniff_bom(bytes).1 } else { 0 };
    let enc = encoding_for_label(label).unwrap_or(UTF_8);
    let (cow, _had) = enc.decode_without_bom_handling(&bytes[off..]);
    build(cow.into_owned(), label, strip, "High", true)
}

// ---------------------------------------------------------------------------
// Save / encode
// ---------------------------------------------------------------------------

#[derive(Debug)]
pub enum SaveError {
    /// Target encoding can't represent some character; we refuse rather than
    /// silently writing `?` (the inverse of Notepad++'s silent data loss).
    Lossy(String),
    Utf32NotSupported,
    UnknownEncoding(String),
}

impl std::fmt::Display for SaveError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            SaveError::Lossy(enc) => write!(
                f,
                "Some characters cannot be represented in {enc}. Save aborted (choose 'Keep as UTF-8' or convert)."
            ),
            SaveError::Utf32NotSupported => {
                write!(f, "Saving as UTF-32 is not supported; convert to UTF-8 first.")
            }
            SaveError::UnknownEncoding(l) => write!(f, "Unknown encoding label: {l}"),
        }
    }
}

impl std::error::Error for SaveError {}

/// Encode text for writing to disk. `label` (base encoding) and `add_bom` are
/// independent: "UTF-8" + add_bom=true is the ONLY way to produce a UTF-8 BOM.
///
/// A legacy target that can't represent some character is refused with
/// `SaveError::Lossy` UNLESS `allow_lossy` is set (the user explicitly chose
/// "save anyway" in the lossy dialog); then encoding_rs's replacement — numeric
/// character references — is written. UTF-8/UTF-16 can represent all of Unicode,
/// so they are never lossy.
pub fn encode_for_save(
    text: &str,
    label: &str,
    add_bom: bool,
    eol: Eol,
    allow_lossy: bool,
) -> Result<Vec<u8>, SaveError> {
    let normalized = apply_eol(text, eol);
    let s: &str = &normalized;

    match label {
        "UTF-8" | "UTF-8-BOM" => {
            let mut out = Vec::with_capacity(s.len() + 3);
            if add_bom {
                out.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
            }
            out.extend_from_slice(s.as_bytes());
            Ok(out)
        }
        "UTF-16 LE" => Ok(encode_utf16(s, true, add_bom)),
        "UTF-16 BE" => Ok(encode_utf16(s, false, add_bom)),
        l if l.starts_with("UTF-32") => Err(SaveError::Utf32NotSupported),
        other => {
            // encoding_rs provides encoders for legacy charsets (not UTF-16/32).
            let enc = encoding_for_label(other).ok_or_else(|| SaveError::UnknownEncoding(other.to_string()))?;
            let (cow, _enc, had_unmappable) = enc.encode(s);
            if had_unmappable && !allow_lossy {
                return Err(SaveError::Lossy(other.to_string()));
            }
            Ok(cow.into_owned())
        }
    }
}

fn encode_utf16(text: &str, le: bool, add_bom: bool) -> Vec<u8> {
    let mut out = Vec::with_capacity(text.len() * 2 + 2);
    if add_bom {
        out.extend_from_slice(if le { &[0xFF, 0xFE] } else { &[0xFE, 0xFF] });
    }
    for unit in text.encode_utf16() {
        let b = if le { unit.to_le_bytes() } else { unit.to_be_bytes() };
        out.extend_from_slice(&b);
    }
    out
}

// ---------------------------------------------------------------------------
// Tests — the golden set guards the Notepad++ regressions from ever recurring.
// ---------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn name_byte_lock_no_bom_injection() {
        // "UTF-8" must NEVER produce a BOM.
        let out = encode_for_save("hello", "UTF-8", false, Eol::Lf, false).unwrap();
        assert_ne!(&out[..out.len().min(3)], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(out, b"hello");
    }

    #[test]
    fn name_byte_lock_bom_only_when_asked() {
        // BOM appears only with add_bom=true.
        let out = encode_for_save("hello", "UTF-8", true, Eol::Lf, false).unwrap();
        assert_eq!(&out[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&out[3..], b"hello");
    }

    #[test]
    fn open_utf8_bom_strips_and_flags() {
        let a = analyze(b"\xEF\xBB\xBFhi", None);
        assert_eq!(a.content, "hi");
        assert_eq!(a.encoding, "UTF-8-BOM");
        assert!(a.has_bom);
    }

    #[test]
    fn open_utf8_no_bom() {
        let a = analyze(b"plain ascii", None);
        assert_eq!(a.encoding, "UTF-8");
        assert!(!a.has_bom);
        assert_eq!(a.confidence, "High");
    }

    #[test]
    fn bom_preserve_round_trip() {
        // Open BOM'd file → save with its flags → BOM still there, once.
        let a = analyze("\u{FEFF}data".as_bytes(), None); // UTF-8 BOM + "data"
        assert!(a.has_bom);
        let out = encode_for_save(&a.content, "UTF-8", a.has_bom, Eol::from_label(&a.eol), false).unwrap();
        assert_eq!(&out[..3], &[0xEF, 0xBB, 0xBF]);
        assert_eq!(&out[3..], b"data");
    }

    #[test]
    fn bom_sniff_order_utf32_before_utf16() {
        assert_eq!(sniff_bom(&[0xFF, 0xFE, 0x00, 0x00]).0, Bom::Utf32Le);
        assert_eq!(sniff_bom(&[0xFF, 0xFE, 0x41, 0x00]).0, Bom::Utf16Le);
    }

    #[test]
    fn lossy_guard_refuses_silent_loss() {
        // A CJK character cannot be represented in Windows-1254 (Turkish); we must
        // refuse rather than silently writing '?' (Notepad++'s silent data loss).
        let err = encode_for_save("hello 中", "Windows-1254", false, Eol::Lf, false);
        assert!(matches!(err, Err(SaveError::Lossy(_))));
        // Sanity: the euro sign *is* in Windows-1254, so it must NOT be lossy.
        assert!(encode_for_save("price €5", "Windows-1254", false, Eol::Lf, false).is_ok());
        // "Save anyway" (allow_lossy=true): writes bytes instead of refusing. The
        // unmappable CJK char becomes encoding_rs's numeric-char-reference bytes.
        let lossy = encode_for_save("hi 中", "Windows-1254", false, Eol::Lf, true).unwrap();
        assert!(lossy.starts_with(b"hi ")); // representable prefix kept
        assert!(lossy.windows(2).any(|w| w == b"&#")); // unmappable → &#…; reference
    }

    #[test]
    fn eol_preserve_crlf() {
        // CM6 hands us LF text; saving with tracked CRLF must produce CRLF.
        let out = encode_for_save("a\nb\nc", "UTF-8", false, Eol::Crlf, false).unwrap();
        assert_eq!(out, b"a\r\nb\r\nc");
    }

    #[test]
    fn eol_crlf_no_doubling() {
        let out = encode_for_save("a\r\nb", "UTF-8", false, Eol::Crlf, false).unwrap();
        assert_eq!(out, b"a\r\nb");
    }

    #[test]
    fn detect_eol_mixed() {
        assert_eq!(detect_eol("a\r\nb\nc"), Eol::Mixed);
        assert_eq!(detect_eol("a\r\nb\r\n"), Eol::Crlf);
        assert_eq!(detect_eol("a\nb\n"), Eol::Lf);
    }

    #[test]
    fn turkish_legacy_not_utf8() {
        // "Türkçe" in Windows-1254: contains 0xFC (ü), 0xE7 (ç) etc. — invalid UTF-8,
        // so detection must leave the UTF-8 path and decode via a legacy charset.
        let (bytes, _, _) = WINDOWS_1254.encode("Türkçe ışığı");
        let a = analyze(&bytes, None);
        assert_ne!(a.encoding, "UTF-8");
        // And forcing the correct table reproduces the text exactly.
        let forced = analyze(&bytes, Some("Windows-1254"));
        assert_eq!(forced.content, "Türkçe ışığı");
    }

    #[test]
    fn reopen_legacy_decodes_whole_file() {
        let (bytes, _, _) = WINDOWS_1252.encode("café");
        let a = analyze(&bytes, Some("Windows-1252"));
        assert_eq!(a.content, "café");
        assert!(!a.has_bom);
    }

    #[test]
    fn utf16le_round_trip_with_bom() {
        let out = encode_for_save("hi", "UTF-16 LE", true, Eol::Lf, false).unwrap();
        assert_eq!(out, vec![0xFF, 0xFE, b'h', 0x00, b'i', 0x00]);
        let a = analyze(&out, None);
        assert_eq!(a.content, "hi");
        assert_eq!(a.encoding, "UTF-16 LE");
        assert!(a.has_bom);
    }

    #[test]
    fn empty_file_is_utf8() {
        let a = analyze(b"", None);
        assert_eq!(a.encoding, "UTF-8");
        assert!(!a.has_bom);
        assert_eq!(a.content, "");
    }
}
