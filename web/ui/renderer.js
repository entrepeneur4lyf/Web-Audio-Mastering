/**
 * Renderer Module
 * Offline audio rendering for export and cache
 */

import {
  measureLUFS,
  normalizeToLUFS,
  applyExciter,
  applyTapeWarmth,
  processHybridDynamic,
  applyMasteringSoftClip,
  applyLookaheadLimiter,
  applyFinalFilters
} from '../lib/dsp/index.js';
import { applyMultibandTransient } from '../lib/dsp/multiband-transient.js';
import { encodeWAVAsync, createOfflineNodes } from './encoder.js';

// ============================================================================
// Shared DSP Chain
// ============================================================================

/**
 * Create offline rendering context with connected audio nodes
 * @param {AudioBuffer} sourceBuffer - Source audio buffer
 * @param {Object} settings - Processing settings
 * @param {number} targetSampleRate - Output sample rate
 * @returns {Object} { offlineCtx, source, nodes }
 */
function createRenderContext(sourceBuffer, settings, targetSampleRate) {
  const duration = sourceBuffer.duration;
  const numSamples = Math.ceil(duration * targetSampleRate);

  const offlineCtx = new OfflineAudioContext(2, numSamples, targetSampleRate);
  const source = offlineCtx.createBufferSource();
  source.buffer = sourceBuffer;

  const nodes = createOfflineNodes(offlineCtx, settings);

  // Connect audio chain: source → inputGain → filters → compressor → stereo → limiter → destination
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

  return { offlineCtx, source, nodes };
}

/**
 * Apply DSP processing chain to a buffer
 * Chain: Deharsh → Exciter → Saturation → Transient → LPF → LUFS → Normalize → Soft Clip → Limit
 * @param {AudioBuffer} buffer - Input buffer
 * @param {Object} settings - Processing settings
 * @param {Function} onProgress - Optional progress callback (receives 0-1 values)
 * @param {string} logPrefix - Log prefix for debugging
 * @returns {{ buffer: AudioBuffer, measuredLufs: number }} Processed buffer and pre-normalize LUFS
 */
function applyDSPChain(buffer, settings, onProgress = null, logPrefix = '[DSP]') {
  let renderedBuffer = buffer;

  // 1. Deharsh / Hybrid Dynamic Processor (if enabled)
  if (settings.deharsh) {
    console.log(`${logPrefix} Applying hybrid dynamic processor...`);
    renderedBuffer = processHybridDynamic(renderedBuffer, 'mastering', (p) => {
      if (onProgress) onProgress(p * 0.15);
    });
  }
  if (onProgress) onProgress(0.15);

  // 2. Exciter / Add Air (if enabled)
  if (settings.addAir) {
    console.log(`${logPrefix} Applying exciter...`);
    renderedBuffer = applyExciter(renderedBuffer, (p) => {
      if (onProgress) onProgress(0.15 + p * 0.15);
    });
  }
  if (onProgress) onProgress(0.30);

  // 3. Multiband Saturation / Tape Warmth (if enabled)
  if (settings.tapeWarmth) {
    console.log(`${logPrefix} Applying multiband saturation...`);
    renderedBuffer = applyTapeWarmth(renderedBuffer, (p) => {
      if (onProgress) onProgress(0.30 + p * 0.15);
    });
  }
  if (onProgress) onProgress(0.45);

  // 4. Multiband Transient / Add Punch (if enabled)
  if (settings.addPunch) {
    console.log(`${logPrefix} Applying multiband transient...`);
    renderedBuffer = applyMultibandTransient(renderedBuffer, (p) => {
      if (onProgress) onProgress(0.45 + p * 0.15);
    });
  }
  if (onProgress) onProgress(0.60);

  // 5. Apply final High Cut (18kHz LPF 6dB/oct)
  // Note: HPF (Clean Low End) is already handled by the WebAudio highpass node in the offline render graph.
  console.log(`${logPrefix} Applying final LPF...`);
  renderedBuffer = applyFinalFilters(renderedBuffer, {
    highpass: false,
    lowpass: true
  });
  if (onProgress) onProgress(0.65);

  // 6. Measure LUFS (after all processing, before normalization)
  const measuredLufs = measureLUFS(renderedBuffer);
  console.log(`${logPrefix} Measured LUFS:`, measuredLufs.toFixed(1));

  // 7. Normalize to target LUFS (if enabled)
  if (settings.normalizeLoudness && settings.targetLufs) {
    console.log(`${logPrefix} Normalizing to target LUFS:`, settings.targetLufs);
    // Apply gain only; final peak control happens in the clipper/limiter stages below.
    renderedBuffer = normalizeToLUFS(renderedBuffer, settings.targetLufs, 0, { skipLimiter: true });
  }
  if (onProgress) onProgress(0.75);

  // 8. Soft Clipper (reduces peak-to-loudness ratio before limiting)
  if (settings.truePeakLimit) {
    const ceiling = settings.truePeakCeiling || -1;
    console.log(`${logPrefix} Applying mastering soft clip (ceiling:`, ceiling, 'dB)...');
    renderedBuffer = applyMasteringSoftClip(renderedBuffer, {
      ceiling: ceiling,
      lookaheadMs: 0.5,
      releaseMs: 10,
      drive: 1.5
    }, (p) => {
      if (onProgress) onProgress(0.75 + p * 0.15);
    });
  }
  if (onProgress) onProgress(0.90);

  // 9. True Peak Limiting - final safety clip (if enabled)
  if (settings.truePeakLimit) {
    const ceiling = settings.truePeakCeiling || -1;
    const ceilingLinear = Math.pow(10, ceiling / 20);
    console.log(`${logPrefix} Applying true peak limiter (ceiling:`, ceiling, 'dB)...');
    renderedBuffer = applyLookaheadLimiter(renderedBuffer, ceilingLinear);
  }
  if (onProgress) onProgress(1.0);

  return { buffer: renderedBuffer, measuredLufs };
}

/**
 * Resample an AudioBuffer to a target sample rate.
 * Uses OfflineAudioContext so output sample data and WAV header stay aligned.
 * @param {AudioBuffer} sourceBuffer - Source audio buffer
 * @param {number} targetSampleRate - Target sample rate in Hz
 * @returns {Promise<AudioBuffer>} Resampled buffer (or original if unchanged)
 */
export async function resampleAudioBuffer(sourceBuffer, targetSampleRate) {
  if (!sourceBuffer || !targetSampleRate || sourceBuffer.sampleRate === targetSampleRate) {
    return sourceBuffer;
  }

  const numChannels = sourceBuffer.numberOfChannels;
  const numSamples = Math.ceil(sourceBuffer.duration * targetSampleRate);
  const offlineCtx = new OfflineAudioContext(numChannels, numSamples, targetSampleRate);
  const source = offlineCtx.createBufferSource();

  source.buffer = sourceBuffer;
  source.connect(offlineCtx.destination);
  source.start(0);

  return offlineCtx.startRendering();
}

// ============================================================================
// Offline Rendering (Export)
// ============================================================================

/**
 * Render audio buffer through effects chain using OfflineAudioContext
 * @param {AudioBuffer} sourceBuffer - Source audio buffer
 * @param {Object} settings - Processing settings
 * @param {Function} onProgress - Progress callback (0-100)
 * @returns {Promise<Uint8Array>} WAV file data
 */
export async function renderOffline(sourceBuffer, settings, onProgress) {
  const targetSampleRate = settings.sampleRate || 44100;

  console.log('[Offline Render] Starting...', {
    duration: sourceBuffer.duration,
    targetSampleRate,
    numSamples: Math.ceil(sourceBuffer.duration * targetSampleRate)
  });

  // Create offline context and connect nodes
  const { offlineCtx, source } = createRenderContext(sourceBuffer, settings, targetSampleRate);
  source.start(0);
  if (onProgress) onProgress(10);

  // Render through Web Audio nodes
  let renderPhaseTimer = null;
  if (onProgress) {
    let fakeProgress = 10;
    renderPhaseTimer = setInterval(() => {
      fakeProgress = Math.min(14, fakeProgress + 1);
      onProgress(fakeProgress);
      if (fakeProgress >= 14 && renderPhaseTimer) {
        clearInterval(renderPhaseTimer);
        renderPhaseTimer = null;
      }
    }, 1000);
  }

  let renderedBuffer;
  try {
    renderedBuffer = await offlineCtx.startRendering();
  } finally {
    if (renderPhaseTimer) clearInterval(renderPhaseTimer);
  }
  if (onProgress) onProgress(15);
  // Allow the UI to repaint before the synchronous DSP stages begin.
  await new Promise(resolve => setTimeout(resolve, 0));

  // Apply DSP chain with progress mapping (15-75%)
  const dspResult = applyDSPChain(renderedBuffer, settings, (p) => {
    if (onProgress) onProgress(15 + p * 60);
  }, '[Offline Render]');
  renderedBuffer = dspResult.buffer;

  if (onProgress) onProgress(75);
  // Allow the UI to repaint before WAV encoding begins.
  await new Promise(resolve => setTimeout(resolve, 0));

  // Encode to WAV
  const wavData = await encodeWAVAsync(renderedBuffer, targetSampleRate, settings.bitDepth || 16, {
    onProgress: (p) => {
      if (onProgress) onProgress(75 + p * 15);
    }
  });
  if (onProgress) onProgress(90);

  console.log('[Offline Render] Complete!', { outputSize: wavData.byteLength });
  return wavData;
}

// ============================================================================
// Cache Rendering (Preview)
// ============================================================================

/**
 * Render to AudioBuffer (for cache/preview)
 * Preview mode returns a "heavy FX only" buffer for the hybrid live chain.
 * Export/full mode returns a fully rendered buffer (same as renderOffline, but as AudioBuffer).
 * @param {AudioBuffer} sourceBuffer - Source audio buffer
 * @param {Object} settings - Processing settings
 * @param {string} mode - 'preview' (heavy FX only) or 'export' (full chain)
 * @returns {Promise<{buffer: AudioBuffer, lufs: number}>}
 */
export async function renderToAudioBuffer(sourceBuffer, settings, mode = 'preview') {
  if (mode === 'preview') {
    // Hybrid pipeline cache: heavy FX only (Deharsh, Exciter, Warmth, Punch)
    console.log('[Cache Render] Starting (Preview)...', {
      duration: sourceBuffer.duration,
      sampleRate: sourceBuffer.sampleRate
    });

    // Clone to avoid mutating the original buffer
    let renderedBuffer = new AudioBuffer({
      numberOfChannels: sourceBuffer.numberOfChannels,
      length: sourceBuffer.length,
      sampleRate: sourceBuffer.sampleRate
    });
    for (let ch = 0; ch < sourceBuffer.numberOfChannels; ch++) {
      renderedBuffer.copyToChannel(sourceBuffer.getChannelData(ch), ch);
    }

    if (settings.deharsh) {
      renderedBuffer = processHybridDynamic(renderedBuffer, 'mastering', null);
    }
    if (settings.addAir) {
      renderedBuffer = applyExciter(renderedBuffer, null);
    }
    if (settings.tapeWarmth) {
      renderedBuffer = applyTapeWarmth(renderedBuffer, null);
    }
    if (settings.addPunch) {
      renderedBuffer = applyMultibandTransient(renderedBuffer, null);
    }

    const lufs = measureLUFS(renderedBuffer);
    console.log('[Cache Render] Preview LUFS:', lufs.toFixed(1));
    return { buffer: renderedBuffer, lufs };
  }

  // Full chain cache (export parity)
  const targetSampleRate = sourceBuffer.sampleRate;

  console.log('[Cache Render] Starting (Full)...', {
    duration: sourceBuffer.duration,
    targetSampleRate,
    numSamples: Math.ceil(sourceBuffer.duration * targetSampleRate)
  });

  const { offlineCtx, source } = createRenderContext(sourceBuffer, settings, targetSampleRate);
  source.start(0);

  let renderedBuffer = await offlineCtx.startRendering();

  const dspResult = applyDSPChain(renderedBuffer, settings, null, '[Cache Render]');
  renderedBuffer = dspResult.buffer;

  const finalLufs = measureLUFS(renderedBuffer);
  console.log('[Cache Render] Final LUFS:', finalLufs.toFixed(1));

  return { buffer: renderedBuffer, lufs: finalLufs };
}
