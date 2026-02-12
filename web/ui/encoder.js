/**
 * Audio Encoder Module
 * WAV encoding and offline audio node creation
 */

import { applyFinalFilters } from '../lib/dsp/final-filters.js';

// ============================================================================
// WAV Encoding
// ============================================================================

function triangularDither() {
  // TPDF in integer (LSB) domain: [-1, 1]
  return (Math.random() + Math.random()) - 1;
}

/**
 * Encode an AudioBuffer to WAV format (supports 16-bit and 24-bit)
 * @param {AudioBuffer} audioBuffer - Source audio buffer
 * @param {number} targetSampleRate - Target sample rate
 * @param {number} bitDepth - Bit depth (16 or 24)
 * @returns {Uint8Array} WAV file data
 */
export function encodeWAV(audioBuffer, targetSampleRate, bitDepth) {
  const numChannels = audioBuffer.numberOfChannels;
  const safeBitDepth = bitDepth === 24 ? 24 : 16;
  const sampleRate = targetSampleRate || audioBuffer.sampleRate;
  const bytesPerSample = safeBitDepth / 8;

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
  view.setUint16(34, safeBitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  let offset = 44;
  const maxVal = safeBitDepth === 16 ? 32767 : 8388607;

  for (let i = 0; i < numSamples; i++) {
    for (let ch = 0; ch < numChannels; ch++) {
      const sample = Math.max(-1, Math.min(1, channelData[ch][i]));
      const scaled = sample * maxVal;
      // Dither is only needed for 16-bit export where quantization noise is audible.
      const intSample = safeBitDepth === 16
        ? Math.round(scaled + triangularDither())
        : Math.round(scaled);

      if (safeBitDepth === 16) {
        const clampedSample = Math.max(-32768, Math.min(32767, intSample));
        view.setInt16(offset, clampedSample, true);
        offset += 2;
      } else if (safeBitDepth === 24) {
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
 * Async WAV encoder with progress + yielding so the UI can repaint.
 * @param {AudioBuffer} audioBuffer - Source audio buffer
 * @param {number} targetSampleRate - Target sample rate (header value)
 * @param {number} bitDepth - Bit depth (16 or 24)
 * @param {Object} options
 * @param {(progress: number) => void} [options.onProgress] - Progress callback (0..1)
 * @param {() => boolean} [options.shouldCancel] - Return true to abort encoding
 * @param {number} [options.chunkSize] - Samples per chunk before yielding
 * @returns {Promise<Uint8Array>}
 */
export async function encodeWAVAsync(audioBuffer, targetSampleRate, bitDepth, options = {}) {
  const {
    onProgress = null,
    shouldCancel = null,
    chunkSize = 65536
  } = options || {};

  const safeBitDepth = bitDepth === 24 ? 24 : 16;
  const numChannels = audioBuffer.numberOfChannels;
  const sampleRate = targetSampleRate || audioBuffer.sampleRate;
  const bytesPerSample = safeBitDepth / 8;

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
  view.setUint16(34, safeBitDepth, true);
  writeString(36, 'data');
  view.setUint32(40, dataSize, true);

  const maxVal = safeBitDepth === 16 ? 32767 : 8388607;
  let offset = 44;
  const safeChunkSize = Math.max(1024, Number(chunkSize) || 65536);

  const yieldToUI = () => new Promise(resolve => setTimeout(resolve, 0));

  for (let i = 0; i < numSamples; i += safeChunkSize) {
    if (shouldCancel && shouldCancel()) {
      throw new Error('Cancelled');
    }

    const end = Math.min(i + safeChunkSize, numSamples);

    for (let s = i; s < end; s++) {
      for (let ch = 0; ch < numChannels; ch++) {
        const sample = Math.max(-1, Math.min(1, channelData[ch][s]));
        const scaled = sample * maxVal;
        // Dither is only needed for 16-bit export where quantization noise is audible.
        const intSample = safeBitDepth === 16
          ? Math.round(scaled + triangularDither())
          : Math.round(scaled);

        if (safeBitDepth === 16) {
          const clampedSample = Math.max(-32768, Math.min(32767, intSample));
          view.setInt16(offset, clampedSample, true);
          offset += 2;
        } else {
          const clampedSample = Math.max(-8388607, Math.min(8388607, intSample));
          view.setUint8(offset, clampedSample & 0xFF);
          view.setUint8(offset + 1, (clampedSample >> 8) & 0xFF);
          view.setUint8(offset + 2, (clampedSample >> 16) & 0xFF);
          offset += 3;
        }
      }
    }

    if (onProgress) onProgress(end / numSamples);
    if (end < numSamples) {
      await yieldToUI();
    }
  }

  if (onProgress) onProgress(1);
  return new Uint8Array(buffer);
}

/**
 * Convert AudioBuffer to WAV Blob (16-bit)
 * @param {AudioBuffer} buffer - Source audio buffer
 * @returns {Blob} WAV blob
 */
export function audioBufferToBlob(buffer) {
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
      // Use symmetric scaling (same as encodeWAV) for consistency
      const intSample = Math.round(sample * 32767);
      view.setInt16(offset, intSample, true);
      offset += 2;
    }
  }

  return new Blob([arrayBuffer], { type: 'audio/wav' });
}

// ============================================================================
// Offline Audio Nodes
// ============================================================================

/**
 * Create audio processing nodes for offline context (same as preview chain)
 * @param {OfflineAudioContext} offlineCtx - Offline audio context
 * @param {Object} settings - Processing settings
 * @returns {Object} Audio nodes
 */
export function createOfflineNodes(offlineCtx, settings) {
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
  nodes.highshelf.gain.value = 0; // Exciter applied separately when addAir enabled

  nodes.midPeak.type = 'peaking';
  nodes.midPeak.frequency.value = 5000;
  nodes.midPeak.Q.value = 2;
  nodes.midPeak.gain.value = 0; // Harshness taming handled by deharsh dynamic processor

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

// Final filters now imported from dsp/final-filters.js
