# Noat Boat - Features Added Since Feb 5 2026

## Wacom Tablet Support (Feb 5 2026)
- Switched drawing input from mouse events to pointer events, enabling full Wacom tablet and stylus support
- Works in both the canvas workspace and the focused drawing modal

## Undo/Redo & Search Highlighting (May 10 2026)
- Added undo and redo support for text editing with toolbar buttons
- Search results are now highlighted in the note list, making it easy to spot matching notes

## Drag & Drop Note Organization (Jun 13 2026)
- Drag notes from the sidebar and drop them onto folders to move them
- All attachments (images, audio, canvas drawings) move with the note automatically
- Drag a note onto the back button to move it to the parent folder
- Visual feedback with dashed border highlight on valid drop targets
- Collision detection prevents overwriting files in the destination folder

## Splash Screen (Jul 1 2026)
- When no note is selected, the app shows the Noat Boat logo and a grid of 6 random note images
- Clicking any image opens that note
- Images refresh with new random selections each time the splash screen appears
- Falls back to a text prompt when no illustrated notes are available

## Draw Random Button & Progress Bar (Jul 3 2026)
- "Draw Random" button on the splash screen opens a random note that doesn't have a drawing yet, encouraging users to illustrate their notes
- Green progress bar below the button shows what percentage of notes have been illustrated (e.g. "12 / 30 notes illustrated (40%)")
- Shows "All notes already have drawings!" when every note is illustrated

## Drawing Colors & Pen Sizes (Jul 8 2026)
- Adjustable pen/brush size with + and - buttons and a live size preview dot
- 9 pen sizes ranging from fine (0.5) to thick (20)
- Color palette with 9 colors: Black, Green, Pink, Cyan, Red, Orange, Blue, Yellow, Purple
- Current color shown as a swatch next to the palette
- Drawing tools available in both the canvas workspace toolbar and the focused drawing modal
- Pen size and color preferences are saved and persist across notes and app restarts
