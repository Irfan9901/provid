use rand::seq::SliceRandom;
use tauri_plugin_shell::ShellExt;

#[tauri::command]
async fn get_video_ratio(app: tauri::AppHandle, path: String) -> Result<String, String> {
    let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;
    
    // Gunakan ffmpeg -i untuk mendapatkan info video jika ffprobe tidak ada
    let output = sidecar
        .args(&["-i", &path])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    // ffmpeg -i mengeluarkan info ke stderr
    let info = String::from_utf8_lossy(&output.stderr);
    
    // Cari pola " 1920x1080" atau similar
    // Biasanya formatnya: ", 1920x1080 [SAR 1:1 DAR 16:9],"
    let re = regex::Regex::new(r" (\d{2,})x(\d{2,})").map_err(|e| e.to_string())?;
    
    if let Some(caps) = re.captures(&info) {
        let w = &caps[1];
        let h = &caps[2];
        return Ok(format!("{}x{}", w, h));
    }

    println!("Full output for debugging: {}", info);
    Err("Could not detect video dimensions from ffmpeg output".to_string())
}

#[tauri::command]
async fn get_video_duration(app: tauri::AppHandle, path: String) -> Result<f64, String> {
    let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;
    
    let output = sidecar
        .args(&["-i", &path])
        .output()
        .await
        .map_err(|e| e.to_string())?;

    let info = String::from_utf8_lossy(&output.stderr);
    
    // Pattern: Duration: 00:00:05.31,
    let re = regex::Regex::new(r"Duration: (\d{2}):(\d{2}):(\d{2}\.\d+)").map_err(|e| e.to_string())?;
    
    if let Some(caps) = re.captures(&info) {
        let hours: f64 = caps[1].parse().unwrap_or(0.0);
        let minutes: f64 = caps[2].parse().unwrap_or(0.0);
        let seconds: f64 = caps[3].parse().unwrap_or(0.0);
        
        let total_seconds = hours * 3600.0 + minutes * 60.0 + seconds;
        return Ok(total_seconds);
    }
    
    Err("Could not detect video duration".to_string())
}

#[tauri::command]
async fn shuffle_videos(paths: Vec<String>) -> Vec<String> {
    let mut shuffled = paths.clone();
    shuffled.shuffle(&mut rand::thread_rng());
    shuffled
}

fn build_subtitle_filter(caption_path: &str, caption_style: &str, position: i32, font_size: u32) -> String {
    // 1. Replace backslashes with forward slashes (FFmpeg prefers /)
    let cleaned_path = caption_path.replace("\\", "/");
    
    // 2. Escape single quotes for inclusion in a single-quoted string
    // ' -> '\''
    let escaped_path = cleaned_path.replace("'", "'\\''");
    
    // 3. Clamp font size to safe range (8-72)
    let safe_font_size = font_size.max(8).min(72);
    
    // 4. Base style with position and font size
    let base_style = format!("FontSize={},MarginV={}", safe_font_size, position);
    
    // 5. Construct filter: subtitles='ESCAPED_PATH':force_style='...'
    match caption_style {
        "bold" => format!("subtitles='{}':force_style='Bold=1,{}'", escaped_path, base_style),
        "outline" => format!("subtitles='{}':force_style='Outline=2,OutlineColour=&H000000&,{}'", escaped_path, base_style),
        "shadow" => format!("subtitles='{}':force_style='Shadow=3,{}'", escaped_path, base_style),
        _ => format!("subtitles='{}':force_style='{}'", escaped_path, base_style),
    }
}

fn get_logo_overlay_coords(position: &str) -> String {
    match position {
        "top-left" => "x=30:y=30".to_string(),
        "top-right" => "x=main_w-overlay_w-30:y=30".to_string(),
        "bottom-left" => "x=30:y=main_h-overlay_h-30".to_string(),
        "bottom-right" => "x=main_w-overlay_w-30:y=main_h-overlay_h-30".to_string(),
        "center" => "x=(main_w-overlay_w)/2:y=(main_h-overlay_h)/2".to_string(),
        _ => "x=main_w-overlay_w-30:y=main_h-overlay_h-30".to_string(),
    }
}

#[derive(serde::Serialize)]
struct StitchResult {
    output_file: String,
    output_folder: String,
}

#[tauri::command]
async fn stitch_videos(
    app: tauri::AppHandle,
    videos: Vec<String>,
    audios: Vec<String>,
    output_base: String,
    count: u32,
    mute_video: bool,
    auto_shuffle: bool,
    ratio: String,
    output_dir: Option<String>,
    logo_path: Option<String>,
    logo_position: String,
    _logo_opacity: f32,
    logo_size: u32,
    captions: Vec<String>,
    caption_style: String,
    caption_position: i32,
    caption_font_size: u32,
) -> Result<StitchResult, String> {
    println!("Stitching with Ratio: {}, Auto Shuffle: {}", ratio, auto_shuffle);
    
    let dest_dir = if let Some(custom_path) = output_dir {
        std::path::PathBuf::from(custom_path)
    } else {
        // Default: outputs folder in project root
        std::env::current_dir().map_err(|e| e.to_string())?.parent().ok_or("Could not find project root")?.join("outputs")
    };

    std::fs::create_dir_all(&dest_dir).map_err(|e| e.to_string())?;

    // If audios are provided, we MUST output exactly as many videos as there are audios
    // This enforces 1-to-1 mapping (one unique audio per output)
    let actual_count = if !audios.is_empty() {
        audios.len() as u32
    } else {
        count
    };

    let mut used_sequences: Vec<Vec<String>> = Vec::new();
    let mut last_output_file = String::new();

    for i in 1..=actual_count {
        // --- Unique Shuffle or Original Order ---
        let mut shuffled_videos = videos.clone();
        
        if auto_shuffle {
            let mut attempts = 0;
            loop {
                shuffled_videos.shuffle(&mut rand::thread_rng());
                
                // Apply Cyclic Shift
                if shuffled_videos.len() > 1 {
                    use rand::Rng;
                    let shift = rand::thread_rng().gen_range(0..shuffled_videos.len());
                    shuffled_videos.rotate_left(shift);
                }

                if !used_sequences.contains(&shuffled_videos) || attempts > 50 {
                    used_sequences.push(shuffled_videos.clone());
                    break;
                }
                attempts += 1;
            }
        }
        
        let vid_list_content = shuffled_videos
            .iter()
            .map(|p| format!("file '{}'\n", p))
            .collect::<String>();
        let vid_list_path = std::env::temp_dir().join(format!("v_list_{}.txt", i));
        std::fs::write(&vid_list_path, vid_list_content).map_err(|e| e.to_string())?;

        // Handle Audio - One unique audio per output
        let has_audio = !audios.is_empty();
        let audio_path = if has_audio {
            // Use the audio at index (i-1) for this output
            Some(audios[(i - 1) as usize].clone())
        } else {
            None
        };

        // Handle Caption - One unique caption per output (matched with audio)
        let caption_path = if !captions.is_empty() && (i as usize) <= captions.len() {
            let cap = captions[(i - 1) as usize].clone();
            if cap.is_empty() { 
                None 
            } else {
                // Validate extension to prevent FFmpeg errors if user forces invalid file
                let lower = cap.to_lowercase();
                if lower.ends_with(".srt") || lower.ends_with(".vtt") || lower.ends_with(".ass") || lower.ends_with(".ssa") {
                    Some(cap)
                } else {
                    println!("Ignoring invalid caption file: {}", cap);
                    None
                }
            }
        } else {
            None
        };

        let base_filename = if count > 1 {
            format!("{}_{:03}", output_base, i)
        } else {
            output_base.clone()
        };

        let mut output_file = dest_dir.join(format!("{}.mp4", base_filename));
        
        // Auto-increment rename if file exists
        let mut version = 1;
        while output_file.exists() {
            output_file = dest_dir.join(format!("{}_{}.mp4", base_filename, version));
            version += 1;
        }
        
        last_output_file = output_file.to_string_lossy().to_string();

        let sidecar = app.shell().sidecar("ffmpeg").map_err(|e: tauri_plugin_shell::Error| e.to_string())?;
        
        


        let mut args = Vec::new();
        args.push("-y".to_string());

        // 1. Setup Input Args
        
        // Input [0]: Video List
        if audio_path.is_some() {
             args.extend(vec!["-stream_loop".to_string(), "-1".to_string()]);
        }
        
        args.extend(vec![
            "-f".to_string(), "concat".to_string(),
            "-safe".to_string(), "0".to_string(),
            "-i".to_string(), vid_list_path.to_string_lossy().into_owned(),
        ]);

        // Input [1]: Audio (Optional)
        if let Some(ref a_path) = audio_path {
            args.extend(vec![
                "-i".to_string(), a_path.to_string(),
            ]);
        }

        // Input [2] or [1]: Logo (Optional)
        // We need to track the logo input index
        let logo_input_index = if audio_path.is_some() { 2 } else { 1 };
        
        if let Some(ref l_path) = logo_path {
             args.extend(vec![
                "-i".to_string(), l_path.to_string(),
            ]);
        }

        // 2. Build Filter Complex
        let mut filter_complex = String::new();
        let mut last_vid_stream = "[0:v]".to_string(); // Start with main video

        // A. Subtitles Filter
        if let Some(ref cap_path) = caption_path {
            let sub_filter = build_subtitle_filter(cap_path, &caption_style, caption_position, caption_font_size);
            // Chain: [last]subtitles=...[v_sub];
            let next_stream = "[v_sub]";
            filter_complex.push_str(&format!("{}{}{};", last_vid_stream, sub_filter, next_stream));
            last_vid_stream = next_stream.to_string();
        }

        // B. Logo Overlay Filter
        if logo_path.is_some() {
            // Scale logo proportionally: user percentage of video width (clamped 5-50%)
            let safe_size = logo_size.max(1).min(50);
            let coords = get_logo_overlay_coords(&logo_position);
            filter_complex.push_str(&format!(
                "[{}:v]scale=iw*{}/100:-1[logo];{}[logo]overlay={}:format=auto[v];",
                logo_input_index, safe_size, last_vid_stream, coords
            ));
            last_vid_stream = "[v]".to_string();
        }

        // Clean up filter string (remove last semicolon)
        if filter_complex.ends_with(";") {
            filter_complex.pop(); 
        }

        // 3. Mapping and Encoding Args
        
        let mut encoding_args = Vec::new();

        // Determine if we are re-encoding
        // Re-encoding is required if:
        // - Audio is provided (we loop video)
        // - Caption is provided (burn-in)
        // - Logo is provided (overlay)
        // - Mute video (if we want to be strict, but copy works for mute)
        
        let need_reencode = audio_path.is_some() || caption_path.is_some() || logo_path.is_some();

        if need_reencode {
             // Map Video
             if !filter_complex.is_empty() {
                 encoding_args.extend(vec![
                     "-filter_complex".to_string(), filter_complex,
                     "-map".to_string(), 
                     // Determine final label
                     // Determine final label
                     if last_vid_stream == "[0:v]" { "0:v".to_string() } else { last_vid_stream },
                 ]);
             } else {
                 // No complex filter, but need re-encode (e.g. just audio replacement)
                 encoding_args.extend(vec![
                    "-map".to_string(), "0:v:0".to_string(),
                 ]);
             }

             // Map Audio
             if let Some(_) = audio_path {
                 encoding_args.extend(vec![
                     "-map".to_string(), "1:a:0".to_string(),
                     "-c:v".to_string(), "libx264".to_string(),
                     "-pix_fmt".to_string(), "yuv420p".to_string(),
                     "-preset".to_string(), "ultrafast".to_string(),
                     "-c:a".to_string(), "aac".to_string(),
                     "-shortest".to_string(), 
                 ]);
             } else {
                 // No custom audio
                 if mute_video {
                     // Muted
                     encoding_args.extend(vec![
                         "-c:v".to_string(), "libx264".to_string(),
                         "-pix_fmt".to_string(), "yuv420p".to_string(),
                         "-preset".to_string(), "ultrafast".to_string(),
                         "-an".to_string(),
                     ]);
                 } else {
                     // Keep original audio (? = optional, avoids error if no audio track)
                     encoding_args.extend(vec![
                         "-map".to_string(), "0:a?".to_string(),
                         "-c:v".to_string(), "libx264".to_string(),
                         "-pix_fmt".to_string(), "yuv420p".to_string(),
                         "-preset".to_string(), "ultrafast".to_string(),
                         "-c:a".to_string(), "aac".to_string(), 
                     ]);
                 }
             }

        } else {
            // Direct Copy Mode (No logo, no caption, no custom audio)
            // But what about mute_video?
             if mute_video {
                 encoding_args.extend(vec![
                    "-c:v".to_string(), "copy".to_string(),
                    "-an".to_string(),
                 ]);
             } else {
                 encoding_args.extend(vec![
                    "-c".to_string(), "copy".to_string(),
                 ]);
             }
        }
        
        args.extend(encoding_args);
        
        // Ensure macOS-compatible mp4 with moov atom at start
        if need_reencode {
            args.extend(vec!["-movflags".to_string(), "+faststart".to_string()]);
        }
        
        args.push(output_file.to_string_lossy().into_owned());

        println!("Running FFmpeg with args: {:?}", args);

        let output = sidecar
            .args(&args)
            .output()
            .await
            .map_err(|e: tauri_plugin_shell::Error| e.to_string())?;

        // Cleanup temporary list files
        let _ = std::fs::remove_file(&vid_list_path);

        if !output.status.success() {
            let stderr = String::from_utf8_lossy(&output.stderr);
            println!("FFmpeg Error: {}", stderr);
            return Err(stderr.to_string());
        }
    }

    Ok(StitchResult {
        output_file: last_output_file,
        output_folder: dest_dir.to_string_lossy().to_string(),
    })
}

// ============================================
// SPLITTER FEATURE
// ============================================

#[derive(serde::Serialize)]
struct SplitResult {
    output_file: String,
    output_folder: String,
}

#[derive(serde::Serialize, serde::Deserialize)]
struct SplitSegment {
    start: String,
    end: String,
}

#[tauri::command]
async fn split_video(
    app: tauri::AppHandle,
    input_path: String,
    segments: Vec<SplitSegment>,
    use_reencode: bool,
    extract_audio: bool,
) -> Result<Vec<SplitResult>, String> {
    // 1. Validate input file exists
    let input = std::path::Path::new(&input_path);
    if !input.exists() {
        return Err("Input file does not exist".to_string());
    }

    // 2. Parse and validate times (HH:MM:SS to seconds)
    fn time_to_secs(t: &str) -> Result<f64, String> {
        let parts: Vec<&str> = t.split(':').collect();
        if parts.len() != 3 {
            return Err(format!("Invalid time format: {}", t));
        }
        let h: f64 = parts[0].parse().map_err(|_| format!("Invalid hours: {}", parts[0]))?;
        let m: f64 = parts[1].parse().map_err(|_| format!("Invalid minutes: {}", parts[1]))?;
        let s: f64 = parts[2].parse().map_err(|_| format!("Invalid seconds: {}", parts[2]))?;
        if h < 0.0 || m < 0.0 || s < 0.0 {
            return Err("Negative time values not allowed".to_string());
        }
        Ok(h * 3600.0 + m * 60.0 + s)
    }


    // 3. Build output path (never overwrite input)
    let mut results = Vec::new();

    // Audio-Only Mode
    if extract_audio {
        let parent = input.parent().unwrap_or(std::path::Path::new("."));
        let stem = input.file_stem().unwrap_or_default().to_string_lossy();
        
        let mut output_audio = parent.join(format!("{}_audio.m4a", stem));
        let mut counter = 1;
        while output_audio.exists() {
            output_audio = parent.join(format!("{}_audio_{}.m4a", stem, counter));
            counter += 1;
        }

        let mut args = Vec::new();
        args.push("-y".to_string());
        args.extend(vec![
            "-i".to_string(), input_path.clone(),
            "-vn".to_string(), // No video
        ]);

        // Try copy first if possible (but container might mismatch), safe default is re-encode to aac
        // To be safe and compatible: re-encode aac
        args.extend(vec![
            "-c:a".to_string(), "aac".to_string(),
            "-b:a".to_string(), "192k".to_string(),
        ]);

        args.push(output_audio.to_string_lossy().into_owned());
        
        println!("Running FFmpeg Audio Extract: {:?}", args);
        let output = app.shell()
            .sidecar("ffmpeg")
            .map_err(|e: tauri_plugin_shell::Error| e.to_string())?
            .args(&args)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        
        if !output.status.success() {
             return Err(format!("Audio extraction failed: {}", String::from_utf8_lossy(&output.stderr)));
        }
        
        results.push(SplitResult {
             output_file: output_audio.to_string_lossy().to_string(),
             output_folder: parent.to_string_lossy().to_string(),
        });

        // if audio only, we might return here if no segments provided?
        if segments.is_empty() {
             return Ok(results);
        }
    }

    // Process Segments
    for (i, seg) in segments.iter().enumerate() {
        let start_secs = time_to_secs(&seg.start)?;
        let end_secs = time_to_secs(&seg.end)?;

        if start_secs >= end_secs {
            return Err(format!("Segment {}: Start time must be before end time", i+1));
        }

        let parent = input.parent().unwrap_or(std::path::Path::new("."));
        let stem = input.file_stem().unwrap_or_default().to_string_lossy();
        let ext = input.extension().unwrap_or_default().to_string_lossy();
        
        // Auto-naming: video_cut_001.mp4
        let suffix = format!("cut_{:03}", i + 1);
        let mut output_file = parent.join(format!("{}_{}.{}", stem, suffix, ext));
        
        // Safety check to avoiding overwriting existing files from previous runs
        let mut counter = 1;
        while output_file.exists() {
             output_file = parent.join(format!("{}_{}_{}.{}", stem, suffix, counter, ext));
             counter += 1;
        }

        let mut args = Vec::new();
        args.push("-y".to_string());
        args.extend(vec![
            "-i".to_string(), input_path.clone(),
            "-ss".to_string(), seg.start.clone(),
            "-to".to_string(), seg.end.clone(),
        ]);

        if use_reencode {
            args.extend(vec![
                "-c:v".to_string(), "libx264".to_string(),
                "-pix_fmt".to_string(), "yuv420p".to_string(),
                "-preset".to_string(), "ultrafast".to_string(),
                "-c:a".to_string(), "aac".to_string(),
                "-movflags".to_string(), "+faststart".to_string(),
            ]);
        } else {
            args.extend(vec![
                "-c".to_string(), "copy".to_string(),
                "-avoid_negative_ts".to_string(), "make_zero".to_string(),
            ]);
        }

        args.push(output_file.to_string_lossy().into_owned());
        println!("Running FFmpeg Split Segment {}: {:?}", i+1, args);

        let output = app.shell()
            .sidecar("ffmpeg")
            .map_err(|e: tauri_plugin_shell::Error| e.to_string())?
            .args(&args)
            .output()
            .await
            .map_err(|e| e.to_string())?;
        
        if !output.status.success() {
             return Err(format!("Segment {} failed: {}", i+1, String::from_utf8_lossy(&output.stderr)));
        }
        
        results.push(SplitResult {
             output_file: output_file.to_string_lossy().to_string(),
             output_folder: parent.to_string_lossy().to_string(),
        });
    }

    Ok(results)
}

#[tauri::command]
async fn generate_thumbnails(
    app: tauri::AppHandle,
    input_path: String,
    duration: f64,
    count: usize,
) -> Result<Vec<String>, String> {
     // Generate count thumbnails
     // fps = count / duration
     // But to be safe and simple: generate 10 frames at interval
     // ffmpeg -i input -vf "fps=1/INTERVAL" ...
     
     let interval = duration / (count as f64);
     let fps_filter = format!("fps=1/{:.4},scale=160:-1", interval);
     
     // Use temp dir
     let temp_dir = std::env::temp_dir();
     let stem = std::path::Path::new(&input_path).file_stem().unwrap_or_default().to_string_lossy();
     // Clean up old thumbs?
     
     let output_pattern = temp_dir.join(format!("{}_thumb_%03d.jpg", stem));
     
     let sidecar = app.shell().sidecar("ffmpeg").map_err(|e| e.to_string())?;
     
     let args = vec![
        "-y".to_string(),
        "-i".to_string(), input_path.clone(),
        "-vf".to_string(), fps_filter,
        "-vframes".to_string(), count.to_string(),
        output_pattern.to_string_lossy().into_owned(),
     ];
     
     println!("Generating thumbnails: {:?}", args);
     let output = sidecar.args(&args).output().await.map_err(|e| e.to_string())?;
     
     if !output.status.success() {
          return Err(format!("Thumb gen failed: {}", String::from_utf8_lossy(&output.stderr)));
     }
     
     // Collect generated paths
     let mut paths = Vec::new();
     for i in 1..=count {
         let p = temp_dir.join(format!("{}_thumb_{:03}.jpg", stem, i));
         if p.exists() {
             paths.push(p.to_string_lossy().to_string());
         }
     }
     
     Ok(paths)
}


#[tauri::command]
async fn open_folder(app: tauri::AppHandle, path: String) -> Result<(), String> {
    let sidecar = app.shell();
    
    #[cfg(target_os = "macos")]
    let command = "open";
    
    #[cfg(target_os = "windows")]
    let command = "explorer";
    
    #[cfg(target_os = "linux")]
    let command = "xdg-open";
    
    sidecar
        .command(command)
        .args(&[&path])
        .spawn()
        .map_err(|e| e.to_string())?;
    
    Ok(())
}

#[tauri::command]
async fn open_output_folder(app: tauri::AppHandle, folder_path: String) -> Result<(), String> {
    let path = std::path::Path::new(&folder_path);
    if !path.exists() || !path.is_dir() {
        return Err("Folder does not exist".to_string());
    }

    let sidecar = app.shell();
    
    #[cfg(target_os = "macos")]
    let command = "open";
    
    #[cfg(target_os = "windows")]
    let command = "explorer";
    
    #[cfg(target_os = "linux")]
    let command = "xdg-open";
    
    sidecar
        .command(command)
        .args(&[&folder_path])
        .spawn()
        .map_err(|e| e.to_string())?;
    
    Ok(())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_shell::init())
        .plugin(tauri_plugin_dialog::init())
        .invoke_handler(tauri::generate_handler![
            shuffle_videos, 
            stitch_videos, 
            get_video_ratio, 
            open_folder,
            get_video_duration,
            open_output_folder,
            split_video,
            generate_thumbnails
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
