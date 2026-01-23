# Web Audio Mastering

A desktop app for mastering AI-generated music (Suno, Udio, etc.) or any other audio to streaming-ready quality.

**[Try it in your browser](https://entrepeneur4lyf.github.io/Web-Audio-Mastering/)** - No installation required!

**Source:** https://github.com/entrepeneur4lyf/Web-Audio-Mastering

Brought to you by *stonedoubt* ![stonedoubt studio](web/logo-icon.png) *studio*

![Web Audio Mastering](screenshot.png)

## Features

### Playback & Analysis
- **FX A/B (On/Off)** - Instant before/after comparison, with optional **Level Match** for fair loudness comparisons
- **Waveform + Scrub** - Click-to-seek waveform and scrubber for fast navigation
- **Spectrogram (Live)** - Real-time frequency heatmap (great for spotting harsh bands, resonances, and sub build-up while you tweak)
- **Full-chain Metering** - Real-time stereo peak metering (FX ON reflects the mastering chain, including the final limiter ceiling)
- **DC Offset Detection** - Detects and removes DC offset on load (badge shown when cleanup was applied)

### Loudness & Dynamics
- **Input Gain** - Adjust input level before processing (-12dB to +12dB)
- **Loudness Normalization** - Automatically adjusts to Spotify's -14 LUFS standard
- **Soft Clipper (Pre-Limiter)** - Adds punch and headroom when pushing loud masters (common mastering trick)
- **True Peak Limiting** - Prevents clipping with adjustable ceiling (-3dB to 0dB)
- **Glue Compression** - Light compression to glue the mix together and add punch
- **De-harsh** - Hybrid dynamics + dynamic EQ to tame harshness and resonances in AI audio

### EQ & Tonal
- **5-Band Parametric EQ** - Fine-tune frequencies (80Hz, 250Hz, 1kHz, 4kHz, 12kHz)
- **EQ Presets** - Flat, Vocal Boost, Bass Boost, Bright, Warm, AI Fix
- **Cut Mud** - Reduce muddy frequencies around 250Hz
- **Add Air** - Sparkle and brightness with 12kHz high shelf boost

### Low End
- **Clean Low End** - Removes sub-bass rumble below 30Hz

### Stereo
- **Stereo Width** - Adjustable stereo image (0% mono to 200% extra wide) with real-time preview
- **Mono Bass** - Narrows bass below ~200Hz for better club/speaker mono compatibility

### Output
- **Output Presets** - Quick-switch sample rate/bit depth (48kHz/24-bit recommended)
- **High-Quality WAV Export** - Lossless output with all processing applied (master preview matches export)

See [DSP-SIGNAL-CHAIN.md](DSP-SIGNAL-CHAIN.md) for more details on the DSP signal chain.

## Download

Get the latest release for your platform:

- **Windows** - `.exe` portable
- **macOS** - `.dmg` disk image
- **Linux** - `.AppImage`

## Usage

1. Drag & drop an audio file (MP3, WAV, FLAC, AAC, M4A)
2. Preview with the built-in player
3. Adjust EQ and mastering settings
4. Toggle FX bypass to compare before/after
5. Click "Export Mastered WAV"

## Building from Source

```bash
# Install dependencies
npm install

# Run in development
npm start

# Build web output (for GitHub Pages / static hosting)
npm run build:web

# Preview the production build locally
npm run preview

# Build for your platform
npm run build:win    # Windows
npm run build:mac    # macOS (requires Mac)
npm run build:linux  # Linux
```
## Tech Stack

- Electron 39
- Vite 7 (build system)
- Web Audio API (preview and export processing)
- Pure JavaScript LUFS measurement (ITU-R BS.1770-4)
- WaveSurfer.js (waveform visualization)

## License

ISC

---

## Acknowledgements

This project is based on [Suno-Song-Remaster](https://github.com/SUP3RMASS1VE/Suno-Song-Remaster) by SUP3RMASS1VE, licensed under the ISC License.

```
ISC License

Copyright (c) SUP3RMASS1VE

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.
```
