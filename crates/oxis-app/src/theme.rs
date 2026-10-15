//! The OXIS design system on Dear ImGui.
//!
//! The same tokens as OXIS 1.x's redesigned interface: a cool grey-navy
//! page, chrome a step darker, hairline lines mixed from the text colour,
//! and the logo's greens as the one accent. The interface is set in IBM
//! Plex Sans; anything typed (terminal, editor, commands) in JetBrains
//! Mono. Dear ImGui's default look is fully replaced here.

use dear_imgui_rs::{Context, FontId, FontSource, StyleColor};

/// Colours as linear-ish sRGB floats (what ImGui's style wants).
pub type Rgba = [f32; 4];

const fn hex(rgb: u32) -> Rgba {
    [((rgb >> 16) & 0xff) as f32 / 255.0, ((rgb >> 8) & 0xff) as f32 / 255.0, (rgb & 0xff) as f32 / 255.0, 1.0]
}

/// Mixes `a` towards `b` by `t` (0 = a, 1 = b).
pub fn mix(a: Rgba, b: Rgba, t: f32) -> Rgba {
    [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t, a[3] + (b[3] - a[3]) * t]
}

pub fn alpha(c: Rgba, a: f32) -> Rgba {
    [c[0], c[1], c[2], a]
}

/// A colour for the draw list (which takes plain RGBA floats).
pub fn col(c: Rgba) -> Rgba {
    c
}

/// The default theme's colours and the tokens derived from them.
#[derive(Clone, Copy, Debug)]
pub struct Palette {
    pub bg: Rgba,
    pub bg1: Rgba,
    pub text: Rgba,
    pub muted: Rgba,
    pub dim: Rgba,
    pub acc: Rgba,
    pub acc_hi: Rgba,
    pub acc_lo: Rgba,
    pub ok: Rgba,
    pub err: Rgba,
    pub warn: Rgba,
}

impl Default for Palette {
    fn default() -> Self {
        Self {
            bg: hex(0x1a1b26),
            bg1: hex(0x16161e),
            text: hex(0xc0caf5),
            muted: hex(0x7a809b),
            dim: hex(0x565f89),
            acc: hex(0x2bb35e),
            acc_hi: hex(0x4fd47f),
            acc_lo: hex(0x1e9149),
            ok: hex(0x4fd47f),
            err: hex(0xf7768e),
            warn: hex(0xff9e64),
        }
    }
}

impl Palette {
    /// Title bar, sidebar and status bar.
    pub fn chrome(&self) -> Rgba {
        self.bg1
    }
    /// Bars inside the content (prompt, editor bars).
    pub fn chrome2(&self) -> Rgba {
        mix(self.bg1, self.bg, 0.45)
    }
    /// Panels and cards: a step off the page.
    pub fn panel(&self) -> Rgba {
        mix(self.bg1, self.bg, 0.38)
    }
    /// Popups and menus.
    pub fn overlay(&self) -> Rgba {
        mix(self.bg, self.text, 0.04)
    }
    pub fn line(&self) -> Rgba {
        alpha(self.text, 0.09)
    }
    pub fn line2(&self) -> Rgba {
        alpha(self.text, 0.16)
    }
    pub fn hover(&self) -> Rgba {
        alpha(self.text, 0.06)
    }
    pub fn press(&self) -> Rgba {
        alpha(self.text, 0.11)
    }
    pub fn wash(&self) -> Rgba {
        alpha(self.acc, 0.14)
    }
}

/// The fonts OXIS uses, loaded once into ImGui's atlas. ImGui 1.92 renders
/// each at whatever size it's asked for, crisp at any display scale.
#[derive(Clone, Copy)]
pub struct Fonts {
    pub ui: FontId,
    pub ui_medium: FontId,
    pub ui_semibold: FontId,
    pub mono: FontId,
    pub mono_bold: FontId,
}

/// Sizes in logical pixels.
pub mod size {
    pub const XS: f32 = 11.0;
    pub const SM: f32 = 12.5;
    pub const MD: f32 = 13.5;
    pub const TITLE: f32 = 26.0;
}

static PLEX_REGULAR: &[u8] = include_bytes!("../assets/fonts/IBMPlexSans-Regular.ttf");
static PLEX_MEDIUM: &[u8] = include_bytes!("../assets/fonts/IBMPlexSans-Medium.ttf");
static PLEX_SEMIBOLD: &[u8] = include_bytes!("../assets/fonts/IBMPlexSans-SemiBold.ttf");
static MONO_REGULAR: &[u8] = include_bytes!("../assets/fonts/JetBrainsMono-Regular.ttf");
static MONO_BOLD: &[u8] = include_bytes!("../assets/fonts/JetBrainsMono-Bold.ttf");

/// System fonts merged behind OXIS's own, for characters they don't have
/// (symbols, arrows, CJK): whichever of these exist here. Read through
/// ImGui's validated TrueType loader, so a damaged file is skipped rather
/// than trusted. Font collections (.ttc) can't be merged and aren't listed.
fn fallback_fonts() -> Vec<dear_imgui_rs::StbTrueTypeFontData> {
    let candidates: &[&str] = if cfg!(windows) {
        &[r"C:\Windows\Fonts\seguisym.ttf", r"C:\Windows\Fonts\segoeui.ttf", r"C:\Windows\Fonts\malgun.ttf", r"C:\Windows\Fonts\Nirmala.ttf"]
    } else if cfg!(target_os = "macos") {
        &["/System/Library/Fonts/Apple Symbols.ttf", "/Library/Fonts/Arial Unicode.ttf"]
    } else {
        &[
            "/usr/share/fonts/truetype/dejavu/DejaVuSansMono.ttf",
            "/usr/share/fonts/TTF/DejaVuSansMono.ttf",
            "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
            "/usr/share/fonts/truetype/droid/DroidSansFallbackFull.ttf",
            "/usr/share/fonts/truetype/noto/NotoSansSymbols2-Regular.ttf",
        ]
    };
    let mut found = Vec::new();
    for path in candidates {
        if !std::path::Path::new(path).is_file() {
            continue;
        }
        match dear_imgui_rs::StbTrueTypeFontData::from_file(path) {
            Ok(data) => {
                tracing::debug!("fallback font: {path}");
                found.push(data);
            }
            Err(e) => tracing::warn!("skipped the fallback font {path}: {e}"),
        }
    }
    found
}

pub fn load_fonts(ctx: &mut Context) -> Fonts {
    let fallbacks = fallback_fonts();
    let atlas = ctx.font_atlas();
    // SAFETY: the font files are complete, valid TTFs embedded in the
    // binary, unchanged for the life of the program.
    let add = |data: &'static [u8]| {
        let mut sources = vec![unsafe { FontSource::ttf_data_with_size(data, size::MD) }];
        sources.extend(fallbacks.iter().cloned().map(FontSource::stb_truetype));
        atlas.add_font(&sources)
    };
    // The first font added is ImGui's default.
    let ui = add(PLEX_REGULAR);
    Fonts { ui, ui_medium: add(PLEX_MEDIUM), ui_semibold: add(PLEX_SEMIBOLD), mono: add(MONO_REGULAR), mono_bold: add(MONO_BOLD) }
}

/// Replaces Dear ImGui's default look with OXIS's.
pub fn apply_style(ctx: &mut Context, p: &Palette) {
    let style = ctx.style_mut();
    style.set_font_size_base(size::MD);
    style.set_window_padding([0.0, 0.0]);
    style.set_window_rounding(0.0);
    style.set_window_border_size(0.0);
    style.set_child_rounding(5.0);
    style.set_child_border_size(1.0);
    style.set_popup_rounding(6.0);
    style.set_popup_border_size(1.0);
    style.set_frame_padding([10.0, 6.0]);
    style.set_frame_rounding(5.0);
    style.set_frame_border_size(1.0);
    style.set_item_spacing([8.0, 6.0]);
    style.set_item_inner_spacing([6.0, 4.0]);
    style.set_scrollbar_size(10.0);
    style.set_scrollbar_rounding(8.0);
    style.set_grab_rounding(4.0);
    style.set_tab_rounding(0.0);
    style.set_selectable_rounding(4.0);
    style.set_menu_item_rounding(4.0);
    style.set_separator_size(1.0);

    let c = |s: &mut dear_imgui_rs::Style, k: StyleColor, v: Rgba| s.set_color(k, v);
    c(style, StyleColor::Text, p.text);
    c(style, StyleColor::TextDisabled, p.dim);
    c(style, StyleColor::WindowBg, p.bg);
    c(style, StyleColor::ChildBg, [0.0; 4]);
    c(style, StyleColor::PopupBg, p.overlay());
    c(style, StyleColor::Border, p.line2());
    c(style, StyleColor::BorderShadow, [0.0; 4]);
    c(style, StyleColor::FrameBg, p.panel());
    c(style, StyleColor::FrameBgHovered, mix(p.panel(), p.text, 0.04));
    c(style, StyleColor::FrameBgActive, mix(p.panel(), p.text, 0.07));
    c(style, StyleColor::ScrollbarBg, [0.0; 4]);
    c(style, StyleColor::ScrollbarGrab, p.line2());
    c(style, StyleColor::ScrollbarGrabHovered, alpha(p.text, 0.28));
    c(style, StyleColor::ScrollbarGrabActive, alpha(p.text, 0.36));
    c(style, StyleColor::CheckMark, p.acc_hi);
    c(style, StyleColor::SliderGrab, p.acc);
    c(style, StyleColor::SliderGrabActive, p.acc_hi);
    c(style, StyleColor::Button, p.hover());
    c(style, StyleColor::ButtonHovered, p.press());
    c(style, StyleColor::ButtonActive, alpha(p.text, 0.16));
    c(style, StyleColor::Header, p.wash());
    c(style, StyleColor::HeaderHovered, p.hover());
    c(style, StyleColor::HeaderActive, p.wash());
    c(style, StyleColor::Separator, p.line());
    c(style, StyleColor::SeparatorHovered, p.acc);
    c(style, StyleColor::SeparatorActive, p.acc_hi);
    c(style, StyleColor::Tab, [0.0; 4]);
    c(style, StyleColor::TabHovered, p.hover());
    c(style, StyleColor::TabSelected, p.bg);
    c(style, StyleColor::TabSelectedOverline, p.acc);
    c(style, StyleColor::TextSelectedBg, alpha(p.acc, 0.32));
    c(style, StyleColor::TextLink, p.acc_hi);
    c(style, StyleColor::NavCursor, p.acc_hi);
    c(style, StyleColor::ModalWindowDimBg, [0.0, 0.0, 0.0, 0.55]);
    c(style, StyleColor::InputTextCursor, p.acc_hi);
}

/// The window's icon (taskbar, Alt+Tab): the OXIS mark.
pub fn window_icon() -> Option<winit::window::Icon> {
    let decoder = png::Decoder::new(std::io::Cursor::new(include_bytes!("../assets/icon.png").as_slice()));
    let mut reader = decoder.read_info().ok()?;
    let mut buf = vec![0; reader.output_buffer_size()];
    let info = reader.next_frame(&mut buf).ok()?;
    let rgba: Vec<u8> = match info.color_type {
        png::ColorType::Rgba => buf[..info.buffer_size()].to_vec(),
        png::ColorType::Rgb => buf[..info.buffer_size()].chunks(3).flat_map(|p| [p[0], p[1], p[2], 255]).collect(),
        _ => return None,
    };
    winit::window::Icon::from_rgba(rgba, info.width, info.height).ok()
}
