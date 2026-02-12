import { describe, expect, it } from 'vitest';
import { encodeWAV, encodeWAVAsync } from './encoder.js';

function createAudioBuffer(channels, sampleRate = 48000) {
  return {
    numberOfChannels: channels.length,
    sampleRate,
    getChannelData(channelIndex) {
      return channels[channelIndex];
    }
  };
}

function readWavHeader(wavBytes) {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  return {
    sampleRate: view.getUint32(24, true),
    bitDepth: view.getUint16(34, true),
    dataSize: view.getUint32(40, true)
  };
}

function readPcm16(wavBytes) {
  const view = new DataView(wavBytes.buffer, wavBytes.byteOffset, wavBytes.byteLength);
  const sampleCount = (wavBytes.byteLength - 44) / 2;
  const out = new Int16Array(sampleCount);
  let offset = 44;
  for (let i = 0; i < sampleCount; i++) {
    out[i] = view.getInt16(offset, true);
    offset += 2;
  }
  return out;
}

describe('WAV encoder', () => {
  it('writes target sample rate and bit depth in WAV header', async () => {
    const audio = createAudioBuffer([new Float32Array([0, 0.25, -0.25, 0.5])], 48000);
    const wav = await encodeWAVAsync(audio, 44100, 16, { ditherMode: 'none' });
    const header = readWavHeader(wav);

    expect(header.sampleRate).toBe(44100);
    expect(header.bitDepth).toBe(16);
    expect(header.dataSize).toBe(8);
  });

  it('honors shouldCancel for async encoding', async () => {
    const audio = createAudioBuffer([new Float32Array(32768)], 48000);

    await expect(
      encodeWAVAsync(audio, 48000, 16, {
        shouldCancel: () => true
      })
    ).rejects.toThrow('Cancelled');
  });

  it('is deterministic when 16-bit ditherMode is none', () => {
    const source = new Float32Array(512);
    source.fill(0.00123);
    const audio = createAudioBuffer([source], 48000);

    const a = encodeWAV(audio, 48000, 16, { ditherMode: 'none' });
    const b = encodeWAV(audio, 48000, 16, { ditherMode: 'none' });

    expect(a).toEqual(b);
  });

  it('produces different 16-bit PCM than none mode when TPDF dither is enabled', () => {
    const source = new Float32Array(4096);
    source.fill(0.00001);
    const audio = createAudioBuffer([source], 48000);

    const none = encodeWAV(audio, 48000, 16, { ditherMode: 'none' });
    const tpdf = encodeWAV(audio, 48000, 16, { ditherMode: 'tpdf' });

    const nonePcm = readPcm16(none);
    const tpdfPcm = readPcm16(tpdf);
    const hasDifference = nonePcm.some((sample, idx) => sample !== tpdfPcm[idx]);

    expect(hasDifference).toBe(true);
  });

  it('ignores dither mode for 24-bit output', () => {
    const source = new Float32Array(1024);
    source.fill(0.03125);
    const audio = createAudioBuffer([source], 48000);

    const a = encodeWAV(audio, 48000, 24, { ditherMode: 'none' });
    const b = encodeWAV(audio, 48000, 24, { ditherMode: 'noise-shaped' });

    expect(a).toEqual(b);
  });
});
