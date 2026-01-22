// Import DSP Worker Interface
import { initDSPWorker, getDSPWorker } from './workers/worker-interface.js';

// Import DSP modules
import {
  measureLUFS,
  findTruePeak,
  normalizeToLUFS,
  detectDCOffsetBuffer,
  removeDCOffset,
  getDCOffsetSeverity
} from './lib/dsp/index.js';

// Import presets
import { eqPresets, outputPresets } from './lib/presets/index.js';

// Import UI modules
import {
  // Controls
  eqValues,
  inputGainValue,
  ceilingValueDb,
  targetLufsDb,
  getCurrentSettings,
  initFaders,
  faders,
  setupEQPresets,
  setupOutputPresets,
  setTargetLufs,
  // Meters
  meterState,
  startMeter,
  stopMeter,
  updateLufsDisplay,
  playerState,
  formatTime,
  updatePlayPauseIcon,
  // Encoder
  encodeWAVAsync,
  // Renderer
  renderOffline,
  renderToAudioBuffer,
  // Waveform
  initWaveSurfer,
  destroyWaveSurfer,
  updateWaveSurferProgress,
  updateWaveformBuffer,
  showOriginalWaveform
} from './ui/index.js';

let currentFile = null; // Store the currently selected File object (browser)


// DSP functions imported from ./lib/dsp/index.js
// Presets imported from ./lib/presets/index.js
// UI state and functions imported from ./ui/index.js

// ============================================================================
// Application State (Audio-specific - UI state in ./ui/ modules)
// ============================================================================

const audioNodes = {
  context: null,
  source: null,
  buffer: null,
  analyser: null,
  analyserL: null,   // Left channel analyser for meter
  analyserR: null,   // Right channel analyser for meter
  meterSplitter: null,
  directMeterUpmix: null, // Up-mix node for meter when bypassed
  gain: null,
  // Input gain (first in chain)
  inputGain: null,
  // Effects chain
  highpass: null,
  lowshelf: null,    // mud cut
  highshelf: null,   // air boost
  midPeak: null,     // harshness
  compressor: null,
  limiter: null,
  // 5-band EQ
  eqLow: null,
  eqLowMid: null,
  eqMid: null,
  eqHighMid: null,
  eqHigh: null,
  // Stereo width (M/S processing)
  stereoSplitter: null,
  stereoMerger: null,
  midGainL: null,
  midGainR: null,
  sideGainL: null,
  sideGainR: null
};

const fileState = {
  selectedFilePath: null,
  originalBuffer: null,      // Original audio buffer
  normalizedBuffer: null,    // Loudness normalized buffer
  processedBuffer: null,     // Buffer after denoise/exciter processing
  isNormalizing: false,      // True while normalization is in progress
  isProcessingEffects: false, // True while applying denoise/exciter
  dcOffset: null,            // DC offset info { percent, severity, removed }
  // Cached render buffer architecture
  cachedRenderBuffer: null,  // Fully rendered buffer (all DSP applied)
  cachedRenderLufs: null,    // LUFS measured from cached buffer
  isRenderingCache: false,   // True while rendering to cache
  cacheRenderVersion: 0      // Increments on each settings change
};

// Level meter state imported from ./ui/meters.js

let isProcessing = false;
let processingCancelled = false;
let processingPromise = null; // Track processing for proper cancellation

// ============================================================================
// DOM Elements (File handling - UI controls in ./ui/ modules)
import EQVisualizer from './lib/eq-visualizer.js';

// EQ Visualizer Setup
const eqVisualizer = new EQVisualizer('eqVisualizer');
const eqScaleToggle = document.getElementById('eqScaleToggle');
const eqSmoothToggle = document.getElementById('eqSmoothToggle');
const eqBarsSlider = document.getElementById('eqBarsSlider');
const eqBarsValue = document.getElementById('eqBarsValue');
let eqVisualizerAnimationFrame = null;

if (eqScaleToggle) {
  eqScaleToggle.addEventListener('change', (e) => {
    const mode = e.target.checked ? 'log' : 'linear';
    eqVisualizer.setScale(mode);
  });
}

if (eqSmoothToggle) {
  eqSmoothToggle.addEventListener('change', (e) => {
    eqVisualizer.setSmoothing(e.target.checked);
  });
}

if (eqBarsSlider && eqBarsValue) {
  eqBarsSlider.addEventListener('input', (e) => {
    const value = e.target.value;
    eqBarsValue.textContent = value;
    eqVisualizer.setBars(value);
  });
}

function startEQVisualizer() {
  if (!audioNodes.analyser || eqVisualizerAnimationFrame) {
    console.log('EQ Visualizer start skipped:', { 
      hasAnalyser: !!audioNodes.analyser, 
      alreadyRunning: !!eqVisualizerAnimationFrame 
    });
    return;
  }
  
  // Set the sample rate from the audio context
  if (audioNodes.context) {
    eqVisualizer.setSampleRate(audioNodes.context.sampleRate);
  }
  
  const bufferLength = audioNodes.analyser.frequencyBinCount;
  const dataArray = new Uint8Array(bufferLength);
  console.log('EQ Visualizer started with buffer length:', bufferLength);
  
   let frameCount = 0;
  function updateEQVisualizer() {
    if (!audioNodes.analyser) {
      stopEQVisualizer();
      return;
    }
    
    audioNodes.analyser.getByteFrequencyData(dataArray);
   
     // Debug: log every 60 frames
     if (frameCount % 60 === 0) {
       const sum = dataArray.reduce((a, b) => a + b, 0);
       const avg = sum / dataArray.length;
       console.log('EQ Visualizer frame', frameCount, 'avg magnitude:', avg.toFixed(2));
     }
     frameCount++;
   
    eqVisualizer.draw(dataArray);
    eqVisualizerAnimationFrame = requestAnimationFrame(updateEQVisualizer);
  }
  
  updateEQVisualizer();
}

function stopEQVisualizer() {
  if (eqVisualizerAnimationFrame) {
    cancelAnimationFrame(eqVisualizerAnimationFrame);
    eqVisualizerAnimationFrame = null;
  }
  eqVisualizer.clear();
}

// ============================================================================

const fileInput = document.getElementById('fileInput'); // Browser file input

const selectFileBtn = document.getElementById('selectFile');
const changeFileBtn = document.getElementById('changeFile');
const fileZoneContent = document.getElementById('fileZoneContent');
const fileLoaded = document.getElementById('fileLoaded');
const fileName = document.getElementById('fileName');
const fileMeta = document.getElementById('fileMeta');
const dcOffsetBadge = document.getElementById('dcOffsetBadge');
const dropZone = document.getElementById('dropZone');
const processBtn = document.getElementById('processBtn');
const cancelBtn = document.getElementById('cancelBtn');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusMessage = document.getElementById('statusMessage');
const seekBar = document.getElementById('seekBar');

// Toast helper with auto-clear
let toastTimeout = null;
function showToast(message, type = '', duration = 5000) {
  if (toastTimeout) clearTimeout(toastTimeout);
  statusMessage.textContent = message;
  statusMessage.className = 'status-message' + (type ? ' ' + type : '');
  if (duration > 0) {
    toastTimeout = setTimeout(() => {
      statusMessage.textContent = '';
      statusMessage.className = 'status-message';
    }, duration);
  }
}

// Mini checklist
const miniFormat = document.getElementById('mini-format');

// Settings elements (referenced for special handling)
const normalizeLoudness = document.getElementById('normalizeLoudness');
const sampleRate = document.getElementById('sampleRate');
const bitDepth = document.getElementById('bitDepth');
const targetLufsSlider = document.getElementById('targetLufs');
const targetLufsValue = document.getElementById('targetLufsValue');
const stereoWidthSlider = document.getElementById('stereoWidth');
const stereoWidthValue = document.getElementById('stereoWidthValue');
const outputLufsDisplay = document.getElementById('outputLufs');

// Transport display elements
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
import { spectrogram } from './ui/spectrogram.js';

// ... (existing helper imports)

// ===================================
// Spectrogram Setup
// ===================================
const spectroBtn = document.getElementById('spectroBtn');
const spectrogramContainer = document.getElementById('spectrogramContainer');

if (spectroBtn && spectrogramContainer) {
  spectrogram.mount('spectrogramContainer');

  spectroBtn.addEventListener('click', () => {
    spectrogramContainer.classList.toggle('hidden');
    spectroBtn.classList.toggle('active');

    if (!spectrogramContainer.classList.contains('hidden')) {
      spectrogram.start();
    } else {
      spectrogram.stop();
    }
  });
}

async function cleanupAudioContext() {
  // Stop spectrogram and EQ visualizer
  spectrogram.stop();
  spectrogram.analyser = null;
  stopEQVisualizer();

  // Destroy WaveSurfer first - it may hold references to AudioContext
  destroyWaveSurfer();

  // Stop any playing audio
  if (playerState.isPlaying) {
    stopAudio();
  }

  // Close existing AudioContext to prevent memory leaks
  if (audioNodes.context && audioNodes.context.state !== 'closed') {
    try {
      await audioNodes.context.close();
    } catch (e) {
      console.error('Failed to close AudioContext:', e);
      // Check if context is in bad state
      if (audioNodes.context.state !== 'closed') {
        showToast('Warning: Audio system may be unstable. Restart recommended.', 'error', 10000);
      }
    }
    // Reset all audio nodes
    Object.keys(audioNodes).forEach(key => {
      audioNodes[key] = null;
    });
  }
}

function initAudioContext() {
  if (!audioNodes.context) {
    audioNodes.context = new (window.AudioContext || window.webkitAudioContext)();
  }
  return audioNodes.context;
}

function createAudioChain() {
  const ctx = initAudioContext();

  // Create analysers for visualization (stereo metering)
  audioNodes.analyser = ctx.createAnalyser();
  audioNodes.analyser.fftSize = 2048;

  // Connect spectrogram
  spectrogram.connect(audioNodes.analyser);
  if (!spectrogramContainer.classList.contains('hidden')) {
    spectrogram.start();
  }

  // Start EQ visualizer
  startEQVisualizer();

  audioNodes.analyserL = ctx.createAnalyser();
  audioNodes.analyserL.fftSize = 2048;
  audioNodes.analyserR = ctx.createAnalyser();
  audioNodes.analyserR.fftSize = 2048;
  audioNodes.meterSplitter = ctx.createChannelSplitter(2);

  // Static connections for stereo metering
  audioNodes.meterSplitter.connect(audioNodes.analyserL, 0);
  audioNodes.meterSplitter.connect(audioNodes.analyserR, 1);

  // Direct path metering (bypass): keep a single up-mix node to avoid leaking nodes on each play
  audioNodes.directMeterUpmix = ctx.createGain();
  audioNodes.directMeterUpmix.gain.value = 1.0;
  audioNodes.directMeterUpmix.channelCount = 2;
  audioNodes.directMeterUpmix.channelCountMode = 'explicit';
  audioNodes.directMeterUpmix.channelInterpretation = 'speakers';
  audioNodes.directMeterUpmix.connect(audioNodes.meterSplitter);

  // Create nodes
  audioNodes.inputGain = ctx.createGain();
  audioNodes.inputGain.gain.value = 1.0; // 0dB default
  audioNodes.gain = ctx.createGain();
  audioNodes.highpass = ctx.createBiquadFilter();
  audioNodes.lowshelf = ctx.createBiquadFilter();
  audioNodes.highshelf = ctx.createBiquadFilter();
  audioNodes.midPeak = ctx.createBiquadFilter();
  audioNodes.compressor = ctx.createDynamicsCompressor();
  audioNodes.limiter = ctx.createDynamicsCompressor();

  // 5-band EQ nodes
  audioNodes.eqLow = ctx.createBiquadFilter();
  audioNodes.eqLowMid = ctx.createBiquadFilter();
  audioNodes.eqMid = ctx.createBiquadFilter();
  audioNodes.eqHighMid = ctx.createBiquadFilter();
  audioNodes.eqHigh = ctx.createBiquadFilter();

  // Stereo width M/S processing nodes
  // M/S encoding: Mid = (L+R)/2, Side = (L-R)/2
  // Output: L' = Mid + Side*width, R' = Mid - Side*width
  audioNodes.stereoSplitter = ctx.createChannelSplitter(2);
  audioNodes.stereoMerger = ctx.createChannelMerger(2);
  // For left output: midGainL adds mid, sideGainL adds side
  audioNodes.midGainL = ctx.createGain();
  audioNodes.midGainR = ctx.createGain();
  audioNodes.sideGainL = ctx.createGain();
  audioNodes.sideGainR = ctx.createGain();
  // We need additional gains for the M/S matrix
  audioNodes.lToMid = ctx.createGain();
  audioNodes.rToMid = ctx.createGain();
  audioNodes.lToSide = ctx.createGain();
  audioNodes.rToSide = ctx.createGain();
  audioNodes.midToL = ctx.createGain();
  audioNodes.midToR = ctx.createGain();
  audioNodes.sideToL = ctx.createGain();
  audioNodes.sideToR = ctx.createGain();

  // Configure EQ bands
  audioNodes.eqLow.type = 'lowshelf';
  audioNodes.eqLow.frequency.value = 80;

  audioNodes.eqLowMid.type = 'peaking';
  audioNodes.eqLowMid.frequency.value = 250;
  audioNodes.eqLowMid.Q.value = 1;

  audioNodes.eqMid.type = 'peaking';
  audioNodes.eqMid.frequency.value = 1000;
  audioNodes.eqMid.Q.value = 1;

  audioNodes.eqHighMid.type = 'peaking';
  audioNodes.eqHighMid.frequency.value = 4000;
  audioNodes.eqHighMid.Q.value = 1;

  audioNodes.eqHigh.type = 'highshelf';
  audioNodes.eqHigh.frequency.value = 12000;

  // Configure highpass (clean low end)
  audioNodes.highpass.type = 'highpass';
  audioNodes.highpass.frequency.value = 30;
  audioNodes.highpass.Q.value = 0.7;

  // Configure cut mud (250Hz cut)
  audioNodes.lowshelf.type = 'peaking';
  audioNodes.lowshelf.frequency.value = 250;
  audioNodes.lowshelf.Q.value = 1.5;
  audioNodes.lowshelf.gain.value = 0;

  // Configure add air (12kHz boost)
  audioNodes.highshelf.type = 'highshelf';
  audioNodes.highshelf.frequency.value = 12000;
  audioNodes.highshelf.gain.value = 0;

  // Configure tame harshness (4-6kHz cut)
  audioNodes.midPeak.type = 'peaking';
  audioNodes.midPeak.frequency.value = 5000;
  audioNodes.midPeak.Q.value = 2;
  audioNodes.midPeak.gain.value = 0;

  // Configure glue compressor
  audioNodes.compressor.threshold.value = -18;
  audioNodes.compressor.knee.value = 10;
  audioNodes.compressor.ratio.value = 3;
  audioNodes.compressor.attack.value = 0.02;
  audioNodes.compressor.release.value = 0.25;

  // Configure limiter
  audioNodes.limiter.threshold.value = -1;
  audioNodes.limiter.knee.value = 0;
  // DynamicsCompressorNode.ratio nominal range is [1, 20].
  // Use 20 for the strongest "brickwall-ish" behavior without browser clamping/warnings.
  audioNodes.limiter.ratio.value = 20;
  audioNodes.limiter.attack.value = 0.001; // Fast attack to catch peaks
  audioNodes.limiter.release.value = 0.05;

  // ============================================================================
  // Static audio graph wiring (connect once)
  //
  // We only connect sources to either:
  // - analyser (direct/bypass), or
  // - inputGain (FX chain)
  //
  // This prevents duplicate connections when play/seek restarts.
  // ============================================================================

  // FX chain: inputGain -> filters -> EQ -> comp -> stereo width -> limiter
  audioNodes.inputGain
    .connect(audioNodes.highpass)
    .connect(audioNodes.eqLow)
    .connect(audioNodes.eqLowMid)
    .connect(audioNodes.eqMid)
    .connect(audioNodes.eqHighMid)
    .connect(audioNodes.eqHigh)
    .connect(audioNodes.lowshelf)
    .connect(audioNodes.midPeak)
    .connect(audioNodes.highshelf)
    .connect(audioNodes.compressor)
    .connect(audioNodes.stereoSplitter);

  // M/S Stereo Width Processing
  audioNodes.stereoSplitter.connect(audioNodes.lToMid, 0);
  audioNodes.stereoSplitter.connect(audioNodes.lToSide, 0);
  audioNodes.stereoSplitter.connect(audioNodes.rToMid, 1);
  audioNodes.stereoSplitter.connect(audioNodes.rToSide, 1);

  audioNodes.lToMid.connect(audioNodes.stereoMerger, 0, 0);
  audioNodes.rToMid.connect(audioNodes.stereoMerger, 0, 0);
  audioNodes.lToSide.connect(audioNodes.stereoMerger, 0, 1);
  audioNodes.rToSide.connect(audioNodes.stereoMerger, 0, 1);

  audioNodes.stereoMerger.connect(audioNodes.limiter);

  // Metering: limiter always feeds the meter splitter (direct path feeds it via directMeterUpmix)
  audioNodes.limiter.connect(audioNodes.meterSplitter);

  // Output + spectrogram: analyser feeds output; limiter feeds analyser (FX on), direct source feeds analyser (bypass)
  audioNodes.limiter.connect(audioNodes.analyser);
  audioNodes.analyser.connect(audioNodes.gain);
  audioNodes.gain.connect(ctx.destination);

  // Apply current UI fader state to the newly created nodes (especially input gain)
  updateInputGain();
  updateAudioChain();
  updateStereoWidth();
  updateEQ();
}

/**
 * Set up audio buffer for real-time preview playback
 *
 * ARCHITECTURE NOTE:
 * - Effects (denoise, exciter, saturation, transient) are NOT applied here
 * - They are applied in the unified offline chain (renderOffline / updateOutputLufs)
 * - Real-time preview uses normalizedBuffer through simplified Web Audio chain
 * - This ensures export LUFS display matches actual export output
 */
async function processEffects() {
  if (!fileState.originalBuffer) return;

  // Set fallback buffer for immediate UI access
  // This will be replaced by cached buffer when render completes
  audioNodes.buffer = fileState.normalizedBuffer || fileState.originalBuffer;

  // Trigger cached buffer render (debounced)
  // This renders the FULL DSP chain once, then:
  // - Preview plays from cached buffer
  // - LUFS meter reads from cached buffer
  // - Export uses cached buffer
  scheduleRenderToCache();

  console.log('[Preview] Scheduled cache render with full DSP chain');
}

/**
 * Update the output LUFS display
 *
 * Reads from the cached render buffer LUFS value.
 * The actual rendering happens in scheduleRenderToCache().
 * This function just displays the cached value.
 */
function updateOutputLufs() {
  if (fileState.cachedRenderLufs !== null) {
    updateLufsDisplay(fileState.cachedRenderLufs, false);
  } else if (fileState.isRenderingCache) {
    updateLufsDisplay(null, true);
  } else if (!fileState.originalBuffer) {
    updateLufsDisplay(null, false);
  } else {
    // No cache yet, trigger render
    scheduleRenderToCache();
  }
}

function applyLiveChainParams() {
  // Highpass (clean low end)
  audioNodes.highpass.frequency.value = (cleanLowEnd.checked && !playerState.isBypassed) ? 30 : 1;

  // Cut Mud
  audioNodes.lowshelf.gain.value = (cutMud.checked && !playerState.isBypassed) ? -3 : 0;

  // Add Air (Exciter) - applied offline via processEffects()
  // highshelf disabled - exciter processing is baked into cachedRenderBuffer
  audioNodes.highshelf.gain.value = 0;

  // midPeak filter (unused - harshness taming now handled by deharsh dynamic processor)
  audioNodes.midPeak.gain.value = 0;

  // Glue Compression
  if (glueCompression.checked && !playerState.isBypassed) {
    audioNodes.compressor.threshold.value = -18;
    audioNodes.compressor.ratio.value = 3;
  } else {
    audioNodes.compressor.threshold.value = 0;
    audioNodes.compressor.ratio.value = 1;
  }

  // Limiter
  if (truePeakLimit.checked && !playerState.isBypassed) {
    audioNodes.limiter.threshold.value = ceilingValueDb;
    audioNodes.limiter.ratio.value = 20;
    audioNodes.limiter.attack.value = 0.001;
  } else {
    audioNodes.limiter.threshold.value = 0;
    audioNodes.limiter.ratio.value = 1;
  }
}

function updateAudioChain({ scheduleCache = true } = {}) {
  if (!audioNodes.context || !audioNodes.highpass) return;

  applyLiveChainParams();

  // Trigger cache render when settings change (not when merely toggling bypass)
  // This ensures preview/meter/export all use the same rendered buffer.
  if (scheduleCache && fileState.originalBuffer) {
    scheduleRenderToCache();
  }
}

function updateStereoWidth() {
  if (!audioNodes.stereoSplitter) return;

  const width = playerState.isBypassed ? 1.0 : parseInt(stereoWidthSlider.value) / 100;

  // M/S Matrix coefficients
  // Mid = (L + R) * 0.5
  // Side = (L - R) * 0.5
  // L' = Mid + Side * width = L*0.5 + R*0.5 + (L*0.5 - R*0.5)*width
  //    = L*(0.5 + 0.5*width) + R*(0.5 - 0.5*width)
  // R' = Mid - Side * width = L*0.5 + R*0.5 - (L*0.5 - R*0.5)*width
  //    = L*(0.5 - 0.5*width) + R*(0.5 + 0.5*width)

  const midCoef = 0.5;
  const sideCoef = 0.5 * width;

  // L' = L*(midCoef + sideCoef) + R*(midCoef - sideCoef)
  // R' = L*(midCoef - sideCoef) + R*(midCoef + sideCoef)
  audioNodes.lToMid.gain.value = midCoef + sideCoef;  // L contribution to L'
  audioNodes.rToMid.gain.value = midCoef - sideCoef;  // R contribution to L'
  audioNodes.lToSide.gain.value = midCoef - sideCoef; // L contribution to R'
  audioNodes.rToSide.gain.value = midCoef + sideCoef; // R contribution to R'
}

function connectAudioChain(source) {
  // Static graph is wired in createAudioChain().
  // Here we only connect the source to the FX chain input.
  source.connect(audioNodes.inputGain);
}

/**
 * Connect source directly to output (bypassing effects chain)
 * Used for FX bypass (original / level-matched preview)
 */
function connectDirectToOutput(source) {
  // Static graph is wired in createAudioChain().
  // Direct path: source -> analyser -> gain -> destination
  source.connect(audioNodes.analyser);

  // Metering path: up-mix to 2ch so meters don't freeze on mono sources
  if (audioNodes.directMeterUpmix) {
    source.connect(audioNodes.directMeterUpmix);
  }
}

function updateEQ() {
  if (!audioNodes.eqLow) return;

  if (playerState.isBypassed) {
    audioNodes.eqLow.gain.value = 0;
    audioNodes.eqLowMid.gain.value = 0;
    audioNodes.eqMid.gain.value = 0;
    audioNodes.eqHighMid.gain.value = 0;
    audioNodes.eqHigh.gain.value = 0;
  } else {
    audioNodes.eqLow.gain.value = eqValues.low;
    audioNodes.eqLowMid.gain.value = eqValues.lowMid;
    audioNodes.eqMid.gain.value = eqValues.mid;
    audioNodes.eqHighMid.gain.value = eqValues.highMid;
    audioNodes.eqHigh.gain.value = eqValues.high;
  }
}

function updateInputGain() {
  if (!audioNodes.inputGain) return;
  const linear = Math.pow(10, inputGainValue / 20);
  audioNodes.inputGain.gain.setValueAtTime(linear, audioNodes.context?.currentTime || 0);
}

// Fader initialization moved to ./ui/controls.js
// Use initFaders() with callbacks from the imported module

// Offline render/encoding (renderOffline, renderToAudioBuffer, encodeWAVAsync)
// live in ./ui/renderer.js and ./ui/encoder.js

// Debounce timer for cache render
let cacheRenderTimeout = null;
const CACHE_RENDER_DEBOUNCE_MS = 300;

// getCurrentSettings imported from ./ui/controls.js

/**
 * Schedule a render to the cache buffer (debounced)
 * This is called whenever settings change
 */
function scheduleRenderToCache() {
  // Clear any pending render
  if (cacheRenderTimeout) {
    clearTimeout(cacheRenderTimeout);
  }

  // Increment version to invalidate any in-progress render
  fileState.cacheRenderVersion++;
  const thisVersion = fileState.cacheRenderVersion;

  // Show "rendering..." indicator
  if (outputLufsDisplay) {
    outputLufsDisplay.textContent = '... LUFS';
  }

  // Debounce the actual render
  cacheRenderTimeout = setTimeout(async () => {
    if (!fileState.originalBuffer) return;
    if (fileState.isRenderingCache) {
      // Already rendering, schedule another after current completes
      scheduleRenderToCache();
      return;
    }

    fileState.isRenderingCache = true;
    console.log('[Cache] Starting render, version:', thisVersion);

    try {
      const settings = getCurrentSettings();

      // Try to use DSP worker for off-main-thread processing
      const dspWorker = getDSPWorker();
      let buffer, lufs;

      if (dspWorker && dspWorker.isReady) {
        try {
          // Use worker - doesn't freeze UI
          console.log('[Cache] Using DSP worker for render');
          // Use ORIGINAL buffer as input - normalization happens once at the END of the chain
          // Using normalized buffer causes double-normalization which crushes dynamics
          const inputBuffer = fileState.originalBuffer;
          const result = await dspWorker.renderFullChain(
            inputBuffer,
            settings,
            // Build a master-preview buffer that matches export (includes final limiter).
            'export',
            (progress, status) => {
              // Show progress in modal and LUFS display
              const percent = Math.round(progress * 100);
              if (outputLufsDisplay && progress < 1) {
                outputLufsDisplay.textContent = `${percent}%`;
              }
              // Update modal progress (85-100% range for cache phase)
              showLoadingModal('Building cache...', 85 + percent * 0.15);
            }
          );
          buffer = result.audioBuffer;
          lufs = result.lufs;
        } catch (workerErr) {
          // Worker can fail in some environments; fall back to main thread so FX preview still works.
          console.warn('[Cache] Worker render failed, falling back to main thread render:', workerErr);
          const result = await renderToAudioBuffer(fileState.originalBuffer, settings, 'export');
          buffer = result.buffer;
          lufs = result.lufs;
        }
      } else {
        // Fallback to main thread rendering
        console.log('[Cache] Falling back to main thread render');
        const result = await renderToAudioBuffer(fileState.originalBuffer, settings, 'export');
        buffer = result.buffer;
        lufs = result.lufs;
      }

      // Only update cache if this is still the latest version
      if (thisVersion === fileState.cacheRenderVersion) {
        fileState.cachedRenderBuffer = buffer;
        fileState.cachedRenderLufs = lufs;

        // Update LUFS display
        if (outputLufsDisplay) {
          outputLufsDisplay.textContent = `${lufs.toFixed(1)} LUFS`;
        }

        // Update the playback buffer if not currently playing
        if (!playerState.isPlaying) {
          audioNodes.buffer = buffer;
        }

        // Enable playback now that cache is ready
        playBtn.disabled = false;
        stopBtn.disabled = false;
        hideLoadingModal();

        console.log('[Cache] Render complete, version:', thisVersion, 'LUFS:', lufs.toFixed(1));

        // If we're actively previewing FX, hot-swap to the new master-preview buffer.
        // This keeps meters/audio in sync with the full chain (including final limiter)
        // after any setting change.
        if (playerState.isPlaying && !playerState.isBypassed && audioNodes.context) {
          const currentTime = audioNodes.context.currentTime - playerState.startTime;
          playerState.pauseTime = Math.max(0, Math.min(currentTime, buffer.duration - 0.001));
          playAudio();
        }
      } else {
        console.log('[Cache] Render discarded (outdated version:', thisVersion, 'current:', fileState.cacheRenderVersion, ')');
      }
    } catch (err) {
      console.error('[Cache] Render error:', err);
      if (outputLufsDisplay) {
        outputLufsDisplay.textContent = '-- LUFS';
      }
      // Still enable playback on error so user isn't stuck
      playBtn.disabled = false;
      stopBtn.disabled = false;
      hideLoadingModal();
    } finally {
      fileState.isRenderingCache = false;
    }
  }, CACHE_RENDER_DEBOUNCE_MS);
}

// ============================================================================
// Level Meter (wrappers for ./ui/meters.js)
// ============================================================================

/**
 * Start level meter with current audio context
 */
function startMeterAnimation() {
  startMeter(audioNodes.analyserL, audioNodes.analyserR, () => playerState.isPlaying);
 
   // Ensure EQ visualizer is running when playback starts
   if (!eqVisualizerAnimationFrame && audioNodes.analyser) {
     console.log('Starting EQ visualizer from startMeterAnimation');
     startEQVisualizer();
   }
}

/**
 * Stop level meter animation
 */
function stopMeterAnimation() {
  stopMeter();
}

// WaveSurfer functions (initWaveSurfer, updateWaveSurferProgress, etc.)
// moved to ./ui/waveform.js

// ============================================================================
// EQ Preset Event Listeners - setup moved to initialization via setupEQPresets()
// ============================================================================

// ============================================================================
// Audio File Loading
// ============================================================================

// Loading modal elements
const loadingModal = document.getElementById('loadingModal');
const loadingText = document.getElementById('loadingText');
const loadingProgressBar = document.getElementById('loadingProgressBar');
const loadingPercent = document.getElementById('loadingPercent');
const modalCancelBtn = document.getElementById('modalCancelBtn');

function showLoadingModal(text, percent, showCancel = false) {
  const numericPercent = Number(percent);
  const clamped = Number.isFinite(numericPercent) ? Math.max(0, Math.min(100, numericPercent)) : 0;
  const displayPercent = Math.round(clamped);

  console.log('[Modal] Show:', text, `${displayPercent}%`);
  loadingModal.classList.remove('hidden');
  loadingText.textContent = text;
  loadingProgressBar.style.width = `${displayPercent}%`;
  loadingPercent.textContent = `${displayPercent}%`;
  modalCancelBtn.classList.toggle('hidden', !showCancel);
}

function hideLoadingModal() {
  console.log('[Modal] Hide');
  loadingModal.classList.add('hidden');
  modalCancelBtn.classList.add('hidden');
}

// Consolidated cancel handler to prevent race conditions
async function cancelProcessing() {
  if (!isProcessing || processingCancelled) return;

  processingCancelled = true;
  // Disable buttons to prevent multiple cancel clicks
  modalCancelBtn.disabled = true;
  cancelBtn.disabled = true;
  showLoadingModal('Cancelling...', 0, false);

  // Wait for processing to actually complete before allowing new operations
  if (processingPromise) {
    try {
      await processingPromise;
    } catch (e) {
      // Ignore cancellation error - expected
    }
  }
}

modalCancelBtn.addEventListener('click', cancelProcessing);

async function loadAudioFile(file) {
  const ctx = initAudioContext();

  showLoadingModal('Loading audio...', 5);

  try {
    // Read file data from browser File object
    const arrayBuffer = await file.arrayBuffer();

    // Create blob from original file data immediately (for WaveSurfer)
    const originalBlob = new Blob([arrayBuffer], { type: file.type || 'audio/mpeg' });

    showLoadingModal('Decoding audio...', 20);

    // Decode audio using browser's native decoder (supports MP3, WAV, FLAC, AAC, M4A, MP4)
    let decodedBuffer;
    try {
      decodedBuffer = await ctx.decodeAudioData(arrayBuffer);
    } catch (decodeError) {
      throw new Error(`Cannot decode audio file. Format may be unsupported or file is corrupted.`);
    }

    // Detect and remove DC offset
    showLoadingModal('Checking DC offset...', 25);
    const dcInfo = detectDCOffsetBuffer(decodedBuffer);
    const dcSeverity = getDCOffsetSeverity(dcInfo.average.percent);

    if (dcInfo.significant) {
      console.log(`[DC Offset] Detected: ${dcInfo.average.percent.toFixed(4)}% (${dcSeverity})`);
      // Remove DC offset from the buffer
      for (let ch = 0; ch < decodedBuffer.numberOfChannels; ch++) {
        const channelData = decodedBuffer.getChannelData(ch);
        removeDCOffset(channelData);
      }
      fileState.dcOffset = {
        percent: dcInfo.average.percent,
        severity: dcSeverity,
        removed: true
      };
      console.log('[DC Offset] Removed');
    } else {
      fileState.dcOffset = {
        percent: dcInfo.average.percent,
        severity: dcSeverity,
        removed: false
      };
    }

    fileState.originalBuffer = decodedBuffer;

    // Clear cached render buffer (will be rebuilt when settings change)
    fileState.cachedRenderBuffer = null;
    fileState.cachedRenderLufs = null;
    fileState.cacheRenderVersion++;

    // Show measuring phase with intermediate progress updates
    showLoadingModal('Measuring loudness...', 35);

    // Small delay to allow UI to update before CPU-intensive LUFS measurement
    await new Promise(resolve => setTimeout(resolve, 10));

    showLoadingModal('Analyzing audio levels...', 50);

    // Measure original LUFS and true peak BEFORE normalization
    const originalLufs = measureLUFS(decodedBuffer);
    const originalTruePeak = findTruePeak(decodedBuffer);
    fileState.originalLufs = originalLufs;
    fileState.originalTruePeak = originalTruePeak;
    fileState.originalSampleRate = decodedBuffer.sampleRate;

    // Normalize to target LUFS using pure JavaScript
    const normalizedBuffer = normalizeToLUFS(decodedBuffer, targetLufsDb);

    showLoadingModal('Applying normalization...', 70);

    // Small delay for UI feedback
    await new Promise(resolve => setTimeout(resolve, 10));

    showLoadingModal('Preparing audio...', 85);

    // Store normalized buffer
    fileState.normalizedBuffer = normalizedBuffer;

    // Apply effects (denoise, exciter) if enabled
    await processEffects();

    createAudioChain();

    // Update duration display
    const duration = audioNodes.buffer.duration;
    durationEl.textContent = formatTime(duration);
    seekBar.max = duration;

    // Initialize waveform display with original file blob
    initWaveSurfer(audioNodes.buffer, originalBlob, {
      onSeek: (time) => {
        seekBar.value = time;
        currentTimeEl.textContent = formatTime(time);
        seekTo(time);
      },
      getBuffer: () => audioNodes.buffer
    });

    // Keep play button disabled until cache render completes
    // processBtn can be enabled now
    processBtn.disabled = false;

    // Show live indicators
    document.body.classList.add('audio-loaded');

    // Show "Building cache" modal - stays visible until cache render completes
    showLoadingModal('Building cache...', 85);

    return true;
  } catch (error) {
    console.error('Error loading audio:', error);
    hideLoadingModal();
    showToast(`Error: ${error.message}`, 'error');
    return false;
  }
}

// ============================================================================
// Audio Playback
// ============================================================================

function playAudio() {
  if (!audioNodes.context) return;

  // Choose playback buffer based on bypass state:
  // - Bypassed (FX OFF): Use original/normalized buffer (unprocessed)
  // - Not bypassed (FX ON): Use cached processed buffer if available
  let playbackBuffer;
  let useDirectOutput = false;

  if (playerState.isBypassed) {
    // Bypass: check Level Match setting
    const levelMatch = document.getElementById('levelMatchBtn').checked;

    if (levelMatch) {
      // Level Match ON: use normalized buffer (approx volume match)
      playbackBuffer = fileState.normalizedBuffer || fileState.originalBuffer;
      console.log('[Playback] Bypass ON (Level Matched) - using normalizedBuffer');
    } else {
      // Level Match OFF: use original raw buffer (true bypass)
      playbackBuffer = fileState.originalBuffer;
      console.log('[Playback] Bypass ON (True Bypass) - using originalBuffer');
    }

    useDirectOutput = true; // Skip effects chain entirely
  } else {
    // FX ON: play cached processed buffer if available
    if (fileState.cachedRenderBuffer) {
      playbackBuffer = fileState.cachedRenderBuffer;
      useDirectOutput = true; // Cached buffer is full chain (includes final limiter) - do NOT run through live chain.
      console.log('[Playback] FX ON - using cachedRenderBuffer (Full Chain)');
    } else {
      // Fallback to normalized buffer through effects chain
      playbackBuffer = fileState.normalizedBuffer || audioNodes.buffer;
      useDirectOutput = false; // Use live effects chain
      console.log('[Playback] FX ON - NO cached buffer, falling back to full live chain');
    }
  }

  if (!playbackBuffer) return;

  try {
    if (audioNodes.context.state === 'suspended') {
      audioNodes.context.resume();
    }

    stopAudio();

    audioNodes.source = audioNodes.context.createBufferSource();
    audioNodes.source.buffer = playbackBuffer;

    // Bypass uses direct output; FX ON routes through the live WebAudio chain
    if (useDirectOutput) {
      connectDirectToOutput(audioNodes.source);
    } else {
      connectAudioChain(audioNodes.source);
    }

    audioNodes.source.onended = () => {
      if (playerState.isPlaying) {
        playerState.isPlaying = false;
        updatePlayPauseIcon(false);
        clearInterval(playerState.seekUpdateInterval);
        stopMeterAnimation();
      }
    };

    const offset = playerState.pauseTime;
    playerState.startTime = audioNodes.context.currentTime - offset;
    audioNodes.source.start(0, offset);
    playerState.isPlaying = true;
    updatePlayPauseIcon(true);
    startMeterAnimation();

    clearInterval(playerState.seekUpdateInterval);
    playerState.seekUpdateInterval = setInterval(() => {
      if (playerState.isPlaying && playbackBuffer && !playerState.isSeeking) {
        const currentTime = audioNodes.context.currentTime - playerState.startTime;
        if (currentTime >= playbackBuffer.duration) {
          stopAudio();
          playerState.pauseTime = 0;
          seekBar.value = 0;
          currentTimeEl.textContent = '0:00';
        } else {
          seekBar.value = currentTime;
          currentTimeEl.textContent = formatTime(currentTime);
          updateWaveSurferProgress(currentTime, playbackBuffer.duration);
        }
      }
    }, 100);
  } catch (err) {
    console.error('[Playback] Error in playAudio:', err);
    showToast(`Playback error: ${err.message}`, 'error');
    stopAudio();
  }
}

function pauseAudio() {
  if (!playerState.isPlaying) return;

  playerState.pauseTime = audioNodes.context.currentTime - playerState.startTime;
  stopAudio();
  stopMeterAnimation();
}

function stopAudio() {
  if (audioNodes.source) {
    // IMPORTANT: Clear the onended handler before stopping, otherwise a late
    // onended from the previous source can flip isPlaying=false and freeze the
    // meter/scrubber after we restart playback (e.g. when toggling FX bypass).
    const oldSource = audioNodes.source;
    audioNodes.source = null;

    try { oldSource.onended = null; } catch (e) { }
    try { oldSource.stop(); } catch (e) { }
    try { oldSource.disconnect(); } catch (e) { }
  }
  playerState.isPlaying = false;
  updatePlayPauseIcon(false);
  clearInterval(playerState.seekUpdateInterval);
}

function seekTo(time) {
  // Prevent race condition from rapid seeks
  if (playerState.isSeeking) return;
  playerState.isSeeking = true;

  playerState.pauseTime = time;

  if (playerState.isPlaying) {
    if (audioNodes.source) {
      try {
        // Clear reference first to prevent race conditions
        const oldSource = audioNodes.source;
        audioNodes.source = null;
        // Clear onended before stopping to prevent it from setting isPlaying = false
        oldSource.onended = null;
        oldSource.stop();
        oldSource.disconnect();
      } catch (e) { }
    }
    clearInterval(playerState.seekUpdateInterval);

    // Select correct buffer based on bypass state (same logic as playAudio)
    let playbackBuffer;
    let useDirectOutput = false;

    if (playerState.isBypassed) {
      // Bypass: respect Level Match (same as playAudio)
      const levelMatch = document.getElementById('levelMatchBtn')?.checked;
      if (levelMatch) {
        playbackBuffer = fileState.normalizedBuffer || fileState.originalBuffer;
      } else {
        playbackBuffer = fileState.originalBuffer;
      }
      useDirectOutput = true;
    } else {
      if (fileState.cachedRenderBuffer) {
        playbackBuffer = fileState.cachedRenderBuffer;
        // Cached buffer is full chain (includes final limiter) - do NOT run through live chain.
        useDirectOutput = true;
      } else {
        playbackBuffer = fileState.normalizedBuffer || audioNodes.buffer;
        useDirectOutput = false;
      }
    }

    audioNodes.source = audioNodes.context.createBufferSource();
    audioNodes.source.buffer = playbackBuffer;

    if (useDirectOutput) {
      connectDirectToOutput(audioNodes.source);
    } else {
      connectAudioChain(audioNodes.source);
    }

    audioNodes.source.onended = () => {
      if (playerState.isPlaying) {
        playerState.isPlaying = false;
        updatePlayPauseIcon(false);
        clearInterval(playerState.seekUpdateInterval);
      }
    };

    playerState.startTime = audioNodes.context.currentTime - time;
    audioNodes.source.start(0, time);

    playerState.seekUpdateInterval = setInterval(() => {
      if (playerState.isPlaying && playbackBuffer && !playerState.isSeeking) {
        const currentTime = audioNodes.context.currentTime - playerState.startTime;
        if (currentTime >= playbackBuffer.duration) {
          stopAudio();
          playerState.pauseTime = 0;
          seekBar.value = 0;
          currentTimeEl.textContent = '0:00';
        } else {
          seekBar.value = currentTime;
          currentTimeEl.textContent = formatTime(currentTime);
          updateWaveSurferProgress(currentTime, playbackBuffer.duration);
        }
      }
    }, 100);
  } else {
    currentTimeEl.textContent = formatTime(time);
    updateWaveSurferProgress(time, audioNodes.buffer?.duration);
  }

  // Release seek lock after a brief delay to allow audio to stabilize
  // Clear any existing timeout to prevent premature unlock from rapid seeks
  if (playerState.seekTimeout) {
    clearTimeout(playerState.seekTimeout);
  }
  playerState.seekTimeout = setTimeout(() => {
    playerState.isSeeking = false;
    playerState.seekTimeout = null;
  }, 50);
}

// formatTime imported from ./ui/transport.js

// ============================================================================
// File Selection (Browser)
// ============================================================================

// Open file picker when button clicked
selectFileBtn.addEventListener('click', () => {
  fileInput.click();
});

changeFileBtn.addEventListener('click', () => {
  stopAudio();
  playerState.pauseTime = 0;
  fileInput.click();
});

// Handle file input change
fileInput.addEventListener('change', async (e) => {
  const file = e.target.files[0];
  if (file) {
    await loadFile(file);
  }
  // Reset input so same file can be selected again
  fileInput.value = '';
});

async function loadFile(file) {
  // Prevent loading while export is in progress
  if (isProcessing) {
    showToast('Cannot load file while processing', 'error');
    return false;
  }

  try {
    // Cleanup previous AudioContext to prevent memory leaks
    await cleanupAudioContext();

    // Store file reference for browser
    currentFile = file;
    fileState.selectedFilePath = file.name;

    // Load into Web Audio first to get metadata
    const loaded = await loadAudioFile(file);

    if (loaded && audioNodes.buffer) {
      // Get file info from the decoded audio buffer
      const name = file.name.substring(0, 100);
      const ext = name.split('.').pop().toUpperCase();
      const sampleRateKHz = (fileState.originalSampleRate / 1000).toFixed(1);
      const duration = formatTime(audioNodes.buffer.duration);
      const lufs = fileState.originalLufs !== undefined ? fileState.originalLufs.toFixed(1) : '--';
      const truePeak = fileState.originalTruePeak !== undefined ? fileState.originalTruePeak.toFixed(1) : '--';

      // Estimate bitrate from file size (for compressed formats)
      const fileSizeBytes = file.size;
      const durationSecs = audioNodes.buffer.duration;
      const estimatedBitrate = Math.round((fileSizeBytes * 8) / (durationSecs * 1000)); // kbps

      fileName.textContent = name;
      // Format: {type} • {bitrate} • {sample-rate} • {LUFS} • {dBTP} • {length}
      fileMeta.textContent = `${ext} • ${estimatedBitrate}kbps • ${sampleRateKHz}kHz • ${lufs} LUFS • ${truePeak} dBTP • ${duration}`;

      // Show DC offset badge if DC offset was removed
      if (dcOffsetBadge) {
        if (fileState.dcOffset?.removed) {
          dcOffsetBadge.classList.remove('hidden');
          dcOffsetBadge.title = `DC offset of ${fileState.dcOffset.percent.toFixed(3)}% was detected and removed`;
        } else {
          dcOffsetBadge.classList.add('hidden');
        }
      }

      fileZoneContent.classList.add('hidden');
      fileLoaded.classList.remove('hidden');

      // Re-apply current UI settings to the new audio nodes
      updateInputGain();
      updateEQ();
      updateStereoWidth();
      updateAudioChain();

      updateChecklist();
      return true;
    }
    return false;
  } catch (error) {
    console.error('Error in loadFile:', error);
    showToast(`Failed to load file: ${error.message}`, 'error');
    return false;
  }
}

// Drag and drop
dropZone.addEventListener('dragover', (e) => {
  e.preventDefault();
  dropZone.classList.add('drag-over');
});

dropZone.addEventListener('dragleave', () => {
  dropZone.classList.remove('drag-over');
});

dropZone.addEventListener('drop', async (e) => {
  e.preventDefault();
  dropZone.classList.remove('drag-over');

  const file = e.dataTransfer.files[0];
  if (file && /\.(mp3|wav|flac|aac|m4a|mp4)$/i.test(file.name)) {
    stopAudio();
    playerState.pauseTime = 0;
    await loadFile(file); // Pass File object directly in browser
  }
});

// ============================================================================
// Player Controls
// ============================================================================

playBtn.addEventListener('click', () => {
  if (playerState.isPlaying) {
    pauseAudio();
  } else {
    playAudio();
  }
});

stopBtn.addEventListener('click', () => {
  stopAudio();
  stopMeter();
  playerState.pauseTime = 0;
  seekBar.value = 0;
  currentTimeEl.textContent = '0:00';
});

// Seek bar is hidden - wavesurfer handles interaction
// This is kept for programmatic updates only
seekBar.addEventListener('input', () => {
  const time = parseFloat(seekBar.value);
  currentTimeEl.textContent = formatTime(time);
});

bypassBtn.addEventListener('click', () => {
  playerState.isBypassed = !playerState.isBypassed;
  const bypassLabel = bypassBtn.querySelector('.bypass-label');
  if (bypassLabel) {
    bypassLabel.textContent = playerState.isBypassed ? 'OFF' : 'FX';
  }
  bypassBtn.classList.toggle('active', playerState.isBypassed);

  console.log('[Bypass] Toggled to:', playerState.isBypassed ? 'OFF (original)' : 'FX ON (processed)');
  console.log('[Bypass] cachedRenderBuffer exists:', !!fileState.cachedRenderBuffer);
  console.log('[Bypass] isPlaying:', playerState.isPlaying);

  // Ensure live node params reflect bypass state (without triggering expensive cache re-render)
  updateEQ();
  updateStereoWidth();
  updateAudioChain({ scheduleCache: false });

  // Update waveform display to show original or processed
  if (playerState.isBypassed) {
    // Show original waveform (from the original file blob, not a converted AudioBuffer)
    showOriginalWaveform();
  } else {
    // Show processed waveform (if cached buffer exists)
    if (fileState.cachedRenderBuffer) {
      updateWaveformBuffer(fileState.cachedRenderBuffer);
    }
  }

  // If playing, restart playback to switch buffers (original vs processed)
  if (playerState.isPlaying) {
    console.log('[Bypass] Restarting playback to switch buffer');
    const currentTime = audioNodes.context.currentTime - playerState.startTime;
    playerState.pauseTime = currentTime;
    playAudio(); // This will use the correct buffer based on isBypassed
  }
});

// ============================================================================
// Export/Processing (Browser Download)
// ============================================================================

processBtn.addEventListener('click', async () => {
  if (!audioNodes.buffer) {
    showToast('✗ No audio loaded', 'error');
    return;
  }

  isProcessing = true;
  processingCancelled = false;
  processBtn.disabled = true;
  // Re-enable cancel buttons for new processing
  modalCancelBtn.disabled = false;
  cancelBtn.disabled = false;

  // Store promise for cancellation tracking
  processingPromise = processAudio();
  await processingPromise;
  processingPromise = null;
});

async function processAudio() {

  // Parse and validate settings
  const parsedSampleRate = parseInt(sampleRate.value) || 44100;
  const parsedBitDepth = parseInt(bitDepth.value) || 16;
  const parsedStereoWidth = parseInt(stereoWidthSlider.value) || 100;

  // Validate settings
  if (![44100, 48000].includes(parsedSampleRate)) {
    showToast('Invalid sample rate', 'error');
    processBtn.disabled = false;
    isProcessing = false;
    return;
  }
  if (![16, 24].includes(parsedBitDepth)) {
    showToast('Invalid bit depth', 'error');
    processBtn.disabled = false;
    isProcessing = false;
    return;
  }
  if (parsedStereoWidth < 0 || parsedStereoWidth > 200) {
    showToast('Invalid stereo width', 'error');
    processBtn.disabled = false;
    isProcessing = false;
    return;
  }

  const settings = {
    normalizeLoudness: normalizeLoudness.checked,
    targetLufs: parseInt(targetLufsSlider.value),
    truePeakLimit: truePeakLimit.checked,
    truePeakCeiling: ceilingValueDb,
    cleanLowEnd: cleanLowEnd.checked,
    glueCompression: glueCompression.checked,
    deharsh: deharsh.checked,
    stereoWidth: parsedStereoWidth,
    centerBass: centerBass.checked,
    cutMud: cutMud.checked,
    addAir: addAir.checked,
    tapeWarmth: tapeWarmth.checked,
    autoLevel: autoLevel.checked,
    addPunch: addPunch.checked,
    sampleRate: parsedSampleRate,
    bitDepth: parsedBitDepth,
    inputGain: inputGainValue,
    eqLow: eqValues.low,
    eqLowMid: eqValues.lowMid,
    eqMid: eqValues.mid,
    eqHighMid: eqValues.highMid,
    eqHigh: eqValues.high
  };

  const updateProgress = (percent, text) => {
    showLoadingModal(text || 'Rendering...', percent, true);
  };

  try {
    showLoadingModal('Preparing audio...', 2, true);

    if (processingCancelled) {
      throw new Error('Cancelled');
    }

    // Re-verify buffer exists (could be unloaded during async operations)
    if (!fileState.originalBuffer) {
      throw new Error('Audio buffer was unloaded during processing');
    }

    let outputData;

    // Hybrid Pipeline: Cached buffer is preview-only (missing EQ/Comp).
    // ALWAYS render full chain for export to ensure parity.
    console.log('[Export] Starting full chain render (Export Mode)...');
    showLoadingModal('Rendering audio...', 5, true);

    const dspWorker = getDSPWorker();
    if (dspWorker && dspWorker.isReady) {
      // Use Worker (Preferred), but fall back to main thread if it fails so export is never blocked.
      try {
        const result = await dspWorker.renderFullChain(
          fileState.originalBuffer,
          settings,
          'export',
          // Keep headroom for WAV encoding + download prep so the bar stays monotonic.
          (progress, status) => updateProgress(Math.round(5 + progress * 80), status)
        );

        if (processingCancelled) {
          throw new Error('Cancelled');
        }

        updateProgress(85, 'Encoding WAV...');
        // Yield so the UI can repaint before encoding begins.
        await new Promise(resolve => setTimeout(resolve, 0));

        outputData = await encodeWAVAsync(result.audioBuffer, parsedSampleRate, parsedBitDepth, {
          onProgress: (p) => updateProgress(Math.round(85 + p * 10), 'Encoding WAV...'),
          shouldCancel: () => processingCancelled
        });
      } catch (workerErr) {
        if (processingCancelled || workerErr?.message === 'Cancelled') {
          throw workerErr;
        }
        console.warn('[Export] Worker render failed, falling back to main thread render:', workerErr);
        outputData = await renderOffline(fileState.originalBuffer, settings, updateProgress);
      }
    } else {
      // Fallback (Main Thread)
      outputData = await renderOffline(fileState.originalBuffer, settings, updateProgress);
    }

    if (processingCancelled) {
      throw new Error('Cancelled');
    }

    // Download file via browser
    showLoadingModal('Preparing download...', 96, true);

    // Create blob from WAV data
    const blob = new Blob([outputData], { type: 'audio/wav' });
    const url = URL.createObjectURL(blob);

    // Generate output filename from input file
    const inputName = currentFile?.name || 'audio';
    const baseName = inputName.replace(/\.[^.]+$/, '');
    const outputName = `${baseName}_mastered.wav`;

    // Create download link and trigger download
    const a = document.createElement('a');
    a.href = url;
    a.download = outputName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    // Cleanup blob URL after download starts
    setTimeout(() => URL.revokeObjectURL(url), 1000);

    showLoadingModal('Complete!', 100, false);
    setTimeout(() => {
      hideLoadingModal();
      showToast('✓ Export complete! Your mastered file is downloading.', 'success');
    }, 300);

  } catch (error) {
    hideLoadingModal();
    if (processingCancelled || error.message === 'Cancelled') {
      showToast('Export cancelled.');
    } else {
      console.error('Processing error:', error);
      showToast(`✗ Error: ${error.message || error}`, 'error');
    }
  }

  isProcessing = false;
  processBtn.disabled = false;
}

cancelBtn.addEventListener('click', cancelProcessing);

// ============================================================================
// Settings & Checklist
// ============================================================================

function updateChecklist() {
  miniFormat.classList.toggle('active', fileState.selectedFilePath !== null);
}

// Special handling for normalizeLoudness to switch buffers
normalizeLoudness.addEventListener('change', () => {
  if (normalizeLoudness.checked) {
    // Switch to normalized buffer if available
    if (fileState.normalizedBuffer) {
      audioNodes.buffer = fileState.normalizedBuffer;
      console.log('[Normalize] Switched to normalized buffer');
    }
  } else {
    // Switch back to original buffer
    if (fileState.originalBuffer) {
      audioNodes.buffer = fileState.originalBuffer;
      console.log('[Normalize] Switched to original buffer');
    }
  }
  updateAudioChain();
  updateChecklist();
});

[truePeakLimit, cleanLowEnd, glueCompression, centerBass, cutMud, addAir, tapeWarmth, autoLevel, addPunch].forEach(el => {
  el.addEventListener('change', () => {
    updateAudioChain();
    updateChecklist();
  });
});

// Deharsh, Exciter (Add Air), Tape Warmth, and Multiband Transient (Add Punch) require re-processing the buffer
// These are applied offline for preview/export parity
[deharsh, addAir, tapeWarmth, addPunch].forEach(el => {
  el.addEventListener('change', () => {
    processEffects();
  });
});

// truePeakSlider event listener removed - now using ceiling fader

const levelMatchBtn = document.getElementById('levelMatchBtn');
levelMatchBtn.addEventListener('change', () => {
  if (playerState.isBypassed && playerState.isPlaying) {
    // Restart playback to switch buffers
    const currentTime = audioNodes.context.currentTime - playerState.startTime;
    playerState.pauseTime = currentTime;
    playAudio();
  }
});

stereoWidthSlider.addEventListener('input', () => {
  stereoWidthValue.textContent = `${stereoWidthSlider.value}%`;
  updateStereoWidth();
  // Stereo width affects the master preview render, so rebuild cache.
  updateAudioChain();
});

// Target LUFS slider with debounced re-normalization
let lufsDebounceTimeout = null;
let isRenormalizing = false;

async function renormalizeAudio(newTargetLufs) {
  // Only re-normalize if we have an original buffer and normalization is enabled
  if (!fileState.originalBuffer || !normalizeLoudness.checked) {
    return;
  }

  // Prevent concurrent re-normalization
  if (isRenormalizing) {
    return;
  }
  isRenormalizing = true;

  // Store playback state
  const wasPlaying = playerState.isPlaying;
  const playbackPosition = wasPlaying ?
    (audioNodes.context.currentTime - playerState.startTime) :
    playerState.pauseTime;

  // Stop playback if playing
  if (wasPlaying) {
    stopAudio();
    stopMeter();
  }

  // Disable transport controls
  playBtn.disabled = true;
  stopBtn.disabled = true;

  try {
    // Show modal
    showLoadingModal(`Normalizing to ${newTargetLufs} LUFS...`, 10);

    // Allow UI to update
    await new Promise(resolve => setTimeout(resolve, 20));

    showLoadingModal(`Normalizing to ${newTargetLufs} LUFS...`, 30);

    // Re-normalize to new target
    const normalizedBuffer = normalizeToLUFS(fileState.originalBuffer, newTargetLufs);

    showLoadingModal(`Normalizing to ${newTargetLufs} LUFS...`, 80);

    // Update normalized buffer
    fileState.normalizedBuffer = normalizedBuffer;

    // Re-apply effects (denoise, exciter) if enabled
    await processEffects();

  } catch (error) {
    console.error('Re-normalization failed:', error);
    showToast(`Normalization failed: ${error.message}`, 'error');
  } finally {
    // Hide modal and re-enable controls
    hideLoadingModal();
    playBtn.disabled = false;
    stopBtn.disabled = false;
    isRenormalizing = false;

    // Restore playback position
    playerState.pauseTime = Math.min(playbackPosition, audioNodes.buffer?.duration || 0);
    seekBar.value = playerState.pauseTime;
    currentTimeEl.textContent = formatTime(playerState.pauseTime);
    updateWaveSurferProgress(playerState.pauseTime, audioNodes.buffer?.duration);
  }
}

targetLufsSlider.addEventListener('input', () => {
  const newValue = parseInt(targetLufsSlider.value);

  // Update display immediately
  setTargetLufs(newValue);
  targetLufsValue.textContent = `${newValue} LUFS`;

  // Debounce the re-normalization (wait for user to stop sliding)
  if (lufsDebounceTimeout) {
    clearTimeout(lufsDebounceTimeout);
  }

  lufsDebounceTimeout = setTimeout(() => {
    renormalizeAudio(newValue);
  }, 300); // 300ms debounce
});

// outputPresets imported from ./lib/presets/index.js

document.querySelectorAll('.output-preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = outputPresets[btn.dataset.preset];
    if (preset) {
      sampleRate.value = preset.sampleRate;
      bitDepth.value = preset.bitDepth;

      document.querySelectorAll('.output-preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
  });
});

[sampleRate, bitDepth].forEach(el => {
  el.addEventListener('change', () => {
    const currentRate = parseInt(sampleRate.value);
    const currentDepth = parseInt(bitDepth.value);

    document.querySelectorAll('.output-preset-btn').forEach(btn => {
      const preset = outputPresets[btn.dataset.preset];
      const isMatch = preset.sampleRate === currentRate && preset.bitDepth === currentDepth;
      btn.classList.toggle('active', isMatch);
    });
  });
});

// ============================================================================
// Tooltip System
// ============================================================================

const tooltip = document.getElementById('tooltip');
const showTipsCheckbox = document.getElementById('showTips');
let tooltipTimeout = null;

const savedTipsPref = localStorage.getItem('showTips');
if (savedTipsPref !== null) {
  showTipsCheckbox.checked = savedTipsPref === 'true';
}

showTipsCheckbox.addEventListener('change', () => {
  localStorage.setItem('showTips', showTipsCheckbox.checked);
  if (!showTipsCheckbox.checked) {
    tooltip.classList.remove('visible');
  }
});

document.querySelectorAll('[data-tip]').forEach(el => {
  el.addEventListener('mouseenter', () => {
    if (!showTipsCheckbox.checked) return;

    const tipText = el.getAttribute('data-tip');
    if (!tipText) return;

    clearTimeout(tooltipTimeout);
    tooltipTimeout = setTimeout(() => {
      tooltip.textContent = tipText;

      const rect = el.getBoundingClientRect();
      let left = rect.left;
      let top = rect.bottom + 8;

      tooltip.style.left = '0px';
      tooltip.style.top = '0px';
      tooltip.classList.add('visible');

      const tooltipRect = tooltip.getBoundingClientRect();

      if (left + tooltipRect.width > window.innerWidth - 20) {
        left = window.innerWidth - tooltipRect.width - 20;
      }
      if (top + tooltipRect.height > window.innerHeight - 20) {
        top = rect.top - tooltipRect.height - 8;
      }

      tooltip.style.left = `${Math.max(10, left)}px`;
      tooltip.style.top = `${top}px`;
    }, 400);
  });

  el.addEventListener('mouseleave', () => {
    clearTimeout(tooltipTimeout);
    tooltip.classList.remove('visible');
  });
});

// ============================================================================
// Window Cleanup - prevent resource leaks on close
// ============================================================================

window.addEventListener('beforeunload', () => {
  // Stop level meter animation
  if (meterState.animationId) {
    cancelAnimationFrame(meterState.animationId);
    meterState.animationId = null;
  }

  // Clear seek update interval
  if (playerState.seekUpdateInterval) {
    clearInterval(playerState.seekUpdateInterval);
    playerState.seekUpdateInterval = null;
  }

  // Stop audio playback
  if (audioNodes.source) {
    try {
      audioNodes.source.stop();
    } catch (e) { /* ignore */ }
  }

  // Destroy WaveSurfer
  destroyWaveSurfer();

  // Destroy faders
  Object.keys(faders).forEach(key => {
    if (faders[key] && typeof faders[key].destroy === 'function') {
      try {
        faders[key].destroy();
      } catch (e) { /* ignore */ }
    }
    faders[key] = null;
  });

  // Close AudioContext
  if (audioNodes.context && audioNodes.context.state !== 'closed') {
    try {
      audioNodes.context.close();
    } catch (e) { /* ignore */ }
  }
});

// ============================================================================
// Initialize
// ============================================================================

// Initialize faders with callbacks that wire to audio chain
initFaders({
  onInputGainChange: (val) => {
    updateInputGain();
    // Input gain affects the master preview render (pre-limiter), so rebuild cache.
    updateAudioChain();
  },
  onCeilingChange: (val) => updateAudioChain(),
  onEQChange: (eqVals) => {
    updateEQ();
    // EQ affects the master preview render, so rebuild cache.
    updateAudioChain();
  }
});

// Setup EQ presets with callback
setupEQPresets(eqPresets, updateEQ);

// Setup output format presets
setupOutputPresets(outputPresets);

updateChecklist();

// Initialize DSP worker for off-main-thread processing
initDSPWorker().then(() => {
  console.log('[App] DSP Worker initialized');
}).catch(err => {
  console.warn('[App] DSP Worker initialization failed, falling back to main thread:', err);
});
