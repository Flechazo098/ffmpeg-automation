use std::env;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;
use tauri::{Emitter, Window};
use tauri_plugin_dialog::init as dialog_init;
use tauri_plugin_opener::init as opener_init;

#[tauri::command]
fn greet(name: &str) -> String {
    format!("Hello, {}! You've been greeted from Rust!", name)
}

#[tauri::command]
async fn audio_morph(window: Window, files: Vec<String>, target_format: String) -> Result<(), String> {
    let format = target_format.to_lowercase();
    for file in files {
        let input = PathBuf::from(&file);
        if !input.exists() {
            continue;
        }
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;
        let parent = input.parent().unwrap_or_else(|| Path::new(""));
        let output = parent.join(format!("{stem}.{format}"));

        let mut args = vec!["-i".to_string(), file.clone()];
        match format.as_str() {
            "mp3" => {
                args.extend([
                    "-codec:a".to_string(),
                    "libmp3lame".to_string(),
                    "-qscale:a".to_string(),
                    "0".to_string(),
                ]);
            }
            "m4a" => {
                args.extend([
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "256k".to_string(),
                ]);
            }
            "ogg" => {
                args.extend([
                    "-c:a".to_string(),
                    "libvorbis".to_string(),
                    "-q:a".to_string(),
                    "10".to_string(),
                ]);
            }
            "wav" => {
                args.extend([
                    "-c:a".to_string(),
                    "pcm_s16le".to_string(),
                ]);
            }
            _ => return Err(format!("Unsupported audio format: {}", format)),
        }
        args.push(output.to_string_lossy().to_string());
        let label = format!("[audio-morph] {}", input.display());
        run_ffmpeg(&window, &label, args)?;
    }
    Ok(())
}

#[tauri::command]
async fn quick_trans_img(window: Window, files: Vec<String>, target_ext: String) -> Result<(), String> {
    let ext = target_ext.to_lowercase();
    for file in files {
        let input = PathBuf::from(&file);
        if !input.exists() {
            continue;
        }
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;
        let parent = input.parent().unwrap_or_else(|| Path::new(""));
        let output = parent.join(format!("{stem}.{}", ext));

        let args = vec![
            "-i".to_string(),
            file.clone(),
            "-q:v".to_string(),
            "2".to_string(),
            output.to_string_lossy().to_string(),
        ];
        let label = format!("[quick-trans-img] {}", input.display());
        run_ffmpeg(&window, &label, args)?;
    }
    Ok(())
}

#[tauri::command]
async fn smart_image_squish(
    window: Window,
    files: Vec<String>,
    max_size_kb: u64,
    mode: u8,
) -> Result<(), String> {
    for file in files {
        let input = PathBuf::from(&file);
        if !input.exists() {
            continue;
        }
        let parent = input.parent().unwrap_or_else(|| Path::new(""));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;
        let ext = input
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();

        match mode {
            1 => {
                if ext == "png" {
                    let output = parent.join(format!("{stem}_opt.png"));
                    let args = vec![
                        "-i".to_string(),
                        file.clone(),
                        "-compression_level".to_string(),
                        "10".to_string(),
                        output.to_string_lossy().to_string(),
                    ];
                    let label = format!("[image-squish:opt-png] {}", input.display());
                    run_ffmpeg(&window, &label, args)?;
                } else {
                    let output = parent.join(format!("{stem}_opt.{}", ext));
                    let args = vec![
                        "-i".to_string(),
                        file.clone(),
                        "-qscale:v".to_string(),
                        "3".to_string(),
                        "-pix_fmt".to_string(),
                        "yuv420p".to_string(),
                        output.to_string_lossy().to_string(),
                    ];
                    let label = format!("[image-squish:opt] {}", input.display());
                    run_ffmpeg(&window, &label, args)?;
                }
            }
            2 => {
                let output = parent.join(format!("{stem}_final.avif"));
                compress_avif(&window, &input, &output, max_size_kb)?;
            }
            3 => {
                let output = parent.join(format!("{stem}_final.webp"));
                compress_webp(&window, &input, &output, max_size_kb)?;
            }
            4 => {
                let temp_avif = parent.join(format!("{stem}_temp.avif"));
                let size_avif = compress_avif(&window, &input, &temp_avif, max_size_kb)?;

                let temp_webp = parent.join(format!("{stem}_temp.webp"));
                let size_webp = compress_webp(&window, &input, &temp_webp, max_size_kb)?;

                if size_avif <= size_webp {
                    let final_avif = parent.join(format!("{stem}_final.avif"));
                    fs::rename(&temp_avif, final_avif).map_err(|e| e.to_string())?;
                    let _ = fs::remove_file(&temp_webp);
                } else {
                    let final_webp = parent.join(format!("{stem}_final.webp"));
                    fs::rename(&temp_webp, final_webp).map_err(|e| e.to_string())?;
                    let _ = fs::remove_file(&temp_avif);
                }
            }
            _ => return Err("Unsupported mode".to_string()),
        }
    }
    Ok(())
}

#[tauri::command]
async fn v_extractor(window: Window, files: Vec<String>, choice: u8) -> Result<(), String> {
    for file in files {
        let input = PathBuf::from(&file);
        if !input.exists() {
            continue;
        }
        let parent = input.parent().unwrap_or_else(|| Path::new(""));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;

        let (ext, encoder_args): (&str, Vec<String>) = match choice {
            1 => (
                "mp3",
                vec![
                    "-q:a".to_string(),
                    "0".to_string(),
                    "-map".to_string(),
                    "a".to_string(),
                ],
            ),
            2 => (
                "m4a",
                vec![
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "256k".to_string(),
                    "-map".to_string(),
                    "a".to_string(),
                ],
            ),
            3 => (
                "ogg",
                vec![
                    "-c:a".to_string(),
                    "libvorbis".to_string(),
                    "-q:a".to_string(),
                    "10".to_string(),
                    "-map".to_string(),
                    "a".to_string(),
                ],
            ),
            _ => return Err("Unsupported audio mode".to_string()),
        };

        let output = parent.join(format!("{stem}.{}", ext));
        let mut args = vec!["-i".to_string(), file.clone()];
        args.extend(encoder_args);
        args.push(output.to_string_lossy().to_string());
        let label = format!("[v-extractor] {}", input.display());
        run_ffmpeg(&window, &label, args)?;
    }
    Ok(())
}

#[tauri::command]
async fn video_xpress(window: Window, files: Vec<String>, mode: u8) -> Result<(), String> {
    for file in files {
        let input = PathBuf::from(&file);
        if !input.exists() {
            continue;
        }
        let parent = input.parent().unwrap_or_else(|| Path::new(""));
        let stem = input
            .file_stem()
            .and_then(|s| s.to_str())
            .ok_or_else(|| "Invalid file name".to_string())?;

        let (suffix, encoder_args): (&str, Vec<String>) = match mode {
            1 => (
                "_hevc_p7.mp4",
                vec![
                    "-c:v".to_string(),
                    "hevc_nvenc".to_string(),
                    "-preset".to_string(),
                    "p7".to_string(),
                    "-profile:v".to_string(),
                    "main".to_string(),
                    "-rc".to_string(),
                    "vbr".to_string(),
                    "-cq".to_string(),
                    "28".to_string(),
                    "-b:v".to_string(),
                    "0".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "128k".to_string(),
                    "-tag:v".to_string(),
                    "hvc1".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
            ),
            2 => (
                "_hevc_p4.mp4",
                vec![
                    "-c:v".to_string(),
                    "hevc_nvenc".to_string(),
                    "-preset".to_string(),
                    "p4".to_string(),
                    "-profile:v".to_string(),
                    "main".to_string(),
                    "-rc".to_string(),
                    "vbr".to_string(),
                    "-cq".to_string(),
                    "30".to_string(),
                    "-b:v".to_string(),
                    "0".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "128k".to_string(),
                    "-tag:v".to_string(),
                    "hvc1".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
            ),
            3 => (
                "_x265_cpu.mp4",
                vec![
                    "-c:v".to_string(),
                    "libx265".to_string(),
                    "-crf".to_string(),
                    "24".to_string(),
                    "-preset".to_string(),
                    "medium".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "128k".to_string(),
                    "-tag:v".to_string(),
                    "hvc1".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
            ),
            4 => (
                "_x265_fast.mp4",
                vec![
                    "-c:v".to_string(),
                    "libx265".to_string(),
                    "-crf".to_string(),
                    "26".to_string(),
                    "-preset".to_string(),
                    "fast".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "128k".to_string(),
                    "-tag:v".to_string(),
                    "hvc1".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
            ),
            5 => (
                "_h264_nvenc.mp4",
                vec![
                    "-c:v".to_string(),
                    "h264_nvenc".to_string(),
                    "-preset".to_string(),
                    "p7".to_string(),
                    "-rc".to_string(),
                    "vbr".to_string(),
                    "-cq".to_string(),
                    "26".to_string(),
                    "-b:v".to_string(),
                    "0".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "128k".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
            ),
            6 => (
                "_x264_cpu.mp4",
                vec![
                    "-c:v".to_string(),
                    "libx264".to_string(),
                    "-crf".to_string(),
                    "23".to_string(),
                    "-preset".to_string(),
                    "slow".to_string(),
                    "-pix_fmt".to_string(),
                    "yuv420p".to_string(),
                    "-c:a".to_string(),
                    "aac".to_string(),
                    "-b:a".to_string(),
                    "128k".to_string(),
                    "-movflags".to_string(),
                    "+faststart".to_string(),
                ],
            ),
            _ => return Err("Unsupported video mode".to_string()),
        };

        let output = parent.join(format!("{stem}{}", suffix));
        let mut args = vec!["-i".to_string(), file.clone()];
        args.extend(encoder_args);
        args.push(output.to_string_lossy().to_string());
        let label = format!("[video-xpress] {}", input.display());
        run_ffmpeg(&window, &label, args)?;
    }
    Ok(())
}

fn emit_log(window: &Window, message: String) -> Result<(), String> {
    window.emit("ffmpeg-log", message).map_err(|e| e.to_string())
}

fn run_ffmpeg(window: &Window, label: &str, args: Vec<String>) -> Result<(), String> {
    let ffmpeg = ffmpeg_executable()?;
    let command_preview = format!("ffmpeg {}", args.join(" "));
    emit_log(window, format!("{} | {}", label, command_preview))?;
    let status = Command::new(ffmpeg)
        .args(args.iter())
        .status()
        .map_err(|e| e.to_string())?;
    if status.success() {
        emit_log(window, format!("{} | done", label))?;
        Ok(())
    } else {
        emit_log(window, format!("{} | failed", label))?;
        Err(format!("ffmpeg exited with {}", status))
    }
}

fn ffmpeg_executable() -> Result<PathBuf, String> {
    let exe = env::current_exe().map_err(|e| e.to_string())?;
    let dir = exe.parent().ok_or_else(|| "Cannot determine executable directory".to_string())?;
    let candidate_dir = dir.join("ffmpeg").join("bin").join(ffmpeg_filename());
    if candidate_dir.exists() {
        return Ok(candidate_dir);
    }
    let candidate_flat = dir.join(ffmpeg_filename());
    if candidate_flat.exists() {
        return Ok(candidate_flat);
    }
    Err("ffmpeg executable not found next to application".to_string())
}

#[cfg(target_os = "windows")]
fn ffmpeg_filename() -> &'static str {
    "ffmpeg.exe"
}

#[cfg(not(target_os = "windows"))]
fn ffmpeg_filename() -> &'static str {
    "ffmpeg"
}

fn compress_avif(window: &Window, input: &Path, output: &Path, max_size_kb: u64) -> Result<u64, String> {
    let mut crf: u32 = 30;
    loop {
        let args = vec![
            "-i".to_string(),
            input.to_string_lossy().to_string(),
            "-c:v".to_string(),
            "libaom-av1".to_string(),
            "-crf".to_string(),
            crf.to_string(),
            "-b:v".to_string(),
            "0".to_string(),
            "-cpu-used".to_string(),
            "4".to_string(),
            "-row-mt".to_string(),
            "1".to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            output.to_string_lossy().to_string(),
        ];
        let label = format!("[image-squish:avif] {}", input.display());
        run_ffmpeg(window, &label, args)?;
        let size_kb = file_size_kb(output)?;
        if max_size_kb == 0 || size_kb <= max_size_kb || crf >= 60 {
            return Ok(size_kb);
        }
        crf += 5;
    }
}

fn compress_webp(window: &Window, input: &Path, output: &Path, max_size_kb: u64) -> Result<u64, String> {
    let mut quality: i32 = 85;
    loop {
        let args = vec![
            "-i".to_string(),
            input.to_string_lossy().to_string(),
            "-vcodec".to_string(),
            "libwebp".to_string(),
            "-lossless".to_string(),
            "0".to_string(),
            "-q:v".to_string(),
            quality.to_string(),
            "-pix_fmt".to_string(),
            "yuv420p".to_string(),
            output.to_string_lossy().to_string(),
        ];
        let label = format!("[image-squish:webp] {}", input.display());
        run_ffmpeg(window, &label, args)?;
        let size_kb = file_size_kb(output)?;
        if max_size_kb == 0 || size_kb <= max_size_kb || quality <= 10 {
            return Ok(size_kb);
        }
        quality -= 10;
    }
}

fn file_size_kb(path: &Path) -> Result<u64, String> {
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(meta.len() / 1024)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(opener_init())
        .plugin(dialog_init())
        .invoke_handler(tauri::generate_handler![
            greet,
            audio_morph,
            quick_trans_img,
            smart_image_squish,
            v_extractor,
            video_xpress
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
