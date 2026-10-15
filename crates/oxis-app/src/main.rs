//! OXIS — the native application.
//!
//! A frameless winit window with an OpenGL context (glutin), Dear ImGui on
//! top (dear-imgui-rs, its winit platform and glow renderer), and the OXIS
//! engine (the OXIDE Engine (`oxide`)) underneath. The interface itself lives in
//! [`shell`]; this file only owns the window, the GL context and the frame
//! loop. The loop sleeps until there's input or engine events, so an idle
//! OXIS uses no CPU.

#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

mod drive;
mod shell;
mod theme;
mod window_state;

use std::num::NonZeroU32;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dear_imgui_glow::{glow, GlowRenderer};
use dear_imgui_rs::Context;
use dear_imgui_winit::{HiDpiMode, WinitPlatform};
use glow::HasContext;
use glutin::config::{ConfigTemplateBuilder, GlConfig};
use glutin::context::{ContextAttributesBuilder, NotCurrentGlContext, PossiblyCurrentContext};
use glutin::display::{GetGlDisplay, GlDisplay};
use glutin::surface::{GlSurface, Surface, SurfaceAttributesBuilder, WindowSurface};
use glutin_winit::DisplayBuilder;
use oxide::Engine;
use raw_window_handle::HasWindowHandle;
use winit::application::ApplicationHandler;
use winit::event::WindowEvent;
use winit::event_loop::{ActiveEventLoop, ControlFlow, EventLoop, EventLoopProxy};
use winit::window::{Window, WindowAttributes, WindowId};

/// Woken from engine threads (process output, exits) to redraw.
#[derive(Debug, Clone, Copy)]
pub struct Wake;

struct Gfx {
    window: Arc<Window>,
    surface: Surface<WindowSurface>,
    context: PossiblyCurrentContext,
    imgui: Context,
    platform: WinitPlatform,
    renderer: GlowRenderer,
}

struct App {
    gfx: Option<Gfx>,
    shell: shell::Shell,
    proxy: EventLoopProxy<Wake>,
    /// Keep drawing for a moment after input so hover and animations settle.
    busy_until: Instant,
    /// `--snapshot` and `--drive`: a hidden window, frames drawn offscreen,
    /// input from a script (see [`drive`]).
    headless: Option<Headless>,
    exit_code: i32,
}

struct Headless {
    driver: drive::Driver,
    size: (u32, u32),
    /// Frames are drawn into this, not the (hidden) window.
    target: Option<(glow::Framebuffer, glow::Texture, u32, u32)>,
    /// Save the frame being drawn to this file.
    shot: Option<std::path::PathBuf>,
    /// A driven run keeps what it changes; a snapshot changes nothing.
    persist: bool,
}

impl App {
    /// Draws one frame: engine events in, the interface, then present (or,
    /// in snapshot mode, into the offscreen target).
    fn frame(&mut self, event_loop: &ActiveEventLoop) {
        let Some(g) = self.gfx.as_mut() else { return };
        self.shell.drain_events();
        if let Some(h) = self.headless.as_mut() {
            match h.driver.before_frame(g.imgui.io_mut(), &mut self.shell) {
                drive::After::Continue => {}
                drive::After::Snapshot(path) => h.shot = Some(path),
                drive::After::Resize(w, hgt) => {
                    let _ = g.window.request_inner_size(winit::dpi::LogicalSize::new(w as f64, hgt as f64));
                }
                drive::After::Done => {
                    event_loop.exit();
                    return;
                }
                drive::After::Failed(why) => {
                    tracing::error!("drive: {why}");
                    eprintln!("drive: {why}");
                    self.exit_code = 2;
                    event_loop.exit();
                    return;
                }
            }
        }
        let _ = g.platform.prepare_frame(&mut g.imgui, &g.window);
        let ui = g.imgui.frame();
        let actions = self.shell.draw(ui, &g.window);
        let _ = g.platform.prepare_render(ui, &g.window);
        let size = g.window.inner_size();
        if let (Some(h), Some(gl)) = (self.headless.as_mut(), g.renderer.gl_context()) {
            if h.target.is_some_and(|(_, _, w, hgt)| (w, hgt) != (size.width, size.height)) {
                if let Some((fbo, tex, _, _)) = h.target.take() {
                    unsafe {
                        gl.delete_framebuffer(fbo);
                        gl.delete_texture(tex);
                    }
                }
            }
            if h.target.is_none() {
                h.target = offscreen_target(gl, size.width, size.height);
            }
            if let Some((fbo, _, _, _)) = h.target {
                unsafe {
                    gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
                    gl.viewport(0, 0, size.width as i32, size.height as i32);
                }
            }
        }
        if let Ok(consumer) = g.renderer.renderer_consumer() {
            let pending = g.imgui.render(consumer);
            if let Some(gl) = g.renderer.gl_context() {
                let c = theme::Palette::default().bg;
                unsafe {
                    gl.clear_color(c[0], c[1], c[2], 1.0);
                    gl.clear(glow::COLOR_BUFFER_BIT);
                }
            }
            if let Err(e) = g.renderer.render(pending) {
                tracing::error!("render failed: {e}");
            }
        }
        if let Some(h) = self.headless.as_mut() {
            if let Some(path) = h.shot.take() {
                if let Err(e) = save_snapshot(&g.renderer, size.width, size.height, &path) {
                    tracing::error!("couldn't save the snapshot: {e}");
                    eprintln!("drive: couldn't save {}: {e}", path.display());
                    self.exit_code = 2;
                    event_loop.exit();
                }
            }
            return;
        }
        let _ = g.surface.swap_buffers(&g.context);
        if actions.quit {
            self.shell.save_window(&g.window);
            event_loop.exit();
            return;
        }
        if actions.animating {
            self.busy_until = Instant::now() + Duration::from_millis(120);
        }
    }
}

impl ApplicationHandler<Wake> for App {
    fn resumed(&mut self, event_loop: &ActiveEventLoop) {
        if self.gfx.is_some() {
            return;
        }
        match create_gfx(event_loop, &mut self.shell, self.headless.as_ref().map(|h| h.size)) {
            Ok(g) => {
                self.shell.start_event_pump(self.proxy.clone());
                self.gfx = Some(g);
            }
            Err(e) => {
                tracing::error!("couldn't open the OXIS window: {e}");
                eprintln!("couldn't open the OXIS window: {e}");
                self.exit_code = 1;
                event_loop.exit();
            }
        }
    }

    fn user_event(&mut self, _el: &ActiveEventLoop, _wake: Wake) {
        if let Some(g) = &self.gfx {
            g.window.request_redraw();
        }
    }

    fn window_event(&mut self, event_loop: &ActiveEventLoop, _id: WindowId, event: WindowEvent) {
        let Some(g) = self.gfx.as_mut() else { return };
        let _ = g.platform.handle_window_event(&mut g.imgui, &g.window, &event);
        match event {
            WindowEvent::CloseRequested => {
                self.shell.save_window(&g.window);
                event_loop.exit();
            }
            WindowEvent::Resized(size) => {
                if let (Some(w), Some(h)) = (NonZeroU32::new(size.width), NonZeroU32::new(size.height)) {
                    g.surface.resize(&g.context, w, h);
                }
                g.window.request_redraw();
            }
            WindowEvent::RedrawRequested => self.frame(event_loop),
            WindowEvent::CursorMoved { .. }
            | WindowEvent::MouseInput { .. }
            | WindowEvent::MouseWheel { .. }
            | WindowEvent::KeyboardInput { .. }
            | WindowEvent::ModifiersChanged(_)
            | WindowEvent::Focused(_)
            | WindowEvent::ScaleFactorChanged { .. }
            | WindowEvent::Ime(_) => {
                self.busy_until = Instant::now() + Duration::from_millis(250);
                g.window.request_redraw();
            }
            _ => {}
        }
    }

    fn about_to_wait(&mut self, event_loop: &ActiveEventLoop) {
        if self.headless.is_some() {
            // A hidden window gets no redraw requests: draw directly, one
            // frame per turn of the loop so window events (resizes) arrive.
            self.frame(event_loop);
            event_loop.set_control_flow(ControlFlow::Poll);
            return;
        }
        if let Some(g) = &self.gfx {
            if Instant::now() < self.busy_until {
                g.window.request_redraw();
                event_loop.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_millis(16)));
            } else {
                // A slow tick keeps the status bar's clock current.
                event_loop.set_control_flow(ControlFlow::WaitUntil(Instant::now() + Duration::from_secs(1)));
                g.window.request_redraw();
            }
        }
    }
}

fn create_gfx(event_loop: &ActiveEventLoop, shell: &mut shell::Shell, snapshot: Option<(u32, u32)>) -> Result<Gfx, Box<dyn std::error::Error>> {
    let mut placement = window_state::initial_placement(event_loop, shell.window_state());
    if let Some((w, h)) = snapshot {
        placement = window_state::Placement { size: winit::dpi::LogicalSize::new(w as f64, h as f64), position: None, maximized: false };
    }
    let mut attrs = WindowAttributes::default()
        .with_visible(snapshot.is_none())
        .with_title("OXIS")
        .with_decorations(false)
        .with_inner_size(placement.size)
        .with_min_inner_size(winit::dpi::LogicalSize::new(720.0, 460.0))
        .with_window_icon(theme::window_icon());
    if let Some(pos) = placement.position {
        attrs = attrs.with_position(pos);
    }

    let template = ConfigTemplateBuilder::new().with_alpha_size(8);
    let (window, gl_config) = DisplayBuilder::new()
        .with_window_attributes(Some(attrs))
        .build(event_loop, template, |configs| configs.reduce(|a, b| if b.num_samples() > a.num_samples() { b } else { a }).expect("no OpenGL config"))?;
    let window = Arc::new(window.ok_or("no window")?);
    if placement.maximized {
        window.set_maximized(true);
    }

    let raw = window.window_handle()?.as_raw();
    let display = gl_config.display();
    let ctx_attrs = ContextAttributesBuilder::new().build(Some(raw));
    let not_current = unsafe { display.create_context(&gl_config, &ctx_attrs)? };
    let size = window.inner_size();
    let surface_attrs =
        SurfaceAttributesBuilder::<WindowSurface>::new().build(raw, NonZeroU32::new(size.width.max(1)).unwrap(), NonZeroU32::new(size.height.max(1)).unwrap());
    let surface = unsafe { display.create_window_surface(&gl_config, &surface_attrs)? };
    let context = not_current.make_current(&surface)?;
    let _ = surface.set_swap_interval(&context, glutin::surface::SwapInterval::Wait(NonZeroU32::new(1).unwrap()));

    let gl = unsafe {
        glow::Context::from_loader_function(|s| {
            let s = std::ffi::CString::new(s).unwrap();
            display.get_proc_address(&s) as *const _
        })
    };

    let mut imgui = Context::create();
    imgui.set_ini_filename(None::<std::path::PathBuf>).ok();
    let mut platform = WinitPlatform::new(&mut imgui)?;
    platform.attach_window(window.clone(), HiDpiMode::Default, &mut imgui)?;
    shell.setup_imgui(&mut imgui);
    let renderer = GlowRenderer::new(gl, &mut imgui)?;
    Ok(Gfx { window, surface, context, imgui, platform, renderer })
}

fn main() {
    let data_dir = oxis_data_dir();
    oxide::logging::init(Some(&data_dir.join("logs")));
    tracing::info!(version = oxide::VERSION, data = %data_dir.display(), "OXIS starting");

    let engine = match Engine::open(&data_dir) {
        Ok(e) => e,
        Err(e) => {
            tracing::error!("couldn't open the OXIS data folder: {e}");
            std::process::exit(1);
        }
    };
    let args: Vec<String> = std::env::args().collect();
    let value = |flag: &str| args.iter().position(|a| a == flag).and_then(|i| args.get(i + 1));
    let size = args.iter().skip(1).find_map(|a| drive::parse_size(a)).unwrap_or((1180, 760));
    let script = if let Some(path) = value("--drive") {
        let text = std::fs::read_to_string(path).unwrap_or_else(|e| {
            eprintln!("couldn't read the drive script {path}: {e}");
            std::process::exit(2);
        });
        Some((drive::parse(&text), true))
    } else {
        value("--snapshot").map(|path| (Ok(vec![drive::Step::Frames(4), drive::Step::Snapshot(path.into()), drive::Step::Frames(1)]), false))
    };
    let headless = match script {
        Some((Ok(steps), persist)) => Some(Headless { driver: drive::Driver::new(steps), size, target: None, shot: None, persist }),
        Some((Err(e), _)) => {
            eprintln!("drive script: {e}");
            std::process::exit(2);
        }
        None => None,
    };
    let event_loop = EventLoop::<Wake>::with_user_event().build().expect("couldn't create the event loop");
    let mut shell = shell::Shell::new(engine);
    if let Some(view) = args.iter().find_map(|a| a.strip_prefix("--view=")) {
        shell.set_view(view);
    }
    let mut app = App { gfx: None, shell, proxy: event_loop.create_proxy(), busy_until: Instant::now(), headless, exit_code: 0 };
    if let Err(e) = event_loop.run_app(&mut app) {
        tracing::error!("the event loop stopped: {e}");
    }
    let persist = app.headless.as_ref().map_or(true, |h| h.persist);
    if let Some(mut g) = app.gfx.take() {
        let _ = g.renderer.shutdown(&mut g.imgui);
    }
    // A snapshot run leaves the user's settings exactly as they were.
    app.shell.shutdown(persist);
    if app.exit_code != 0 {
        std::process::exit(app.exit_code);
    }
}

/// Where OXIS 2 keeps its settings, workspaces and logs: `OXIS_DATA` if
/// set, else the platform's per-user data folder (`%APPDATA%\OXIS2`,
/// `$XDG_DATA_HOME/oxis2` or `~/.local/share/oxis2`).
fn oxis_data_dir() -> std::path::PathBuf {
    if let Some(dir) = std::env::var_os("OXIS_DATA") {
        return dir.into();
    }
    #[cfg(windows)]
    {
        if let Some(appdata) = std::env::var_os("APPDATA") {
            return std::path::PathBuf::from(appdata).join("OXIS2");
        }
    }
    #[cfg(unix)]
    {
        if let Some(xdg) = std::env::var_os("XDG_DATA_HOME") {
            return std::path::PathBuf::from(xdg).join("oxis2");
        }
        if let Some(home) = std::env::var_os("HOME") {
            return std::path::PathBuf::from(home).join(".local/share/oxis2");
        }
    }
    std::path::PathBuf::from(".oxis2")
}

/// A framebuffer with an RGBA colour texture, for snapshot frames.
fn offscreen_target(gl: &glow::Context, w: u32, h: u32) -> Option<(glow::Framebuffer, glow::Texture, u32, u32)> {
    unsafe {
        let tex = gl.create_texture().ok()?;
        gl.bind_texture(glow::TEXTURE_2D, Some(tex));
        gl.tex_image_2d(glow::TEXTURE_2D, 0, glow::RGBA8 as i32, w as i32, h as i32, 0, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelUnpackData::Slice(None));
        let fbo = gl.create_framebuffer().ok()?;
        gl.bind_framebuffer(glow::FRAMEBUFFER, Some(fbo));
        gl.framebuffer_texture_2d(glow::FRAMEBUFFER, glow::COLOR_ATTACHMENT0, glow::TEXTURE_2D, Some(tex), 0);
        (gl.check_framebuffer_status(glow::FRAMEBUFFER) == glow::FRAMEBUFFER_COMPLETE).then_some((fbo, tex, w, h))
    }
}

/// Reads the frame just drawn (from the bound framebuffer) and writes it as a PNG.
fn save_snapshot(renderer: &GlowRenderer, w: u32, h: u32, path: &std::path::Path) -> Result<(), Box<dyn std::error::Error>> {
    let gl = renderer.gl_context().ok_or("no GL context")?;
    let mut pixels = vec![0u8; (w * h * 4) as usize];
    unsafe {
        gl.read_pixels(0, 0, w as i32, h as i32, glow::RGBA, glow::UNSIGNED_BYTE, glow::PixelPackData::Slice(Some(&mut pixels)));
    }
    // OpenGL's rows run bottom to top.
    let row = (w * 4) as usize;
    let flipped: Vec<u8> = pixels.chunks(row).rev().flatten().copied().collect();
    let file = std::fs::File::create(path)?;
    let mut enc = png::Encoder::new(std::io::BufWriter::new(file), w, h);
    enc.set_color(png::ColorType::Rgba);
    enc.set_depth(png::BitDepth::Eight);
    enc.write_header()?.write_image_data(&flipped)?;
    tracing::info!("snapshot saved to {}", path.display());
    Ok(())
}
