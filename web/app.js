import WaveSurfer from 'https://unpkg.com/wavesurfer.js@7/dist/wavesurfer.esm.js';
import { Fader } from './components/Fader.js';

let wavesurfer = null;
let currentBlobUrl = null; // Track blob URL for cleanup
let hoverContainer = null; // Track container reference for hover cleanup
let currentFile = null; // Store the currently selected File object (browser)

// Fader instances
const faders = {
  inputGain: null,
  ceiling: null,
  eqLow: null,
  eqLowMid: null,
  eqMid: null,
  eqHighMid: null,
  eqHigh: null,
};

// ============================================================================
// LUFS Loudness Measurement & Normalization (Pure JavaScript - No FFmpeg)
// ITU-R BS.1770-4 compliant implementation
// ============================================================================

// ITU-R BS.1770-4 K-weighting filter specifications
const K_WEIGHTING = {
  HIGH_SHELF_FREQ: 1681.97,   // Hz - Head-related transfer function correction
  HIGH_SHELF_GAIN: 4.0,       // dB
  HIGH_SHELF_Q: 0.71,         // Q factor (approximately 1/sqrt(2))
  HIGH_PASS_FREQ: 38.14,      // Hz - DC blocking / rumble filter
  HIGH_PASS_Q: 0.5            // Q factor
};

// LUFS gating thresholds (ITU-R BS.1770-4)
const LUFS_CONSTANTS = {
  BLOCK_SIZE_SEC: 0.4,           // 400ms measurement blocks
  BLOCK_OVERLAP: 0.75,           // 75% overlap (100ms hop)
  ABSOLUTE_GATE_LUFS: -70,       // Absolute threshold in LUFS
  ABSOLUTE_GATE_LINEAR: 1e-7,    // Math.pow(10, -70/10) = 1e-7
  RELATIVE_GATE_OFFSET: 0.1,     // -10 dB below ungated mean (10^(-10/10) = 0.1)
  LOUDNESS_OFFSET: -0.691        // Reference offset for LUFS calculation
};

/**
 * Apply biquad filter to audio samples
 */
function applyBiquadFilter(samples, coeffs) {
  const output = new Float32Array(samples.length);
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  const { b0, b1, b2, a1, a2 } = coeffs;

  for (let i = 0; i < samples.length; i++) {
    const x0 = samples[i];
    const y0 = b0 * x0 + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
    output[i] = y0;
    x2 = x1; x1 = x0;
    y2 = y1; y1 = y0;
  }
  return output;
}

/**
 * Calculate biquad coefficients for high shelf filter (K-weighting)
 */
function calcHighShelfCoeffs(sampleRate, frequency, gainDB, Q) {
  const A = Math.pow(10, gainDB / 40);
  const w0 = 2 * Math.PI * frequency / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);

  const b0 = A * ((A + 1) + (A - 1) * cosW0 + 2 * Math.sqrt(A) * alpha);
  const b1 = -2 * A * ((A - 1) + (A + 1) * cosW0);
  const b2 = A * ((A + 1) + (A - 1) * cosW0 - 2 * Math.sqrt(A) * alpha);
  const a0 = (A + 1) - (A - 1) * cosW0 + 2 * Math.sqrt(A) * alpha;
  const a1 = 2 * ((A - 1) - (A + 1) * cosW0);
  const a2 = (A + 1) - (A - 1) * cosW0 - 2 * Math.sqrt(A) * alpha;

  return { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 };
}

/**
 * Calculate biquad coefficients for high pass filter (K-weighting)
 */
function calcHighPassCoeffs(sampleRate, frequency, Q) {
  const w0 = 2 * Math.PI * frequency / sampleRate;
  const cosW0 = Math.cos(w0);
  const sinW0 = Math.sin(w0);
  const alpha = sinW0 / (2 * Q);

  const b0 = (1 + cosW0) / 2;
  const b1 = -(1 + cosW0);
  const b2 = (1 + cosW0) / 2;
  const a0 = 1 + alpha;
  const a1 = -2 * cosW0;
  const a2 = 1 - alpha;

  return { b0: b0/a0, b1: b1/a0, b2: b2/a0, a1: a1/a0, a2: a2/a0 };
}

/**
 * Measure integrated loudness (LUFS) of an AudioBuffer
 * Based on ITU-R BS.1770-4
 */
function measureLUFS(audioBuffer) {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  // Minimum block size required for LUFS measurement
  if (audioBuffer.duration < LUFS_CONSTANTS.BLOCK_SIZE_SEC) {
    console.warn(`[LUFS] Audio too short for reliable measurement (< ${LUFS_CONSTANTS.BLOCK_SIZE_SEC * 1000}ms)`);
    return targetLufsDb; // Return target LUFS as fallback
  }

  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  // Apply K-weighting filters (ITU-R BS.1770-4)
  const highShelfCoeffs = calcHighShelfCoeffs(
    sampleRate,
    K_WEIGHTING.HIGH_SHELF_FREQ,
    K_WEIGHTING.HIGH_SHELF_GAIN,
    K_WEIGHTING.HIGH_SHELF_Q
  );
  const highPassCoeffs = calcHighPassCoeffs(
    sampleRate,
    K_WEIGHTING.HIGH_PASS_FREQ,
    K_WEIGHTING.HIGH_PASS_Q
  );

  const filteredChannels = channels.map(ch => {
    let filtered = applyBiquadFilter(ch, highShelfCoeffs);
    filtered = applyBiquadFilter(filtered, highPassCoeffs);
    return filtered;
  });

  // Calculate mean square per block with overlap (ITU-R BS.1770-4)
  const blockSize = Math.floor(sampleRate * LUFS_CONSTANTS.BLOCK_SIZE_SEC);
  const hopSize = Math.floor(sampleRate * LUFS_CONSTANTS.BLOCK_SIZE_SEC * (1 - LUFS_CONSTANTS.BLOCK_OVERLAP));
  const blocks = [];

  for (let start = 0; start + blockSize <= length; start += hopSize) {
    let sumSquares = 0;
    for (let ch = 0; ch < numChannels; ch++) {
      const channelData = filteredChannels[ch];
      for (let i = start; i < start + blockSize; i++) {
        sumSquares += channelData[i] * channelData[i];
      }
    }
    blocks.push(sumSquares / (blockSize * numChannels));
  }

  if (blocks.length === 0) return -Infinity;

  // Absolute threshold gating (blocks below -70 LUFS are ignored)
  let gatedBlocks = blocks.filter(ms => ms > LUFS_CONSTANTS.ABSOLUTE_GATE_LINEAR);
  if (gatedBlocks.length === 0) return -Infinity;

  // Relative threshold gating (-10 dB below ungated mean)
  const ungatedMean = gatedBlocks.reduce((a, b) => a + b, 0) / gatedBlocks.length;
  gatedBlocks = gatedBlocks.filter(ms => ms > ungatedMean * LUFS_CONSTANTS.RELATIVE_GATE_OFFSET);
  if (gatedBlocks.length === 0) return -Infinity;

  // Calculate integrated loudness
  const gatedMean = gatedBlocks.reduce((a, b) => a + b, 0) / gatedBlocks.length;
  return LUFS_CONSTANTS.LOUDNESS_OFFSET + 10 * Math.log10(gatedMean);
}

/**
 * Calculate true peak for a sample using 4x oversampling with Catmull-Rom interpolation
 * Based on ITU-R BS.1770-4 true peak measurement
 * @param {number[]} prevSamples - Array of 4 samples [y0, y1, y2, y3] where y2 is the current sample
 * @returns {number} The true peak (maximum interpolated value)
 */
function calculateTruePeakSample(prevSamples) {
  const y0 = prevSamples[0];
  const y1 = prevSamples[1];
  const y2 = prevSamples[2];
  const y3 = prevSamples[3];

  // Start with the sample value itself
  let peak = Math.abs(y2);

  // Catmull-Rom coefficients
  const a0 = -0.5 * y0 + 1.5 * y1 - 1.5 * y2 + 0.5 * y3;
  const a1 = y0 - 2.5 * y1 + 2 * y2 - 0.5 * y3;
  const a2 = -0.5 * y0 + 0.5 * y2;
  const a3 = y1;

  // Check 4x oversampled points between y1 and y2
  for (let i = 1; i <= 3; i++) {
    const t = i * 0.25;
    const t2 = t * t;
    const t3 = t2 * t;
    const interpolated = a0 * t3 + a1 * t2 + a2 * t + a3;
    peak = Math.max(peak, Math.abs(interpolated));
  }

  return peak;
}

/**
 * Find the true peak of an AudioBuffer using 4x oversampling
 * Returns peak in dBTP (decibels relative to full scale)
 */
function findTruePeak(audioBuffer) {
  let maxPeak = 0;

  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const channelData = audioBuffer.getChannelData(ch);
    const prevSamples = [0, 0, 0, 0];

    for (let i = 0; i < channelData.length; i++) {
      // Shift samples
      prevSamples[0] = prevSamples[1];
      prevSamples[1] = prevSamples[2];
      prevSamples[2] = prevSamples[3];
      prevSamples[3] = channelData[i];

      // Need at least 4 samples for interpolation
      if (i >= 3) {
        const truePeak = calculateTruePeakSample(prevSamples);
        if (truePeak > maxPeak) {
          maxPeak = truePeak;
        }
      }
    }
  }

  // Convert to dBTP (0 dBTP = 1.0 linear)
  return maxPeak > 0 ? 20 * Math.log10(maxPeak) : -Infinity;
}

/**
 * Apply lookahead limiter to an AudioBuffer
 * Uses true peak detection and smooth gain envelope
 * @param {AudioBuffer} audioBuffer - Input buffer
 * @param {number} ceilingLinear - Ceiling in linear (default 0.891 = -1 dBTP)
 * @param {number} lookaheadMs - Lookahead time in ms (default 3ms)
 * @param {number} releaseMs - Release time in ms (default 100ms)
 * @returns {AudioBuffer} Limited buffer
 */
function applyLookaheadLimiter(audioBuffer, ceilingLinear = 0.891, lookaheadMs = 3, releaseMs = 100) {
  const sampleRate = audioBuffer.sampleRate;
  const numChannels = audioBuffer.numberOfChannels;
  const length = audioBuffer.length;

  const lookaheadSamples = Math.floor(sampleRate * lookaheadMs / 1000);
  const releaseCoef = Math.exp(-1 / (releaseMs * sampleRate / 1000));

  // Get channel data
  const channels = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channels.push(audioBuffer.getChannelData(ch));
  }

  // First pass: Calculate gain reduction envelope
  const gainEnvelope = new Float32Array(length);
  gainEnvelope.fill(1.0);

  const prevSamplesL = [0, 0, 0, 0];
  const prevSamplesR = numChannels > 1 ? [0, 0, 0, 0] : null;

  for (let i = 0; i < length; i++) {
    // Update previous samples for true peak calculation
    prevSamplesL[0] = prevSamplesL[1];
    prevSamplesL[1] = prevSamplesL[2];
    prevSamplesL[2] = prevSamplesL[3];
    prevSamplesL[3] = channels[0][i];

    let truePeak = 0;
    if (i >= 3) {
      truePeak = calculateTruePeakSample(prevSamplesL);
    }

    if (numChannels > 1 && prevSamplesR) {
      prevSamplesR[0] = prevSamplesR[1];
      prevSamplesR[1] = prevSamplesR[2];
      prevSamplesR[2] = prevSamplesR[3];
      prevSamplesR[3] = channels[1][i];

      if (i >= 3) {
        truePeak = Math.max(truePeak, calculateTruePeakSample(prevSamplesR));
      }
    }

    // Calculate required gain reduction
    let requiredGain = 1.0;
    if (truePeak > ceilingLinear) {
      requiredGain = ceilingLinear / truePeak;
    }

    // Apply lookahead - the gain reduction affects samples BEFORE this point
    const targetIndex = Math.max(0, i - lookaheadSamples);
    if (requiredGain < gainEnvelope[targetIndex]) {
      // Instant attack - apply gain reduction immediately
      for (let j = targetIndex; j <= i; j++) {
        gainEnvelope[j] = Math.min(gainEnvelope[j], requiredGain);
      }
    }
  }

  // Second pass: Smooth the gain envelope (release)
  let currentGain = 1.0;
  for (let i = 0; i < length; i++) {
    if (gainEnvelope[i] < currentGain) {
      // Instant attack
      currentGain = gainEnvelope[i];
    } else {
      // Smooth release
      currentGain = releaseCoef * currentGain + (1 - releaseCoef) * 1.0;
      currentGain = Math.min(currentGain, 1.0);
    }
    gainEnvelope[i] = currentGain;
  }

  // Create output buffer and apply gain envelope
  const outputBuffer = new AudioBuffer({
    numberOfChannels: numChannels,
    length: length,
    sampleRate: sampleRate
  });

  for (let ch = 0; ch < numChannels; ch++) {
    const input = channels[ch];
    const output = outputBuffer.getChannelData(ch);
    for (let i = 0; i < length; i++) {
      output[i] = input[i] * gainEnvelope[i];
    }
  }

  // Log gain reduction stats
  let minGain = 1.0;
  for (let i = 0; i < length; i++) {
    if (gainEnvelope[i] < minGain) minGain = gainEnvelope[i];
  }
  if (minGain < 1.0) {
    console.log('[Limiter] Max gain reduction:', (20 * Math.log10(minGain)).toFixed(2), 'dB');
  }

  return outputBuffer;
}

/**
 * Normalize an AudioBuffer to target LUFS by applying gain
 * Enforces true peak ceiling to prevent clipping
 * Uses AudioBuffer constructor directly (no OfflineAudioContext overhead)
 */
function normalizeToLUFS(audioBuffer, targetLUFS = -14, ceilingDB = -1) {
  const currentLUFS = measureLUFS(audioBuffer);
  const currentPeakDB = findTruePeak(audioBuffer);

  console.log('[LUFS] Current:', currentLUFS.toFixed(2), 'LUFS, Peak:', currentPeakDB.toFixed(2), 'dBTP');
  console.log('[LUFS] Target:', targetLUFS, 'LUFS, Ceiling:', ceilingDB, 'dBTP');

  if (!isFinite(currentLUFS)) {
    console.warn('[LUFS] Could not measure loudness, skipping normalization');
    return audioBuffer;
  }

  // Calculate gain needed to reach target LUFS
  const lufsGainDB = targetLUFS - currentLUFS;
  const gainLinear = Math.pow(10, lufsGainDB / 20);

  // Calculate what the peak will be after applying gain
  const projectedPeakDB = currentPeakDB + lufsGainDB;
  const ceilingLinear = Math.pow(10, ceilingDB / 20);

  console.log('[LUFS] Applying gain:', lufsGainDB.toFixed(2), 'dB');

  // Create buffer with gain applied
  const gainedBuffer = new AudioBuffer({
    numberOfChannels: audioBuffer.numberOfChannels,
    length: audioBuffer.length,
    sampleRate: audioBuffer.sampleRate
  });

  for (let ch = 0; ch < audioBuffer.numberOfChannels; ch++) {
    const input = audioBuffer.getChannelData(ch);
    const output = gainedBuffer.getChannelData(ch);
    for (let i = 0; i < input.length; i++) {
      output[i] = input[i] * gainLinear;
    }
  }

  // If peaks will exceed ceiling, apply lookahead limiter
  if (projectedPeakDB > ceilingDB) {
    console.log('[LUFS] Projected peak:', projectedPeakDB.toFixed(2), 'dBTP exceeds ceiling, applying limiter');
    const limitedBuffer = applyLookaheadLimiter(gainedBuffer, ceilingLinear, 3, 100);

    // Verify final levels
    const finalPeakDB = findTruePeak(limitedBuffer);
    const finalLUFS = measureLUFS(limitedBuffer);
    console.log('[LUFS] After limiting - Peak:', finalPeakDB.toFixed(2), 'dBTP, LUFS:', finalLUFS.toFixed(2));

    return limitedBuffer;
  }

  return gainedBuffer;
}

// ============================================================================
// Application State
// ============================================================================

// Grouped state for better organization and easier resets
const playerState = {
  isPlaying: false,
  isBypassed: false,
  isSeeking: false,
  startTime: 0,
  pauseTime: 0,
  seekUpdateInterval: null,
  seekTimeout: null
};

const audioNodes = {
  context: null,
  source: null,
  buffer: null,
  analyser: null,
  analyserL: null,   // Left channel analyser for meter
  analyserR: null,   // Right channel analyser for meter
  meterSplitter: null,
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
  isNormalizing: false       // True while normalization is in progress
};

// Level meter state
const meterState = {
  levels: [0, 0],       // Current levels (linear, 0-1)
  peakLevels: [-Infinity, -Infinity],  // Peak hold in dB
  peakHoldTimes: [0, 0],  // When peak was set
  overload: false,
  overloadTime: 0,
  animationId: null,
  PEAK_HOLD_TIME: 1.5,    // seconds
  FALL_RATE: 25,          // dB per second
  OVERLOAD_DISPLAY_TIME: 2.0  // seconds
};

let isProcessing = false;
let processingCancelled = false;
let processingPromise = null; // Track processing for proper cancellation

// ============================================================================
// DOM Elements
// ============================================================================

const fileInput = document.getElementById('fileInput'); // Browser file input

const selectFileBtn = document.getElementById('selectFile');
const changeFileBtn = document.getElementById('changeFile');
const fileZoneContent = document.getElementById('fileZoneContent');
const fileLoaded = document.getElementById('fileLoaded');
const fileName = document.getElementById('fileName');
const fileMeta = document.getElementById('fileMeta');
const dropZone = document.getElementById('dropZone');
const processBtn = document.getElementById('processBtn');
const cancelBtn = document.getElementById('cancelBtn');
const progressContainer = document.getElementById('progressContainer');
const progressFill = document.getElementById('progressFill');
const progressText = document.getElementById('progressText');
const statusMessage = document.getElementById('statusMessage');

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

// Player elements
const playBtn = document.getElementById('playBtn');
const stopBtn = document.getElementById('stopBtn');
const playIcon = document.getElementById('playIcon');
const pauseIcon = document.getElementById('pauseIcon');
const seekBar = document.getElementById('seekBar');
const currentTimeEl = document.getElementById('currentTime');
const durationEl = document.getElementById('duration');
const bypassBtn = document.getElementById('bypassBtn');

// Helper to update play/pause icons
function updatePlayPauseIcon(isPlaying) {
  if (playIcon && pauseIcon) {
    playIcon.style.display = isPlaying ? 'none' : 'flex';
    pauseIcon.style.display = isPlaying ? 'flex' : 'none';
  }
}

// Settings
const normalizeLoudness = document.getElementById('normalizeLoudness');
const truePeakLimit = document.getElementById('truePeakLimit');
// truePeakSlider and ceilingValue removed - now using faders
const cleanLowEnd = document.getElementById('cleanLowEnd');
const glueCompression = document.getElementById('glueCompression');
const stereoWidthSlider = document.getElementById('stereoWidth');
const stereoWidthValue = document.getElementById('stereoWidthValue');
const centerBass = document.getElementById('centerBass');
const cutMud = document.getElementById('cutMud');
const addAir = document.getElementById('addAir');
const tameHarsh = document.getElementById('tameHarsh');
const sampleRate = document.getElementById('sampleRate');
const bitDepth = document.getElementById('bitDepth');
const targetLufsSlider = document.getElementById('targetLufs');
const targetLufsValue = document.getElementById('targetLufsValue');
const miniLufsValue = document.getElementById('mini-lufs-value');

// EQ values (managed by faders)
let eqValues = {
  low: 0,
  lowMid: 0,
  mid: 0,
  highMid: 0,
  high: 0
};

// Input gain and ceiling values (managed by faders)
let inputGainValue = 0;  // dB
let ceilingValueDb = -1; // dB
let targetLufsDb = -9;   // Target LUFS for normalization (default -9)

// Level meter elements
const meterCanvas = document.getElementById('meterCanvas');
const meterCtx = meterCanvas ? meterCanvas.getContext('2d') : null;
const peakLDisplay = document.getElementById('peakL');
const peakRDisplay = document.getElementById('peakR');
const overloadIndicator = document.getElementById('overloadIndicator');

// Mini checklist
const miniLufs = document.getElementById('mini-lufs');
const miniPeak = document.getElementById('mini-peak');
const miniFormat = document.getElementById('mini-format');

// ============================================================================
// Web Audio API (for real-time preview)
// ============================================================================

async function cleanupAudioContext() {
  // Destroy WaveSurfer first - it may hold references to AudioContext
  if (wavesurfer) {
    try {
      wavesurfer.destroy();
    } catch (e) {
      console.warn('Error destroying WaveSurfer:', e);
    }
    wavesurfer = null;
  }

  // Revoke blob URL
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }

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
  audioNodes.analyserL = ctx.createAnalyser();
  audioNodes.analyserL.fftSize = 2048;
  audioNodes.analyserR = ctx.createAnalyser();
  audioNodes.analyserR.fftSize = 2048;
  audioNodes.meterSplitter = ctx.createChannelSplitter(2);

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
  audioNodes.limiter.ratio.value = 20;
  audioNodes.limiter.attack.value = 0.001;
  audioNodes.limiter.release.value = 0.05;

  updateAudioChain();
  updateStereoWidth();
  updateEQ();
}

function updateAudioChain() {
  if (!audioNodes.context || !audioNodes.highpass) return;

  // Highpass (clean low end)
  audioNodes.highpass.frequency.value = (cleanLowEnd.checked && !playerState.isBypassed) ? 30 : 1;

  // Cut Mud
  audioNodes.lowshelf.gain.value = (cutMud.checked && !playerState.isBypassed) ? -3 : 0;

  // Add Air
  audioNodes.highshelf.gain.value = (addAir.checked && !playerState.isBypassed) ? 2.5 : 0;

  // Tame Harshness
  audioNodes.midPeak.gain.value = (tameHarsh.checked && !playerState.isBypassed) ? -2 : 0;

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
  } else {
    audioNodes.limiter.threshold.value = 0;
    audioNodes.limiter.ratio.value = 1;
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
  // First part of chain: source -> inputGain -> highpass -> EQ -> effects
  const preChain = source
    .connect(audioNodes.inputGain)
    .connect(audioNodes.highpass);

  preChain
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
  // Split into L and R channels
  // L channel (0) -> lToMid (for L output) and lToSide (for R output)
  audioNodes.stereoSplitter.connect(audioNodes.lToMid, 0);
  audioNodes.stereoSplitter.connect(audioNodes.lToSide, 0);
  // R channel (1) -> rToMid (for L output) and rToSide (for R output)
  audioNodes.stereoSplitter.connect(audioNodes.rToMid, 1);
  audioNodes.stereoSplitter.connect(audioNodes.rToSide, 1);

  // Sum for L output: lToMid + rToMid -> merger channel 0
  audioNodes.lToMid.connect(audioNodes.stereoMerger, 0, 0);
  audioNodes.rToMid.connect(audioNodes.stereoMerger, 0, 0);

  // Sum for R output: lToSide + rToSide -> merger channel 1
  audioNodes.lToSide.connect(audioNodes.stereoMerger, 0, 1);
  audioNodes.rToSide.connect(audioNodes.stereoMerger, 0, 1);

  // Continue chain: stereo merger -> limiter -> meter splitter -> analysers & output
  audioNodes.stereoMerger
    .connect(audioNodes.limiter)
    .connect(audioNodes.meterSplitter);

  // Split for stereo metering
  audioNodes.meterSplitter.connect(audioNodes.analyserL, 0);
  audioNodes.meterSplitter.connect(audioNodes.analyserR, 1);

  // Also connect to main analyser and output
  audioNodes.limiter
    .connect(audioNodes.analyser)
    .connect(audioNodes.gain)
    .connect(audioNodes.context.destination);
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

// ============================================================================
// Fader Initialization
// ============================================================================

function initFaders() {
  // Destroy old faders before creating new ones (prevents memory leaks on re-init)
  Object.keys(faders).forEach(key => {
    if (faders[key] && typeof faders[key].destroy === 'function') {
      faders[key].destroy();
    }
    faders[key] = null;
  });

  // Input Gain Fader
  faders.inputGain = new Fader('#inputGainFader', {
    min: -12,
    max: 12,
    value: 0,
    step: 0.5,
    label: 'Input',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      inputGainValue = val;
      updateInputGain();
    }
  });

  // Ceiling Fader
  faders.ceiling = new Fader('#ceilingFader', {
    min: -6,
    max: 0,
    value: -1,
    step: 0.5,
    label: 'Ceiling',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      ceilingValueDb = val;
      updateAudioChain();
    }
  });

  // EQ Faders
  faders.eqLow = new Fader('#eqLowFader', {
    min: -12,
    max: 12,
    value: 0,
    step: 0.5,
    label: '80Hz',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      eqValues.low = val;
      updateEQ();
      clearActivePreset();
    }
  });

  faders.eqLowMid = new Fader('#eqLowMidFader', {
    min: -12,
    max: 12,
    value: 0,
    step: 0.5,
    label: '250Hz',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      eqValues.lowMid = val;
      updateEQ();
      clearActivePreset();
    }
  });

  faders.eqMid = new Fader('#eqMidFader', {
    min: -12,
    max: 12,
    value: 0,
    step: 0.5,
    label: '1kHz',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      eqValues.mid = val;
      updateEQ();
      clearActivePreset();
    }
  });

  faders.eqHighMid = new Fader('#eqHighMidFader', {
    min: -12,
    max: 12,
    value: 0,
    step: 0.5,
    label: '4kHz',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      eqValues.highMid = val;
      updateEQ();
      clearActivePreset();
    }
  });

  faders.eqHigh = new Fader('#eqHighFader', {
    min: -12,
    max: 12,
    value: 0,
    step: 0.5,
    label: '12kHz',
    unit: 'dB',
    orientation: 'vertical',
    height: 120,
    showScale: false,
    decimals: 1,
    onChange: (val) => {
      eqValues.high = val;
      updateEQ();
      clearActivePreset();
    }
  });
}

function clearActivePreset() {
  document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
}

// ============================================================================
// Offline Render (Bounce) - Uses same Web Audio processing as preview
// ============================================================================

/**
 * Encode an AudioBuffer to WAV format (supports 16-bit and 24-bit)
 */
function encodeWAV(audioBuffer, targetSampleRate, bitDepth) {
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = targetSampleRate || audioBuffer.sampleRate;
  const bytesPerSample = bitDepth / 8;

  const channelData = [];
  for (let ch = 0; ch < numChannels; ch++) {
    channelData.push(audioBuffer.getChannelData(ch));
  }

  const numSamples = channelData[0].length;
  const dataSize = numSamples * numChannels * bytesPerSample;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);

  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
  view.setUint16(32, numChannels * bytesPerSample, true);
  view.setUint16(34, bitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const maxVal = bitDepth === 16 ? 32767 : 8388607;

  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      const intSample = Math.round(sample * maxVal);

      if (bitDepth === 16) {
        view.setInt16(offset, intSample, true);
        offset += 2;
      } else if (bitDepth === 24) {
        // Clamp to prevent overflow in bitwise operations
        const clampedSample = Math.max(-8388607, Math.min(8388607, intSample));
        view.setUint8(offset, clampedSample & 0xFF);
        view.setUint8(offset + 1, (clampedSample >> 8) & 0xFF);
        view.setUint8(offset + 2, (clampedSample >> 16) & 0xFF);
        offset += 3;
      }
    }
  }

  return new Uint8Array(buffer);
}

/**
 * Create audio processing nodes for offline context (same as preview chain)
 */
function createOfflineNodes(offlineCtx, settings) {
  const nodes = {};

  // Input gain (first in chain)
  nodes.inputGain = offlineCtx.createGain();
  const inputGainDb = settings.inputGain || 0;
  nodes.inputGain.gain.value = Math.pow(10, inputGainDb / 20);

  nodes.highpass = offlineCtx.createBiquadFilter();
  nodes.lowshelf = offlineCtx.createBiquadFilter();
  nodes.highshelf = offlineCtx.createBiquadFilter();
  nodes.midPeak = offlineCtx.createBiquadFilter();
  nodes.compressor = offlineCtx.createDynamicsCompressor();
  nodes.limiter = offlineCtx.createDynamicsCompressor();

  nodes.eqLow = offlineCtx.createBiquadFilter();
  nodes.eqLowMid = offlineCtx.createBiquadFilter();
  nodes.eqMid = offlineCtx.createBiquadFilter();
  nodes.eqHighMid = offlineCtx.createBiquadFilter();
  nodes.eqHigh = offlineCtx.createBiquadFilter();

  nodes.stereoSplitter = offlineCtx.createChannelSplitter(2);
  nodes.stereoMerger = offlineCtx.createChannelMerger(2);
  nodes.lToMid = offlineCtx.createGain();
  nodes.rToMid = offlineCtx.createGain();
  nodes.lToSide = offlineCtx.createGain();
  nodes.rToSide = offlineCtx.createGain();

  // Configure EQ bands
  nodes.eqLow.type = 'lowshelf';
  nodes.eqLow.frequency.value = 80;
  nodes.eqLow.gain.value = settings.eqLow || 0;

  nodes.eqLowMid.type = 'peaking';
  nodes.eqLowMid.frequency.value = 250;
  nodes.eqLowMid.Q.value = 1;
  nodes.eqLowMid.gain.value = settings.eqLowMid || 0;

  nodes.eqMid.type = 'peaking';
  nodes.eqMid.frequency.value = 1000;
  nodes.eqMid.Q.value = 1;
  nodes.eqMid.gain.value = settings.eqMid || 0;

  nodes.eqHighMid.type = 'peaking';
  nodes.eqHighMid.frequency.value = 4000;
  nodes.eqHighMid.Q.value = 1;
  nodes.eqHighMid.gain.value = settings.eqHighMid || 0;

  nodes.eqHigh.type = 'highshelf';
  nodes.eqHigh.frequency.value = 12000;
  nodes.eqHigh.gain.value = settings.eqHigh || 0;

  nodes.highpass.type = 'highpass';
  nodes.highpass.frequency.value = settings.cleanLowEnd ? 30 : 1;
  nodes.highpass.Q.value = 0.7;

  nodes.lowshelf.type = 'peaking';
  nodes.lowshelf.frequency.value = 250;
  nodes.lowshelf.Q.value = 1.5;
  nodes.lowshelf.gain.value = settings.cutMud ? -3 : 0;

  nodes.highshelf.type = 'highshelf';
  nodes.highshelf.frequency.value = 12000;
  nodes.highshelf.gain.value = settings.addAir ? 2.5 : 0;

  nodes.midPeak.type = 'peaking';
  nodes.midPeak.frequency.value = 5000;
  nodes.midPeak.Q.value = 2;
  nodes.midPeak.gain.value = settings.tameHarsh ? -2 : 0;

  if (settings.glueCompression) {
    nodes.compressor.threshold.value = -18;
    nodes.compressor.knee.value = 10;
    nodes.compressor.ratio.value = 3;
    nodes.compressor.attack.value = 0.02;
    nodes.compressor.release.value = 0.25;
  } else {
    nodes.compressor.threshold.value = 0;
    nodes.compressor.ratio.value = 1;
  }

  if (settings.truePeakLimit) {
    nodes.limiter.threshold.value = settings.truePeakCeiling || -1;
    nodes.limiter.knee.value = 0;
    nodes.limiter.ratio.value = 20;
    nodes.limiter.attack.value = 0.001;
    nodes.limiter.release.value = 0.05;
  } else {
    nodes.limiter.threshold.value = 0;
    nodes.limiter.ratio.value = 1;
  }

  const width = settings.stereoWidth !== undefined ? settings.stereoWidth / 100 : 1.0;
  const midCoef = 0.5;
  const sideCoef = 0.5 * width;
  nodes.lToMid.gain.value = midCoef + sideCoef;
  nodes.rToMid.gain.value = midCoef - sideCoef;
  nodes.lToSide.gain.value = midCoef - sideCoef;
  nodes.rToSide.gain.value = midCoef + sideCoef;

  return nodes;
}

/**
 * Render audio buffer through effects chain using OfflineAudioContext
 */
async function renderOffline(sourceBuffer, settings, onProgress) {
  const targetSampleRate = settings.sampleRate || 44100;
  const duration = sourceBuffer.duration;
  const numSamples = Math.ceil(duration * targetSampleRate);

  console.log('[Offline Render] Starting...', { duration, targetSampleRate, numSamples });

  const offlineCtx = new OfflineAudioContext(2, numSamples, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = sourceBuffer;

  const nodes = createOfflineNodes(offlineCtx, settings);

  source.connect(nodes.inputGain)
    .connect(nodes.highpass)
    .connect(nodes.eqLow)
    .connect(nodes.eqLowMid)
    .connect(nodes.eqMid)
    .connect(nodes.eqHighMid)
    .connect(nodes.eqHigh)
    .connect(nodes.lowshelf)
    .connect(nodes.midPeak)
    .connect(nodes.highshelf)
    .connect(nodes.compressor)
    .connect(nodes.stereoSplitter);

  nodes.stereoSplitter.connect(nodes.lToMid, 0);
  nodes.stereoSplitter.connect(nodes.lToSide, 0);
  nodes.stereoSplitter.connect(nodes.rToMid, 1);
  nodes.stereoSplitter.connect(nodes.rToSide, 1);

  nodes.lToMid.connect(nodes.stereoMerger, 0, 0);
  nodes.rToMid.connect(nodes.stereoMerger, 0, 0);
  nodes.lToSide.connect(nodes.stereoMerger, 0, 1);
  nodes.rToSide.connect(nodes.stereoMerger, 0, 1);

  nodes.stereoMerger.connect(nodes.limiter).connect(offlineCtx.destination);

  source.start(0);
  if (onProgress) onProgress(10);

  const renderedBuffer = await offlineCtx.startRendering();
  if (onProgress) onProgress(70);

  const wavData = encodeWAV(renderedBuffer, targetSampleRate, settings.bitDepth || 16);
  if (onProgress) onProgress(90);

  console.log('[Offline Render] Complete!', { outputSize: wavData.byteLength });
  return wavData;
}

// ============================================================================
// Level Meter
// ============================================================================

function amplitudeToDB(amplitude) {
  return 20 * Math.log10(amplitude < 1e-8 ? 1e-8 : amplitude);
}

function updateLevelMeter() {
  if (!audioNodes.analyserL || !meterCtx || !playerState.isPlaying) return;

  const time = performance.now() / 1000;

  // Get time domain data from L and R analysers
  const bufferLength = audioNodes.analyserL.fftSize;
  const dataArrayL = new Float32Array(bufferLength);
  const dataArrayR = new Float32Array(bufferLength);
  audioNodes.analyserL.getFloatTimeDomainData(dataArrayL);
  audioNodes.analyserR.getFloatTimeDomainData(dataArrayR);

  // Calculate peak for left and right channels separately
  let peakL = 0, peakR = 0;
  for (let i = 0; i < bufferLength; i++) {
    const absL = Math.abs(dataArrayL[i]);
    const absR = Math.abs(dataArrayR[i]);
    if (absL > peakL) peakL = absL;
    if (absR > peakR) peakR = absR;
  }

  const peaks = [peakL, peakR];
  const dbLevels = peaks.map(p => amplitudeToDB(p));

  // Update levels with fall rate
  const deltaTime = 1 / 60; // Approximate frame time
  for (let ch = 0; ch < 2; ch++) {
    const fallingLevel = meterState.levels[ch] - meterState.FALL_RATE * deltaTime;
    meterState.levels[ch] = Math.max(dbLevels[ch], Math.max(-96, fallingLevel));

    // Update peak hold
    if (dbLevels[ch] > meterState.peakLevels[ch]) {
      meterState.peakLevels[ch] = dbLevels[ch];
      meterState.peakHoldTimes[ch] = time;
    } else if (time > meterState.peakHoldTimes[ch] + meterState.PEAK_HOLD_TIME) {
      // Let peak fall after hold time
      const fallingPeak = meterState.peakLevels[ch] - meterState.FALL_RATE * deltaTime;
      meterState.peakLevels[ch] = Math.max(fallingPeak, meterState.levels[ch]);
    }
  }

  // Check overload
  if (peakL > 1.0 || peakR > 1.0) {
    meterState.overload = true;
    meterState.overloadTime = time;
  } else if (time > meterState.overloadTime + meterState.OVERLOAD_DISPLAY_TIME) {
    meterState.overload = false;
  }

  // Draw meter
  drawMeter();

  // Update peak displays
  if (peakLDisplay) {
    const peakL = meterState.peakLevels[0];
    peakLDisplay.textContent = `L: ${peakL > -96 ? peakL.toFixed(1) : '-∞'} dB`;
  }
  if (peakRDisplay) {
    const peakR = meterState.peakLevels[1];
    peakRDisplay.textContent = `R: ${peakR > -96 ? peakR.toFixed(1) : '-∞'} dB`;
  }

  // Update overload indicator
  if (overloadIndicator) {
    overloadIndicator.classList.toggle('active', meterState.overload);
  }

  // Continue animation
  meterState.animationId = requestAnimationFrame(updateLevelMeter);
}

function drawMeter() {
  if (!meterCtx) return;

  const width = meterCanvas.width;
  const height = meterCanvas.height;
  const dbRange = 48; // -48 to 0 dB
  const dbStart = -48;
  const channelHeight = height / 2 - 1;

  // Clear canvas
  meterCtx.fillStyle = '#0a0a0a';
  meterCtx.fillRect(0, 0, width, height);

  // Draw each channel
  for (let ch = 0; ch < 2; ch++) {
    const y = ch * (height / 2);
    const level = meterState.levels[ch];
    const peakLevel = meterState.peakLevels[ch];

    // Create gradient
    const gradient = meterCtx.createLinearGradient(0, 0, width, 0);
    gradient.addColorStop(0, '#22c55e');           // Green
    gradient.addColorStop(0.75, '#22c55e');        // Green until -12dB
    gradient.addColorStop(0.75, '#eab308');        // Yellow
    gradient.addColorStop(0.875, '#eab308');       // Yellow until -6dB
    gradient.addColorStop(0.875, '#ef4444');       // Red
    gradient.addColorStop(1, '#ef4444');           // Red

    // Draw level bar
    const levelWidth = Math.max(0, ((level - dbStart) / dbRange) * width);
    meterCtx.fillStyle = gradient;
    meterCtx.fillRect(0, y + 1, levelWidth, channelHeight);

    // Draw peak indicator
    if (peakLevel > -96) {
      const peakX = ((peakLevel - dbStart) / dbRange) * width;
      meterCtx.fillStyle = '#ffffff';
      meterCtx.fillRect(Math.max(0, peakX - 1), y + 1, 2, channelHeight);
    }
  }

  // Draw channel separator
  meterCtx.fillStyle = '#333';
  meterCtx.fillRect(0, height / 2 - 0.5, width, 1);
}

function startMeter() {
  if (!meterState.animationId) {
    // Reset meter state
    meterState.levels = [-96, -96];
    meterState.peakLevels = [-Infinity, -Infinity];
    meterState.overload = false;
    updateLevelMeter();
  }
}

function stopMeter() {
  if (meterState.animationId) {
    cancelAnimationFrame(meterState.animationId);
    meterState.animationId = null;
  }
  // Reset display
  meterState.levels = [-96, -96];
  meterState.peakLevels = [-Infinity, -Infinity];
  meterState.overload = false;
  drawMeter();
  if (peakLDisplay) peakLDisplay.textContent = 'L: -∞ dB';
  if (peakRDisplay) peakRDisplay.textContent = 'R: -∞ dB';
  if (overloadIndicator) overloadIndicator.classList.remove('active');
}

// ============================================================================
// WaveSurfer Waveform
// ============================================================================

function initWaveSurfer(audioBuffer, originalBlob) {
  // Cleanup previous instance
  if (wavesurfer) {
    wavesurfer.destroy();
    wavesurfer = null;
  }

  // Revoke previous blob URL to prevent memory leak
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }

  try {
    // Create gradient
    const ctx = document.createElement('canvas').getContext('2d');
    const waveGradient = ctx.createLinearGradient(0, 0, 0, 48);
    waveGradient.addColorStop(0, 'rgba(188, 177, 231, 0.8)');
    waveGradient.addColorStop(0.5, 'rgba(154, 143, 209, 0.6)');
    waveGradient.addColorStop(1, 'rgba(100, 90, 160, 0.3)');

    const progressGradient = ctx.createLinearGradient(0, 0, 0, 48);
    progressGradient.addColorStop(0, '#BCB1E7');
    progressGradient.addColorStop(0.5, '#9A8FD1');
    progressGradient.addColorStop(1, '#7A6FB1');

    // Extract peaks for immediate display
    const peaks = extractPeaks(audioBuffer);

    // Create blob URL for WaveSurfer (tracked for cleanup)
    currentBlobUrl = URL.createObjectURL(originalBlob);

    wavesurfer = WaveSurfer.create({
      container: '#waveform',
      waveColor: waveGradient,
      progressColor: progressGradient,
      cursorColor: '#ffffff',
      cursorWidth: 2,
      height: 48,
      barWidth: 2,
      barGap: 1,
      barRadius: 2,
      normalize: true,
      interact: true,
      dragToSeek: true,
      url: currentBlobUrl,
      peaks: [peaks],
      duration: audioBuffer.duration,
    });

    // Custom hover handler (uses our known duration, not WaveSurfer's state)
    setupWaveformHover(audioBuffer.duration);

    // Mute wavesurfer - we use our own Web Audio chain
    wavesurfer.setVolume(0);

    // Log when audio is ready
    wavesurfer.on('ready', () => {
      console.log('WaveSurfer ready, duration:', wavesurfer.getDuration());
    });

    // Handle click for seeking (click gives relativeX 0-1)
    wavesurfer.on('click', (relativeX) => {
      const duration = audioNodes.buffer?.duration || wavesurfer.getDuration();
      const time = relativeX * duration;
      console.log('WaveSurfer click:', relativeX, 'time:', time);
      seekBar.value = time;
      currentTimeEl.textContent = formatTime(time);
      seekTo(time);
    });

    // Handle drag for seeking
    wavesurfer.on('drag', (relativeX) => {
      const duration = audioNodes.buffer?.duration || wavesurfer.getDuration();
      const time = relativeX * duration;
      seekBar.value = time;
      currentTimeEl.textContent = formatTime(time);
      seekTo(time);
    });
  } catch (error) {
    console.error('WaveSurfer initialization failed:', error);
    wavesurfer = null;
    // Application continues without waveform visualization
  }
}

function extractPeaks(audioBuffer, numPeaks = 1000) {
  const channelData = audioBuffer.getChannelData(0);
  const samplesPerPeak = Math.floor(channelData.length / numPeaks);
  const peaks = [];

  for (let i = 0; i < numPeaks; i++) {
    const start = i * samplesPerPeak;
    const end = Math.min(start + samplesPerPeak, channelData.length);
    let max = 0;
    for (let j = start; j < end; j++) {
      const abs = Math.abs(channelData[j]);
      if (abs > max) max = abs;
    }
    peaks.push(max);
  }

  return peaks;
}

// Custom hover handler for waveform (uses known duration instead of WaveSurfer state)
let hoverElements = null;
let hoverListeners = null;

function setupWaveformHover(duration) {
  const container = document.querySelector('#waveform');
  if (!container) return;

  // Clean up existing hover elements
  if (hoverElements) {
    hoverElements.line.remove();
    hoverElements.label.remove();
    hoverElements = null;
  }

  // Remove old event listeners from the stored container reference
  // This prevents leaks if the container DOM element changed
  if (hoverContainer && hoverListeners) {
    hoverContainer.removeEventListener('mousemove', hoverListeners.move);
    hoverContainer.removeEventListener('mouseleave', hoverListeners.leave);
    hoverListeners = null;
  }

  // Store new container reference
  hoverContainer = container;

  // Create hover line
  const line = document.createElement('div');
  line.style.cssText = `
    position: absolute;
    top: 0;
    height: 100%;
    width: 1px;
    background: rgba(255, 255, 255, 0.5);
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.1s;
    z-index: 10;
  `;
  container.style.position = 'relative';
  container.appendChild(line);

  // Create hover label
  const label = document.createElement('div');
  label.style.cssText = `
    position: absolute;
    top: 2px;
    background: #1a1a1a;
    color: #BCB1E7;
    font-size: 11px;
    padding: 2px 4px;
    border-radius: 2px;
    pointer-events: none;
    opacity: 0;
    transition: opacity 0.1s;
    z-index: 11;
    white-space: nowrap;
  `;
  container.appendChild(label);

  hoverElements = { line, label };

  // Mouse move handler
  const moveHandler = (e) => {
    const rect = container.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const relX = Math.max(0, Math.min(1, x / rect.width));
    const time = relX * duration;

    // Format time
    const minutes = Math.floor(time / 60);
    const seconds = Math.floor(time % 60);
    label.textContent = `${minutes}:${seconds.toString().padStart(2, '0')}`;

    // Position elements
    line.style.left = `${x}px`;
    line.style.opacity = '1';

    // Position label (flip to left side if near right edge)
    const labelWidth = label.offsetWidth;
    if (x + labelWidth + 5 > rect.width) {
      label.style.left = `${x - labelWidth - 2}px`;
    } else {
      label.style.left = `${x + 2}px`;
    }
    label.style.opacity = '1';
  };

  // Mouse leave handler
  const leaveHandler = () => {
    line.style.opacity = '0';
    label.style.opacity = '0';
  };

  container.addEventListener('mousemove', moveHandler);
  container.addEventListener('mouseleave', leaveHandler);

  // Store references for cleanup
  hoverListeners = { move: moveHandler, leave: leaveHandler };
}

function audioBufferToBlob(buffer) {
  const numChannels = buffer.numberOfChannels;
  const sampleRate = buffer.sampleRate;
  const length = buffer.length;
  const bytesPerSample = 2; // 16-bit
  const blockAlign = numChannels * bytesPerSample;
  const dataSize = length * blockAlign;

  const arrayBuffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(arrayBuffer);

  // WAV header
  const writeString = (offset, str) => {
    for (let i = 0; i < str.length; i++) {
      view.setUint8(offset + i, str.charCodeAt(i));
    }
  };

  writeString(0, 'RIFF');
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, 'WAVE');
  writeString(12, 'fmt ');
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, numChannels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  // Interleave channels
  const channels = [];
  for (let i = 0; i < numChannels; i++) {
    channels.push(buffer.getChannelData(i));
  }

  let offset = 44;
  for (let i = 0; i < length; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channels[ch][i]));
      view.setInt16(offset, sample < 0 ? sample * 0x8000 : sample * 0x7FFF, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

function updateWaveSurferProgress(time) {
  if (!wavesurfer || !audioNodes.buffer) return;
  const progress = time / audioNodes.buffer.duration;
  wavesurfer.seekTo(Math.min(1, Math.max(0, progress)));
}

// ============================================================================
// EQ Presets
// ============================================================================

const eqPresets = {
  flat: { low: 0, lowMid: 0, mid: 0, highMid: 0, high: 0 },
  vocal: { low: -2, lowMid: -1, mid: 2, highMid: 3, high: 1 },
  bass: { low: 6, lowMid: 3, mid: 0, highMid: -1, high: -2 },
  bright: { low: -1, lowMid: 0, mid: 1, highMid: 3, high: 5 },
  warm: { low: 3, lowMid: 2, mid: 0, highMid: -2, high: -3 },
  aifix: { low: 1, lowMid: -2, mid: 1, highMid: -1, high: 2 }
};

document.querySelectorAll('.preset-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const preset = eqPresets[btn.dataset.preset];
    if (preset) {
      // Update eqValues state
      eqValues.low = preset.low;
      eqValues.lowMid = preset.lowMid;
      eqValues.mid = preset.mid;
      eqValues.highMid = preset.highMid;
      eqValues.high = preset.high;

      // Update fader displays
      if (faders.eqLow) faders.eqLow.setValue(preset.low);
      if (faders.eqLowMid) faders.eqLowMid.setValue(preset.lowMid);
      if (faders.eqMid) faders.eqMid.setValue(preset.mid);
      if (faders.eqHighMid) faders.eqHighMid.setValue(preset.highMid);
      if (faders.eqHigh) faders.eqHigh.setValue(preset.high);

      updateEQ();

      document.querySelectorAll('.preset-btn').forEach(b => b.classList.remove('active'));
      btn.classList.add('active');
    }
  });
});

// EQ fader event listeners are set up in initFaders()

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
  loadingModal.classList.remove('hidden');
  loadingText.textContent = text;
  loadingProgressBar.style.width = `${percent}%`;
  loadingPercent.textContent = `${percent}%`;
  modalCancelBtn.classList.toggle('hidden', !showCancel);
}

function hideLoadingModal() {
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
    fileState.originalBuffer = decodedBuffer;

    // Show measuring phase with intermediate progress updates
    showLoadingModal('Measuring loudness...', 35);

    // Small delay to allow UI to update before CPU-intensive LUFS measurement
    await new Promise(resolve => setTimeout(resolve, 10));

    showLoadingModal('Analyzing audio levels...', 50);

    // Normalize to target LUFS using pure JavaScript
    const normalizedBuffer = normalizeToLUFS(decodedBuffer, targetLufsDb);

    showLoadingModal('Applying normalization...', 70);

    // Small delay for UI feedback
    await new Promise(resolve => setTimeout(resolve, 10));

    showLoadingModal('Preparing audio...', 85);

    // Store as the main buffer (normalized)
    audioNodes.buffer = normalizedBuffer;
    fileState.normalizedBuffer = normalizedBuffer;

    showLoadingModal('Ready!', 100);

    createAudioChain();

    // Update duration display
    const duration = audioNodes.buffer.duration;
    durationEl.textContent = formatTime(duration);
    seekBar.max = duration;

    // Initialize waveform display with original file blob
    initWaveSurfer(audioNodes.buffer, originalBlob);

    playBtn.disabled = false;
    stopBtn.disabled = false;
    processBtn.disabled = false;

    // Show live indicators
    document.body.classList.add('audio-loaded');

    // Hide modal after brief delay
    setTimeout(() => hideLoadingModal(), 300);

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
  if (!audioNodes.buffer || !audioNodes.context) return;

  if (audioNodes.context.state === 'suspended') {
    audioNodes.context.resume();
  }

  stopAudio();

  audioNodes.source = audioNodes.context.createBufferSource();
  audioNodes.source.buffer = audioNodes.buffer;

  connectAudioChain(audioNodes.source);

  audioNodes.source.onended = () => {
    if (playerState.isPlaying) {
      playerState.isPlaying = false;
      updatePlayPauseIcon(false);
      clearInterval(playerState.seekUpdateInterval);
      stopMeter();
    }
  };

  const offset = playerState.pauseTime;
  playerState.startTime = audioNodes.context.currentTime - offset;
  audioNodes.source.start(0, offset);
  playerState.isPlaying = true;
  updatePlayPauseIcon(true);
  startMeter();

  clearInterval(playerState.seekUpdateInterval);
  playerState.seekUpdateInterval = setInterval(() => {
    if (playerState.isPlaying && audioNodes.buffer && !playerState.isSeeking) {
      const currentTime = audioNodes.context.currentTime - playerState.startTime;
      if (currentTime >= audioNodes.buffer.duration) {
        stopAudio();
        playerState.pauseTime = 0;
        seekBar.value = 0;
        currentTimeEl.textContent = '0:00';
      } else {
        seekBar.value = currentTime;
        currentTimeEl.textContent = formatTime(currentTime);
        updateWaveSurferProgress(currentTime);
      }
    }
  }, 100);
}

function pauseAudio() {
  if (!playerState.isPlaying) return;

  playerState.pauseTime = audioNodes.context.currentTime - playerState.startTime;
  stopAudio();
  stopMeter();
}

function stopAudio() {
  if (audioNodes.source) {
    try {
      audioNodes.source.stop();
      audioNodes.source.disconnect();
    } catch (e) {}
    audioNodes.source = null;
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
      } catch (e) {}
    }
    clearInterval(playerState.seekUpdateInterval);

    audioNodes.source = audioNodes.context.createBufferSource();
    audioNodes.source.buffer = audioNodes.buffer;
    connectAudioChain(audioNodes.source);

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
      if (playerState.isPlaying && audioNodes.buffer && !playerState.isSeeking) {
        const currentTime = audioNodes.context.currentTime - playerState.startTime;
        if (currentTime >= audioNodes.buffer.duration) {
          stopAudio();
          playerState.pauseTime = 0;
          seekBar.value = 0;
          currentTimeEl.textContent = '0:00';
        } else {
          seekBar.value = currentTime;
          currentTimeEl.textContent = formatTime(currentTime);
          updateWaveSurferProgress(currentTime);
        }
      }
    }, 100);
  } else {
    currentTimeEl.textContent = formatTime(time);
    updateWaveSurferProgress(time);
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

function formatTime(seconds) {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

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
      const sampleRateKHz = Math.round(audioNodes.buffer.sampleRate / 1000);
      const duration = formatTime(audioNodes.buffer.duration);

      fileName.textContent = name;
      fileMeta.textContent = `${ext} • ${sampleRateKHz}kHz • ${duration}`;

      fileZoneContent.classList.add('hidden');
      fileLoaded.classList.remove('hidden');

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
  updateAudioChain();
  updateEQ();
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
    truePeakLimit: truePeakLimit.checked,
    truePeakCeiling: ceilingValueDb,
    cleanLowEnd: cleanLowEnd.checked,
    glueCompression: glueCompression.checked,
    stereoWidth: parsedStereoWidth,
    centerBass: centerBass.checked,
    cutMud: cutMud.checked,
    addAir: addAir.checked,
    tameHarsh: tameHarsh.checked,
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
    if (!audioNodes.buffer) {
      throw new Error('Audio buffer was unloaded during processing');
    }

    // Use Web Audio offline render (same processing chain as preview)
    showLoadingModal('Rendering audio...', 5, true);

    const outputData = await renderOffline(audioNodes.buffer, settings, updateProgress);

    if (processingCancelled) {
      throw new Error('Cancelled');
    }

    // Download file via browser
    showLoadingModal('Preparing download...', 95, true);

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
  miniLufs.classList.toggle('active', normalizeLoudness.checked);
  miniPeak.classList.toggle('active', truePeakLimit.checked);
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

[truePeakLimit, cleanLowEnd, glueCompression, centerBass, cutMud, addAir, tameHarsh].forEach(el => {
  el.addEventListener('change', () => {
    updateAudioChain();
    updateChecklist();
  });
});

// truePeakSlider event listener removed - now using ceiling fader

stereoWidthSlider.addEventListener('input', () => {
  stereoWidthValue.textContent = `${stereoWidthSlider.value}%`;
  updateStereoWidth();
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

    // Update buffers
    fileState.normalizedBuffer = normalizedBuffer;
    audioNodes.buffer = normalizedBuffer;

    // Allow UI to update
    await new Promise(resolve => setTimeout(resolve, 20));

    showLoadingModal('Ready!', 100);

    // Brief delay to show completion
    await new Promise(resolve => setTimeout(resolve, 150));

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
    updateWaveSurferProgress(playerState.pauseTime);
  }
}

targetLufsSlider.addEventListener('input', () => {
  const newValue = parseInt(targetLufsSlider.value);

  // Update display immediately
  targetLufsDb = newValue;
  targetLufsValue.textContent = `${newValue} LUFS`;
  if (miniLufsValue) {
    miniLufsValue.textContent = `${newValue} LUFS`;
  }

  // Debounce the re-normalization (wait for user to stop sliding)
  if (lufsDebounceTimeout) {
    clearTimeout(lufsDebounceTimeout);
  }

  lufsDebounceTimeout = setTimeout(() => {
    renormalizeAudio(newValue);
  }, 300); // 300ms debounce
});

// Output format presets
const outputPresets = {
  streaming: { sampleRate: 44100, bitDepth: 16 },
  studio: { sampleRate: 48000, bitDepth: 24 }
};

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
  if (wavesurfer) {
    try {
      wavesurfer.destroy();
    } catch (e) { /* ignore */ }
    wavesurfer = null;
  }

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

  // Revoke blob URL
  if (currentBlobUrl) {
    URL.revokeObjectURL(currentBlobUrl);
    currentBlobUrl = null;
  }
});

// ============================================================================
// Initialize
// ============================================================================

initFaders();
updateChecklist();
