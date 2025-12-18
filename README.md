# Noat Boat - Electron App

A Notational Velocity clone built with Electron for Windows, Mac, and Linux.

## Features

- Fast note searching and creation
- Auto-saves notes as plain text (.txt) files
- Image attachments for notes
- Built-in drawing pad
- **Auto-loads last folder** - The app remembers your notes folder and loads it automatically on startup

## Development

### Prerequisites

- Node.js 18+ installed
- npm or yarn

### Setup

```bash
cd noatboat-electron
npm install
```

### Run in development

```bash
npm start
```

### Build executables

**Windows:**
```bash
npm run build-win
```

**Mac:**
```bash
npm run build-mac
```

**Linux:**
```bash
npm run build-linux
```

**All platforms:**
```bash
npm run build-all
```

Built executables will be in the `dist/` folder.

## How It Works

1. Click the folder icon (📁) to select a folder for your notes
2. The folder path is saved automatically - next time you launch, it loads automatically
3. Create new notes with the new note button (📄)
4. Notes are saved as `.txt` files in your selected folder
5. Images are saved alongside notes with the same base filename
6. Use the draw button (✏️) to create/edit drawings
7. Use the image button (🖼️) to attach images

## File Structure

- Notes: `<title>.txt`
- Images: `<title>.png` (or `.jpg`, `.jpeg`, `.gif`, `.webp`)

## Config Location

The app stores its configuration (including the saved folder path) in:

- **Windows:** `%APPDATA%/noatboat/config.json`
- **Mac:** `~/Library/Application Support/noatboat/config.json`
- **Linux:** `~/.config/noatboat/config.json`
