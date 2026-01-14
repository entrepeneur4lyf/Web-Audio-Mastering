# Suno Song Remaster
<img width="1046" height="797" alt="Screenshot 2026-01-14 003206" src="https://github.com/user-attachments/assets/3e06bc4a-9bda-4340-9497-22b894678ddd" />

A desktop app for mastering AI-generated music (Suno, Udio, etc.) to streaming-ready quality.

<p>
  <img src="image.png" alt="Suno Song Remaster" width="300">
  <img src="https://github.com/user-attachments/assets/63394da1-5215-4f32-bab5-60587e8b7003" alt="Screenshot" width="500">
</p>

## Features

- **Loudness Normalization** - Automatically adjusts to Spotify's -14 LUFS standard
- **True Peak Limiting** - Prevents clipping with adjustable ceiling
- **5-Band EQ** - Fine-tune your sound with presets (Flat, Vocal Boost, Bass Boost, Bright, Warm, Suno Fix)
- **Quick Fix Tools** - Glue compression, clean low end, center bass
- **Polish Effects** - Cut mud, add air, tame harshness
- **Real-time Preview** - Hear changes before exporting
- **High-Quality Export** - WAV output at 44.1/48kHz, 16/24-bit

## Download

Get the latest release for your platform:

- **Windows** - `.exe` installer
- **macOS** - `.dmg` disk image
- **Linux** - `.AppImage`

[Download from Releases](https://github.com/SUP3RMASS1VE/Suno-Song-Remaster/releases)

## Usage

1. Drag & drop an audio file (MP3, WAV, FLAC, AAC)
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

# Build for your platform
npm run build:win    # Windows
npm run build:mac    # macOS (requires Mac)
npm run build:linux  # Linux
```

## Tech Stack

- Electron
- FFmpeg (via fluent-ffmpeg)
- Web Audio API for real-time preview

## License

ISC
