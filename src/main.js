console.log("Checking for window.__TAURI__ structure...");
if (window.__TAURI__) {
  console.log("window.__TAURI__ keys:", Object.keys(window.__TAURI__));
  if (window.__TAURI__.core) console.log("window.__TAURI__.core keys:", Object.keys(window.__TAURI__.core));
  if (window.__TAURI__.dialog) console.log("window.__TAURI__.dialog found!");
}

// Safe Tauri API access
let invoke = () => console.warn("Tauri invoke not available");
if (window.__TAURI__ && window.__TAURI__.core) {
  console.log("Tauri API (v2) core found");
  invoke = window.__TAURI__.core.invoke;
} else {
  console.error("Tauri API (v2) core NOT found on window object");
}

// State management
let videos = [];
let audios = [];
let customOutputPath = null;
let lastOutputPath = null; // Store the last successful output path

// Logo and Caption state
let logoFile = null;
let logoEnabled = false;
let captionFiles = []; // Array of {name, path}
let captionEnabled = false;
let captionPosition = 0;
let captionPositionPreset = 'bottom';



// DOM Elements
let videoDrop, audioDrop, videoList, audioList;
let selectAllVideo, selectAllAudio, stitchBtn;
let outputName, outputCount, statusText, themeToggle;

function init() {
  console.log("Initializing app...");
  
  // Initialize Stitcher elements with explicit checks
  videoDrop = document.getElementById('videoDrop');
  audioDrop = document.getElementById('audioDrop');
  videoList = document.getElementById('videoList');
  audioList = document.getElementById('audioList');
  selectAllVideo = document.getElementById('selectAllVideo');
  selectAllAudio = document.getElementById('selectAllAudio');
  stitchBtn = document.getElementById('stitchBtn');
  outputName = document.getElementById('outputName');
  outputCount = document.getElementById('outputCount');
  statusText = document.getElementById('statusText');
  themeToggle = document.getElementById('themeToggle');

  // Verify critical elements
  if (!stitchBtn) console.error("CRITICAL: stitchBtn not found!");
  if (!videoList) console.error("CRITICAL: videoList not found!");
  if (!statusText) console.error("CRITICAL: statusText not found!");

  // Helpers for Stitcher Status to avoid conflict
  window.updateStitchStatus = (msg, cls) => {
      if (statusText) {
          statusText.textContent = msg;
          statusText.className = cls;
      }
  };

  // Setup Drag & Drop for Stitcher
  if (videoDrop) {
      setupDropZone(videoDrop, 'video', async (files) => {
        console.log("Stitcher: Videos dropped", files.length);
        
        // Ratio Check Logic
        let baseRatio = (videos.length > 0 && videos[0].ratio) ? videos[0].ratio : null;
        let mismatchFound = false;
        let mismatchNames = [];

        for (const file of files) {
          if (!file.path) continue;
          try {
            const dimensions = await invoke("get_video_ratio", { path: file.path });
            file.ratio = dimensions; 
            if (!baseRatio) baseRatio = dimensions;
            else if (baseRatio !== dimensions) {
              mismatchFound = true;
              mismatchNames.push(`${file.name} (${dimensions})`);
            }
          } catch (e) {
            console.error("Dimension detection failed:", file.name, e);
          }
        }

        if (mismatchFound) {
          alert(`⚠️ Ratio Mismatch Detected!\n\nDiffering videos:\n- ${mismatchNames.join('\n- ')}\n\nBase: ${baseRatio}`);
        }

        videos = [...videos, ...files];
        renderList(videoList, videos, 'video');
        updateUniqueCount();
      });
  }

  if (audioDrop) {
      setupDropZone(audioDrop, 'audio', (files) => {
        audios = [...audios, ...files];
        renderList(audioList, audios, 'audio');
        updatePairingStatus();
      });
  }

  // Theme Toggle
  if (themeToggle) themeToggle.addEventListener('click', toggleTheme);

  // Select All logic
  if (selectAllVideo) selectAllVideo.addEventListener('change', (e) => toggleSelectAll(e.target.checked, 'video'));
  if (selectAllAudio) selectAllAudio.addEventListener('change', (e) => toggleSelectAll(e.target.checked, 'audio'));

  // Stitch Button Logic - Explicitly attached here
  if (stitchBtn) {
      console.log("Attaching click listener to Stitch Button");
      stitchBtn.addEventListener('click', async () => {
          console.log("Stitch Button Clicked");
          await startStitching(); 
      });
  }

  // Clear Logic
  const clearVideosBtn = document.getElementById('clearVideos');
  if (clearVideosBtn) {
      clearVideosBtn.addEventListener('click', () => {
        videos = [];
        renderList(videoList, videos, 'video');
        updateUniqueCount();
      });
  }

  const clearAudiosBtn = document.getElementById('clearAudios');
  if (clearAudiosBtn) {
      clearAudiosBtn.addEventListener('click', () => {
        audios = [];
        renderList(audioList, audios, 'audio');
        updatePairingStatus();
      });
  }

  // Folder selection
  const selectFolderBtn = document.getElementById('selectFolderBtn');
  if (selectFolderBtn) {
      selectFolderBtn.addEventListener('click', async () => {
        try {
          const selected = await window.__TAURI__.core.invoke("plugin:dialog|open", {
            options: {
              directory: true,
              multiple: false,
              title: "Select Output Folder"
            }
          });
          if (selected) {
            customOutputPath = selected;
            selectFolderBtn.textContent = "📁 " + selected.split(/[\/\\]/).pop();
          }
        } catch (err) {
          console.error("Folder error:", err);
        }
      });
  }

  // Open Folder button
  const openFolderBtn = document.getElementById('openFolderBtn');
  if (openFolderBtn) {
      openFolderBtn.addEventListener('click', async () => {
        if (lastOutputPath) {
          try {
            await invoke("open_folder", { path: lastOutputPath });
          } catch (err) {
            console.error("Error opening folder:", err);
            alert("Failed: " + err);
          }
        }
      });
  }
  
  // Setup Logo and Caption features
  setupLogoFeature();
  setupCaptionFeature();
  
  // Setup Tabs and Splitter
  setupTabs();
  setupSplitterFeature();
}

function setupLogoFeature() {
  const enableLogo = document.getElementById('enableLogo');
  const logoContent = document.getElementById('logoContent');
  const logoUploadBtn = document.getElementById('logoUploadBtn');
  const logoFileName = document.getElementById('logoFileName');
  const logoOpacity = document.getElementById('logoOpacity');
  const logoOpacityValue = document.getElementById('logoOpacityValue');

  // Toggle logo content visibility
  enableLogo.addEventListener('change', (e) => {
    logoEnabled = e.target.checked;
    logoContent.style.display = logoEnabled ? 'block' : 'none';
  });

  // Logo file upload
  logoUploadBtn.addEventListener('click', async () => {
    try {
      const selected = await window.__TAURI__.core.invoke("plugin:dialog|open", {
        options: {
          multiple: false,
          filters: [{
            name: 'Images',
            extensions: ['png', 'jpg', 'jpeg', 'svg', 'gif']
          }]
        }
      });

      if (selected) {
        logoFile = selected;
        const fileName = selected.split('/').pop() || selected.split('\\').pop();
        logoFileName.textContent = fileName;
      }
    } catch (err) {
      console.error("Logo file selection error:", err);
    }
  });

  // Opacity slider
  logoOpacity.addEventListener('input', (e) => {
    logoOpacityValue.textContent = e.target.value;
  });

  // Size slider
  const logoSize = document.getElementById('logoSize');
  const logoSizeValue = document.getElementById('logoSizeValue');
  logoSize.addEventListener('input', (e) => {
    logoSizeValue.textContent = e.target.value;
  });
}

function setupCaptionFeature() {
  const enableCaption = document.getElementById('enableCaption');
  const captionContent = document.getElementById('captionContent');
  const captionDrop = document.getElementById('captionDrop');
  const captionList = document.getElementById('captionList');
  const clearCaptions = document.getElementById('clearCaptions');
  
  const captionPositionPreset = document.getElementById('captionPositionPreset');
  const captionPositionSlider = document.getElementById('captionPosition');
  const captionPositionValue = document.getElementById('captionPositionValue');

  // Toggle caption content visibility
  enableCaption.addEventListener('change', (e) => {
    captionEnabled = e.target.checked;
    captionContent.style.display = captionEnabled ? 'block' : 'none';
  });

  // Setup Drag & Drop for Captions
  setupDropZone(captionDrop, 'caption', (files) => {
    captionFiles = [...captionFiles, ...files];
    renderCaptionList();
    updatePairingStatus();
  });

  // Clear Captions
  clearCaptions.addEventListener('click', () => {
    captionFiles = [];
    renderCaptionList();
    updatePairingStatus();
  });

  // Position Controls
  captionPositionPreset.addEventListener('change', (e) => {
    const preset = e.target.value;
    let val = 0;
    if (preset === 'top') val = 200;
    if (preset === 'middle') val = 100;
    if (preset === 'bottom') val = 0;
    
    captionPositionSlider.value = val;
    captionPositionValue.textContent = val;
    captionPosition = val;
  });

  captionPositionSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    captionPosition = val;
    captionPositionValue.textContent = val;
    
    // Update preset dropdown if matches specific values
    if (val === 0) captionPositionPreset.value = 'bottom';
    else if (val === 100) captionPositionPreset.value = 'middle';
    else if (val === 200) captionPositionPreset.value = 'top';
  });

  // Font Size slider
  const captionFontSize = document.getElementById('captionFontSize');
  const captionFontSizeValue = document.getElementById('captionFontSizeValue');
  captionFontSize.addEventListener('input', (e) => {
    captionFontSizeValue.textContent = e.target.value;
  });
}

function renderCaptionList() {
  const container = document.getElementById('captionList');
  container.innerHTML = '';
  
  captionFiles.forEach((file, index) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.innerHTML = `
      <div class="item-main">
        <span>${file.name}</span>
      </div>
      <button class="item-remove" onclick="removeCaption(${index})">✕</button>
    `;
    container.appendChild(li);
  });
}

function removeCaption(index) {
  captionFiles.splice(index, 1);
  renderCaptionList();
  updatePairingStatus();
}

function updatePairingStatus() {
  const pairingContainer = document.getElementById('pairingStatus');
  const list = document.getElementById('pairingList');
  
  if (!captionEnabled || audios.length === 0) {
    pairingContainer.style.display = 'none';
    return;
  }
  
  pairingContainer.style.display = 'block';
  list.innerHTML = '';
  
  audios.forEach(audio => {
    const audioName = audio.name;
    const audioBase = audioName.replace(/\.[^/.]+$/, "").toLowerCase();
    
    // Find matching caption
    const match = captionFiles.find(cap => {
      const capBase = cap.name.replace(/\.[^/.]+$/, "").toLowerCase();
      // Match if basenames are same OR one contains the other (simple heuristic)
      return capBase === audioBase; 
    });
    
    const div = document.createElement('div');
    if (match) {
      div.className = 'pairing-item matched';
      div.innerHTML = `
        <span class="pairing-icon">🎵</span><span class="pairing-name">${audioName}</span>
        <span class="pairing-arrow">➜</span>
        <span class="pairing-icon">📝</span><span class="pairing-name">${match.name}</span>
      `;
    } else {
      div.className = 'pairing-item unmatched';
      div.innerHTML = `
        <span class="pairing-icon">🎵</span><span class="pairing-name">${audioName}</span>
        <span class="pairing-arrow">➜</span>
        <span class="pairing-name">(No caption match)</span>
      `;
    }
    list.appendChild(div);
  });
}


function updateUniqueCount() {
  const n = videos.length;
  const badge = document.getElementById('uniqueCountBadge');
  
  if (n === 0) {
    badge.textContent = `0 kombinasi`;
    return;
  }

  // Factorial calculation
  let fact = 1;
  let isHuge = false;
  for (let i = 2; i <= n; i++) {
    fact *= i;
    if (fact > 1000000000) {
      isHuge = true;
      break;
    }
  }

  let text = '';
  if (isHuge) {
    text = `>1 Miliar kombinasi`;
  } else {
    text = `${fact.toLocaleString()} kombinasi unik`;
  }
  
  badge.textContent = text;
}

function setupDropZone(zone, type, onFilesDropped) {
  let extensions = [];
  let filterName = '';

  if (type === 'video') {
    extensions = ['mp4', 'mkv', 'mov', 'avi'];
    filterName = 'Videos';
  } else if (type === 'audio') {
    extensions = ['mp3', 'wav', 'm4a', 'ogg'];
    filterName = 'Audios';
  } else if (type === 'caption') {
    extensions = ['srt', 'vtt', 'ass', 'ssa'];
    filterName = 'Subtitles';
  }

  zone.addEventListener('dragover', (e) => {
    e.preventDefault();
    zone.classList.add('dragover');
  });

  zone.addEventListener('dragleave', () => {
    zone.classList.remove('dragover');
  });

  zone.addEventListener('drop', (e) => {
    e.preventDefault();
    zone.classList.remove('dragover');

    // In Tauri, File object usually has a 'path' property
    const droppedFiles = Array.from(e.dataTransfer.files).map(file => {
      return {
        name: file.name,
        path: file.path || file.webkitRelativePath || ""
      };
    }).filter(file => {
      // Use dynamic extensions regex
      const regex = new RegExp(`\\.(${extensions.join('|')})$`, 'i');
      return file.name.match(regex);
    });

      // Filter out duplicates
      const uniqueFiles = droppedFiles.filter(newFile => {
        const isDuplicate = (type === 'video' ? videos : audios).some(existing => existing.path === newFile.path);
        if (isDuplicate) {
          console.log(`Duplicate ${type} skipped:`, newFile.name);
        }
        return !isDuplicate;
      });

      if (uniqueFiles.length > 0) {
        onFilesDropped(uniqueFiles);
      }
      
      if (uniqueFiles.length < droppedFiles.length) {
         updateStatus(`Info: ${droppedFiles.length - uniqueFiles.length} duplicate(s) skipped.`, 'info');
      } else if (droppedFiles.length === 0) {
         // Maybe dropped wrong files entirely
         updateStatus(`Please drop only ${type} files (${extensions.join(', ')}).`, 'error');
      }
  });

  // Clicking the zone opens Tauri file dialog
  zone.addEventListener('click', async () => {
    console.log(`Click event triggered for ${type} zone`);
    try {
      if (!window.__TAURI__) {
        console.error("Critical: window.__TAURI__ is missing");
        alert("Tauri API not found. Please run this in the app.");
        return;
      }

      console.log(`Attempting to open dialog for ${type}...`);
      // In Tauri v2, plugin arguments must be wrapped in an 'options' key
      const selected = await window.__TAURI__.core.invoke("plugin:dialog|open", {
        options: {
          multiple: true,
          filters: [{
            name: filterName,
            extensions: extensions
          }]
        }
      });

      console.log("Dialog selection result:", selected);

      if (selected && selected.length > 0) {
        // Tauri dialog returns an array of paths (strings)
        const fileObjects = selected.map(path => {
          const name = path.split('/').pop() || path.split('\\').pop();
          return { name, path };
        });
        await onFilesDropped(fileObjects);
      }
    } catch (err) {
      console.error("Dialog error:", err);
      updateStatus(`Error: ${err.message || err}`, 'error');
    }
  });
}

function renderList(container, fileArray, type) {
  container.innerHTML = '';
  
  // Patokan ratio adalah video pertama di daftar
  const baseRatio = (type === 'video' && fileArray.length > 0) ? fileArray[0].ratio : null;

  fileArray.forEach((file, index) => {
    const li = document.createElement('li');
    li.className = 'file-item';
    
    let ratioHtml = '';
    if (file.ratio) {
      const isMismatch = baseRatio && file.ratio !== baseRatio;
      ratioHtml = `<small class="file-ratio ${isMismatch ? 'ratio-bad' : ''}">(${file.ratio})</small>`;
    }

    li.innerHTML = `
      <div class="item-main">
        <input type="checkbox" checked class="${type}-checkbox" data-index="${index}">
        <span>${file.name} ${ratioHtml}</span>
      </div>
      <button class="item-remove" onclick="removeFile('${type}', ${index})">✕</button>
    `;
    container.appendChild(li);
  });
}

function removeFile(type, index) {
  if (type === 'video') {
    videos.splice(index, 1);
    renderList(videoList, videos, 'video');
    updateUniqueCount();
  } else {
    audios.splice(index, 1);
    renderList(audioList, audios, 'audio');
    updatePairingStatus();
  }
}

function toggleSelectAll(checked, type) {
  const checkboxes = document.querySelectorAll(`.${type}-checkbox`);
  checkboxes.forEach(cb => cb.checked = checked);
}

function toggleTheme() {
  const isDark = document.body.classList.toggle('dark-mode');
  const icon = document.getElementById('themeIcon');
  const text = document.getElementById('themeText');

  if (isDark) {
    icon.textContent = '☀️';
    text.textContent = 'Light Mode';
  } else {
    icon.textContent = '🌙';
    text.textContent = 'Dark Mode';
  }
}


function updateStatus(msg, cls) {
  if (statusText) {
    statusText.textContent = msg;
    statusText.className = cls || '';
  }
}

async function startStitching() {
  const count = parseInt(outputCount.value);
  const name = outputName.value;

  // Filter selected videos and audios based on checkboxes
  const selectedVideoIndices = Array.from(document.querySelectorAll('.video-checkbox'))
    .filter(cb => cb.checked)
    .map(cb => parseInt(cb.dataset.index));

  const selectedAudioIndices = Array.from(document.querySelectorAll('.audio-checkbox'))
    .filter(cb => cb.checked)
    .map(cb => parseInt(cb.dataset.index));

  const selectedVideoPaths = selectedVideoIndices.map(idx => videos[idx].path || videos[idx].name);
  const selectedAudioPaths = selectedAudioIndices.map(idx => audios[idx].path || audios[idx].name);
  const muteVideo = document.getElementById('muteOriginal').checked;
  const autoShuffle = document.getElementById('autoShuffle').checked;
  const ratio = document.getElementById('outputRatio').value;

  if (selectedVideoPaths.length === 0) {
    updateStatus('Error: No videos selected!', 'error');
    return;
  }

  // If audios are present, override count to match audio count
  let finalCount = count;
  if (selectedAudioPaths.length > 0) {
    if (count !== selectedAudioPaths.length) {
      console.log(`Overriding count ${count} to match audio count ${selectedAudioPaths.length}`);
      updateStatus(`Mode: ${selectedAudioPaths.length} Video Output (1 Audio unik per video)`, 'info');
    }
    finalCount = selectedAudioPaths.length;
  }

  // Hide Open Folder button when processing starts
  const openFolderBtn = document.getElementById('openFolderBtn');
  if (openFolderBtn) openFolderBtn.style.display = 'none';

  updateStatus('Processing...', 'processing');
  console.log("Invoking stitch_videos...", { selectedVideoPaths, selectedAudioPaths, name, count, muteVideo, autoShuffle, ratio });

  try {
    // ... (logo/caption logic) ...
    // Get logo and caption settings
    const logoPosition = document.getElementById('logoPosition').value;
    const logoOpacity = parseFloat(document.getElementById('logoOpacity').value) / 100;
    const captionStyle = document.getElementById('captionStyle').value;

    // Prepare matched captions list
    let finalCaptions = [];
    if (captionEnabled && captionFiles.length > 0) {
      finalCaptions = selectedAudioPaths.map(audioPath => {
        // Extract basename
        // Handle both separators (\ and /)
        const audioName = audioPath.split('/').pop().split('\\').pop(); 
        const audioBase = audioName.replace(/\.[^/.]+$/, "").toLowerCase();
        
        // Find match
        const match = captionFiles.find(cap => {
          const capBase = cap.name.replace(/\.[^/.]+$/, "").toLowerCase();
          return capBase === audioBase;
        });
        
        return match ? match.path : ""; 
      });
    }

    // Panggil Tauri command "stitch_videos"
    const result = await invoke("stitch_videos", {
      videos: selectedVideoPaths,
      audios: selectedAudioPaths,
      outputBase: name,
      count: finalCount,
      muteVideo: muteVideo,
      autoShuffle: autoShuffle,
      ratio: ratio,
      outputDir: customOutputPath,
      logoPath: logoEnabled ? logoFile : null,
      logoPosition: logoPosition,
      logoOpacity: logoOpacity,
      logoSize: parseInt(document.getElementById('logoSize').value),
      captions: captionEnabled ? finalCaptions : [],
      captionStyle: captionStyle,
      captionPosition: parseInt(captionPosition),
      captionFontSize: parseInt(document.getElementById('captionFontSize').value)
    });

    // result is now { output_file: String, output_folder: String }
    const successMsg = `Done! All files saved in '${result.output_folder}' folder.`;
    updateStatus(successMsg, 'done');
    
    // Store output path and show Open Folder button
    lastOutputPath = result.output_folder;
    if (openFolderBtn) {
        openFolderBtn.style.display = 'inline-block';
        // Ensure it is visible in Stitcher status area (it should be)
    }
  } catch (err) {
    console.error("Stitch error:", err);
    // err might be an object or a string from invoke
    const errorMsg = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
    updateStatus(`Error: ${errorMsg}`, 'error');
  }

}


window.addEventListener('DOMContentLoaded', init);

// ============================================
// TAB NAVIGATION (isolated, no impact on features)
// ============================================
// ============================================
// TAB NAVIGATION (isolated, no impact on features)
// ============================================
function setupTabs() {
  const tabBtns = document.querySelectorAll('.tab-btn');
  const tabContents = document.querySelectorAll('.tab-content');
  
  // Status Groups
  const stitcherGroup = document.getElementById('statusStitcherGroup');
  const splitterGroup = document.getElementById('statusSplitterGroup');

  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-tab');
      
      // Deactivate all
      tabBtns.forEach(b => b.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));
      
      // Activate clicked
      btn.classList.add('active');
      const target = document.getElementById(targetId);
      if (target) target.classList.add('active');
      
      // Toggle Status Visibility
      if (targetId === 'stitcher-content') {
        if(stitcherGroup) stitcherGroup.style.display = 'inline';
        if(splitterGroup) splitterGroup.style.display = 'none';
      } else {
        if(stitcherGroup) stitcherGroup.style.display = 'none';
        if(splitterGroup) splitterGroup.style.display = 'inline';
      }
    });
  });
}

// ============================================
// SPLITTER FEATURE (fully isolated)
// ============================================


// ============================================
// SPLITTER FEATURE (Pro Version)
// ============================================
let splitterFile = null;
let splitterDuration = 0;
let segments = [{ start: "00:00:00", end: "00:00:10" }];

function setupSplitterFeature() {
  const fileBtn = document.getElementById('splitterFileBtn');
  const fileName = document.getElementById('splitterFileName');
  const durationLabel = document.getElementById('splitterDurationLabel');
  const splitBtn = document.getElementById('splitBtn');
  const statusText = document.getElementById('splitterStatusText'); // Note: This ref might need update if we moved it?
  // Actually, statusText is getting ref from 'splitterStatusText'. 
  // In index.html step 795, I kept 'splitterStatusText' but moved it. So ID is valid.
  
  const openFolderBtn = document.getElementById('openSplitterFolderBtn');
  const segmentList = document.getElementById('segmentList');
  const addSegmentBtn = document.getElementById('addSegmentBtn');
  const extractAudioCb = document.getElementById('extractAudio');
  
  // Output Folder UI Refs
  const splitterFolderBtn = document.getElementById('splitterFolderBtn');
  const splitterFolderName = document.getElementById('splitterFolderName');
  
  // Render initial segment list
  renderSegments();

  // Helper: Format seconds to HH:MM:SS
  const formatTime = (secs) => {
    const h = Math.floor(secs / 3600);
    const m = Math.floor((secs % 3600) / 60);
    const s = Math.floor(secs % 60);
    return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  };

  // Helper: Render segments
  function renderSegments() {
    segmentList.innerHTML = '';
    const isAudioMode = extractAudioCb.checked;
    
    if (isAudioMode) {
        segmentList.innerHTML = '<div style="opacity: 0.7; font-style: italic; padding: 10px;">Full audio will be extracted. Segment selection disabled.</div>';
        addSegmentBtn.style.display = 'none';
        return;
    }
    
    addSegmentBtn.style.display = 'block';

    segments.forEach((seg, idx) => {
      const row = document.createElement('div');
      row.className = 'segment-row';
      row.innerHTML = `
        <span class="segment-idx">${idx + 1}</span>
        <input type="text" class="time-input start-time" value="${seg.start}" data-idx="${idx}" data-field="start">
        <span class="arrow">➜</span>
        <input type="text" class="time-input end-time" value="${seg.end}" data-idx="${idx}" data-field="end">
        <button class="btn-icon remove-segment" style="visibility: ${segments.length > 1 ? 'visible' : 'hidden'}">❌</button>
      `;
      
      // Event listeners for inputs
      const startInput = row.querySelector('.start-time');
      const endInput = row.querySelector('.end-time');
      
      startInput.addEventListener('change', (e) => { segments[idx].start = e.target.value; });
      endInput.addEventListener('change', (e) => { segments[idx].end = e.target.value; });
      
      // Remove button
      row.querySelector('.remove-segment').addEventListener('click', () => {
        segments.splice(idx, 1);
        renderSegments();
      });
      
      segmentList.appendChild(row);
    });
  }

  // Add Segment Button
  addSegmentBtn.addEventListener('click', () => {
    let newStart = "00:00:00";
    let newEnd = "00:00:10";
    
    if (segments.length > 0) {
        const last = segments[segments.length - 1];
        newStart = last.end; 
    }
    
    segments.push({ start: newStart, end: newEnd });
    renderSegments();
  });

  // Audio checkbox listener
  extractAudioCb.addEventListener('change', () => {
      renderSegments();
      if (extractAudioCb.checked) {
          splitBtn.innerHTML = "🎵 Extract Audio";
      } else {
          splitBtn.innerHTML = "✂️ Process Split";
      }
  });

  // Output Folder Picker (UI Visual Only)
  if (splitterFolderBtn) {
    splitterFolderBtn.addEventListener('click', async () => {
      try {
        const selected = await window.__TAURI__.core.invoke("plugin:dialog|open", {
          options: {
            directory: true,
            multiple: false
          }
        });
        
        if (selected) {
           splitterFolderName.textContent = selected;
        }
      } catch (err) {
        console.error('Folder selection error:', err);
      }
    });
  }

  // File picker
  fileBtn.addEventListener('click', async () => {
    try {
      const selected = await window.__TAURI__.core.invoke("plugin:dialog|open", {
        options: {
          multiple: false,
          filters: [{
            name: 'Videos',
            extensions: ['mp4', 'mov', 'avi', 'mkv', 'webm', 'flv', 'wmv']
          }]
        }
      });
      
      if (selected) {
        splitterFile = selected;
        const name = selected.split('/').pop() || selected.split('\\').pop();
        fileName.textContent = name;
        
        // Reset status
        if(statusText) {
             statusText.textContent = "Idle";
             statusText.className = "";
        }
        
        // Auto-detect duration
        try {
          const dur = await invoke("get_video_duration", { path: selected });
          splitterDuration = dur;
          
          const formattedDur = formatTime(dur);
          durationLabel.textContent = `Duration: ${formattedDur}`;
          
          segments = [{ start: "00:00:00", end: formatTime(Math.min(dur, 10)) }];
          renderSegments();
          
        } catch (e) {
          durationLabel.textContent = 'Duration: unknown';
          console.error('Duration detection failed:', e);
        }
      }
    } catch (err) {
      console.error('File selection error:', err);
    }
  });
  
  // Split button
  splitBtn.addEventListener('click', async () => {
    if (!splitterFile) {
      if(statusText) {
          statusText.textContent = 'Please select a video file first.';
          statusText.className = 'error';
      }
      return;
    }
    
    // Check if audio only
    const extractAudio = extractAudioCb.checked;
    
    if(statusText) {
        statusText.textContent = extractAudio ? 'Extracting audio...' : 'Processing segments...';
        statusText.className = 'processing';
    }
    splitBtn.disabled = true;
    if(openFolderBtn) openFolderBtn.style.display = 'none';
    
    const useReencode = document.getElementById('splitterReencode').checked;
    
    try {
      const results = await invoke("split_video", {
        inputPath: splitterFile,
        segments: extractAudio ? [] : segments,
        useReencode: useReencode,
        extractAudio: extractAudio
      });
      
      if(statusText) {
          statusText.textContent = `Success! Generated ${results.length} file(s).`;
          statusText.className = 'success';
      }
      
      // Show open folder button
      if (results.length > 0 && openFolderBtn) {
          openFolderBtn.style.display = 'inline-block';
          // Ensure it's visible in current tab? Handled by setupTabs logic mostly, 
          // but we should set the display. setupTabs toggles the GROUP.
          
          const outFolder = results[0].output_folder; 
          openFolderBtn.onclick = async () => {
            try {
              await invoke("open_output_folder", { folderPath: outFolder });
            } catch (e) {
              console.error('Open folder error:', e);
            }
          };
      }
      
    } catch (err) {
      const errorMsg = typeof err === 'string' ? err : (err.message || JSON.stringify(err));
      if(statusText) {
          statusText.textContent = `Error: ${errorMsg}`;
          statusText.className = 'error';
      }
    } finally {
      splitBtn.disabled = false;
    }
  });
}
