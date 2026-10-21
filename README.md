# Telegram Image-to-PDF Bot

A Telegram bot (Node.js, ES modules) that turns an uploaded image into a PDF file that is **never larger than 2 MiB (2,097,152 bytes)**.

## Features

- Accepts JPEG, PNG and WebP images (sent as a photo or as a file); validated with Sharp, not by file extension
- Asks for a PDF name, sanitizes it and appends `.pdf`
- Preserves aspect ratio and EXIF orientation; transparent images get a white background
- Iterative compression (quality, then resolution) with the real PDF size verified after every attempt
- "Create another?" inline buttons
- Independent per-user sessions with a state machine, duplicate-click protection and 15-minute expiry
- Temporary files are deleted on success, cancel, expiry and failure

## Requirements

- Node.js 18 or newer
- A bot token from [@BotFather](https://t.me/BotFather)

## Installation

```bash
cd telegram-image-pdf-bot
npm install
cp .env.example .env      # then edit .env
```

Set your token in `.env`:

```
BOT_TOKEN=123456789:your-token-here
```

## Run

```bash
npm start        # production
npm run dev      # restart on file changes
```

## Usage

| Command   | Description                                   |
|-----------|-----------------------------------------------|
| `/start`  | Start the workflow and explain the steps      |
| `/help`   | Show brief usage instructions                 |
| `/cancel` | Cancel the current operation, delete temp data |

Flow: send an image → enter a PDF name → receive the PDF → choose **✅ Yes, Create Another** or **❌ No, Finish**.

## Conversation states

`WAITING_FOR_IMAGE` → `WAITING_FOR_FILENAME` → `PROCESSING_PDF` → `ASKING_TO_CONTINUE` → back to `WAITING_FOR_IMAGE` (Yes) or session removed (No).

## Compression strategy

Starting at quality 85 and a 3000 px longest side, each attempt builds the full PDF and checks its byte size. If it is over 2 MiB, quality drops by 10 down to a minimum of 40; then the image is scaled to 80% (quality reset to 75). It stops after 16 attempts or when the side would drop below 400 px, in which case the user is told the image could not be compressed enough and no PDF is sent.

## Limits

- Input file: 20 MB (Telegram's bot download limit)
- Input resolution: 50 megapixels
- Filename: 100 characters (before `.pdf`)
- Session inactivity timeout: 15 minutes

## Project structure

```
src/
  bot.js                      bot setup and routing
  handlers/commands.js        /start, /help, /cancel
  handlers/image.js           uploads, filename, PDF creation, buttons
  services/imageProcessor.js  download, validation, JPEG compression
  services/pdfGenerator.js    PDF creation and size enforcement
  sessions/sessionManager.js  per-user state and expiry
  utils/cleanup.js            temp file cleanup
```

## Security notes

- The token lives only in `.env` (git-ignored) and is redacted from logged errors.
- The bot only responds in private chats, so sessions never mix between users.
