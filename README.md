![alt text](https://noatboatwebring.netlify.app/nbicon.png "Noat Boat Main Image")

A minimalistic note taking application for creative humans that use computers

## Features

- Free- no account or subscription required
- Works offline (only needs to be online once to make image canvas work)
- Doesn't manage syncing notes (use Dropbox/SyncThing/OneDrive/Google Drive/whatever to manage it yourself

### Rich Media Attachments
- **Image attachments** - Attach images to any note (PNG, JPG, GIF, WebP) via drag/drop from a browser or whatever
- **Audio attachments** - Attach and play audio files with built-in player (supports MP3, WAV, and more with automatic transcoding)
- **Built-in drawing pad** - Create hand-drawn sketches and diagrams with Fabric.js canvas

### Export Options
- **PDF Document** - Export all notes in a folder as a single PDF
- **PNG Images** - Export all notes as individual PNG images
- **EPUB3 Book** - Create an e-book from your notes
- **HTML Website** - Export individual notes as standalone web pages

### Publishing & Sharing
- **GitHub Pages publishing** - Publish notes directly to your GitHub repository
- ** For your "ahoy" page on your published site just publish a note titled "ahoy" (without the "")
  
- **Cryptocurrency tipping** - Add Bitcoin and Ethereum tip addresses to published notes
- **Custom publishing name** - Brand your published notes with your name

### AI-Powered Text Correction
- **Smart text correction** - Fix spelling, grammar, and typos using AI
- **Two correction modes:**
  - **Manual mode** - Select text and click fix to correct only the highlighted portion
  - **Auto mode** - Automatically corrects newly typed text (tracks dirty regions for efficiency)
- **Multiple providers:**
  - **OpenAI** - Uses GPT-4o-mini for fast, accurate corrections
  - **Local LLM** - Use your own GGUF model files for offline correction
- **Preserves formatting** - Respects line breaks, paragraphs, and document structure

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Arrow Up/Down` | Navigate note list |
| `Spacebar` | Toggle Select/Draw mode (on canvas) |
| `Delete/Backspace` | Delete selected canvas objects |
| `Escape` | Close modals/lightbox |

## Development

### Prerequisites
- Node.js 18+ installed
- npm or yarn

### Setup
```bash
cd noatboat-electron
npm install
```

### Run in Development
```bash
npm start
```

### Build Executables

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
5. Navigate subfolders with the folder navigation buttons
6. Attach images (🖼️), audio (🔊), or create drawings (✏️)
7. Export or publish your notes using the export button (📤)

## File Structure

```
your-notes-folder/
├── note-title.txt           # Note content
├── note-title.png           # Image attachment (or .jpg, .jpeg, .gif, .webp)
├── note-title.canvas.json   # Canvas/drawing data
├── note-title.canvas.png    # Canvas preview image
├── note-title.audio.mp3     # Audio attachment
└── subfolder/               # Nested folders supported
    └── another-note.txt
```

## Configuration

### Preferences
Access preferences via `Cmd/Ctrl + ,` or the app menu:

- **Theme** - Light or Dark mode
- **Focus Mode Strength** - Adjust how much the UI dims in focus mode
- **Text Correction** - Off, Auto, or Manual mode
- **Auto-Fix Provider** - OpenAI or Local LLM
- **OpenAI API Key** - For cloud-based text correction
- **Local Model Path** - Path to your GGUF model file
- **GitHub Token** - For publishing to GitHub Pages
- **GitHub Repository** - Target repo for publishing (format: `username/repo`)
- **Publishing Name** - Your name for published notes
- **Tip Addresses** - Bitcoin and Ethereum addresses for tips

### Config Location
The app stores its configuration in:
- **Windows:** `%APPDATA%/noatboat/config.json`
- **Mac:** `~/Library/Application Support/noatboat/config.json`
- **Linux:** `~/.config/noatboat/config.json`

## Tech Stack

- **Electron** - Cross-platform desktop framework
- **Fabric.js** - Canvas drawing and manipulation
- **FFmpeg** - Audio transcoding (bundled)
- **node-llama-cpp** - Local LLM inference (optional)
- **OpenAI API** - Cloud text correction (optional)

## License

GPLv3

