# What is Yt Downloader?

Yt Downloader turns a YouTube link into a downloadable video or audio file. Paste a link, pick a format and quality, then download the result. No login or extra app needed for the web version.

Built by **XyncTeam**, with a web interface, an interactive terminal menu, and HTTP endpoints for your own projects.

**[Open the website →](https://xync-ytdownloader.vercel.app)** · [Bahasa Indonesia](README.md)

Want to see what it looks like? Open the website directly. No screenshots here to go out of date.

## Features

- Audio: **MP3, M4A, OPUS**.
- Video: **MP4**, with requested resolutions up to **2160p / 4K**.
- Preview the title, channel, and thumbnail before converting.
- Follow processing status in the browser.
- Light and dark themes, with a mobile-friendly layout.
- Use the terminal menu for local downloads and server controls.

Quality options are requests, not guarantees. Availability depends on the source and conversion service; choosing 4K cannot restore detail missing from the original video.

## Using the website

1. Open [Yt Downloader](https://xync-ytdownloader.vercel.app).
2. Paste a YouTube link and click **Download** to load its details.
3. Choose a format and quality.
4. Start conversion and wait for the file link.
5. Click **Download File**.

Regular video links, Shorts, and `youtu.be` links are supported. If a request fails, check the link and connection before retrying repeatedly.

## Running locally

Install **Node.js 22 or newer** and Git:

```sh
git clone https://github.com/PertaDex27/xync-ytdownloader.git
cd xync-ytdownloader
npm run startServerLocal
```

Open **http://localhost:3000**. No additional npm packages are required.

For the interactive terminal menu:

```sh
npm run menu
```

The menu lets you fetch video details, convert media, save files, and start or stop the local server. Terminal downloads are saved in the current working directory.

The default port is `3000`; set the `PORT` environment variable to change it.

## HTTP API

Replace the base address if your server runs elsewhere.

**Fetch video details:**

```sh
curl "http://localhost:3000/api/info?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ"
```

**Request an MP3 link:**

```sh
curl "http://localhost:3000/api/download?id=dQw4w9WgXcQ&format=mp3&quality=128"
```

Successful responses contain `status: "ok"` and the result data. The download endpoint returns a file URL in `url`, not the file contents. Failed requests include a `message` field.

| Parameter | Purpose |
|---|---|
| `url` / `id` | YouTube URL or video ID |
| `format` | `mp3`, `mp4`, `m4a`, or `opus`; defaults to `mp3` |
| `quality` | Requested quality, such as `128` for MP3 or `720` for MP4 |
| `stream=1` | Download endpoint only: receive status updates through Server-Sent Events |

## Things to know

This project relies on third-party services. Requests may take time, hit rate limits, or fail when those services change.

- Wait before retrying a rate-limited request.
- Try a lower quality if a large video takes too long.
- Private, region-restricted, or certain other videos may be unavailable.
- Large files need enough storage and memory, especially on phones.
- Download links may expire; request a new one if necessary.

Only download content you own, have permission to download, or that is licensed for this use. A downloadable file is not permission to redistribute it. Respect creators' rights and the services' terms.

## License

[Apache License 2.0](LICENSE).
