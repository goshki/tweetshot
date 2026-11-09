# tweetshot

Command-line tool that captures an X/Twitter post as a picture or a video.

| Post contains | Output |
|---|---|
| text and/or a single image | `<tweet-id>.png` (2x element screenshot) |
| a single video / GIF | `<tweet-id>.mp4`, video plays start to end |
| a gallery (2-4 media) | `<tweet-id>.mp4`, scrolls through the items: each image is held 2.5 s, each video plays fully, then it scrolls on |

The capture is the tweet itself: author, text, media and the stats bar (replies, reposts, likes, views). The UI is forced to English. Videos have **no audio** (`-an`).

## How it works

1. Launches the installed **Google Chrome** through Playwright in a fresh temporary browser context, injects the session cookies from `auth.json` and opens `<tweet-url>?lang=en`.
2. Cleans the page: refuses the cookie banner, hides the bottom bar, sheet dialogs and cookie banner, removes the logged-out "See all the replies / Continue to X" bar, and reverts auto-translation where requested.
3. **Pass 1** (2x pixel ratio) detects the media type and measures the tweet. Image posts are screenshotted here.
4. **Pass 2** (video only) opens the post again in a viewport tall enough to show the whole tweet and records it with Playwright's `recordVideo`. `ffmpeg` then crops it to the tweet and trims it to the media duration.

Why it works this way:

- X does not mount its video player in headless Chrome, so only `img[src*="video_thumb"]` thumbnails exist. The script fetches the MP4 URLs from the public syndication endpoint (`cdn.syndication.twimg.com/tweet-result`) and overlays a plain `<video>` on each thumbnail (`injectVideos`).
- Playwright's bundled Chromium has no H.264, so installed Google Chrome is required (`channel: 'chrome'`).
- X blocks the login form in automated browsers ("this browser is not safe"), so login uses cookies copied from your normal browser.

## Prerequisites

- macOS with zsh (the paths and `zshrc` snippet assume this; the script itself is plain Node and should work on Linux with changes to the Chrome channel if needed).
- **Google Chrome** installed in `/Applications`.
- **Node.js 18+** (uses global `fetch` and ES modules). Check with `node -v`.
- **ffmpeg** on `PATH` (`brew install ffmpeg`), used for crop/trim/encode.
- An **X account** (a secondary account is recommended, see Security). Without login the stats bar is faded or hidden and X may refuse to show the post.

## Installation

The repository must live in `~/.tweetshot` (the `zshrc` wrapper and the script use that path):

```zsh
git clone <repository-url> ~/.tweetshot
cd ~/.tweetshot
npm ci                            # installs the exact Playwright version from package-lock.json
npx playwright install ffmpeg     # Playwright's own ffmpeg, needed by recordVideo (separate from the system one)
```

Then create `auth.json` (see Configuration) and optionally `config.json`.

Add the wrapper to `~/.zshrc`, then run `source ~/.zshrc`:

```zsh
# Usage: tweetshot [--extract] [--size=X|XxY|--width=X|--height=Y] [--border=PX] [--border-color=#RRGGBB] [--no-translation] <tweet-url> [outdir]   (needs node, ffmpeg, Google Chrome)
tweetshot() {
  [[ $# -eq 0 ]] && { echo "usage: tweetshot [--extract] [--size=X|XxY|--width=X|--height=Y] [--border=PX] [--border-color=#RRGGBB] [--no-translation] <tweet-url> [outdir]"; return 1; }
  node "$HOME/.tweetshot/tweetshot.mjs" "$@"
}

# Usage: tweetext [--size=X|XxY|--width=X|--height=Y] <tweet-url> [outdir]   (extracts the tweet's media files only)
tweetext() { tweetshot --extract "$@"; }
```

### Folder contents

| Path | Purpose |
|---|---|
| `tweetshot.mjs` | The whole tool (single file). |
| `auth.json` | Your X session cookies (**secret**). |
| `config.json` | Optional settings, see Configuration. |
| `package.json`, `package-lock.json`, `node_modules/` | Playwright dependency. |

## Configuration

### 1. Login: `auth.json`

The script needs two cookies of a logged-in x.com session.

1. Log in to https://x.com in your normal Chrome.
2. Open DevTools: `Cmd+Opt+I` > **Application** > **Cookies** > `https://x.com`.
3. Copy the **Value** of `auth_token` and `ct0`.
4. Create `~/.tweetshot/auth.json`:

   ```json
   {
     "auth_token": "PASTE_AUTH_TOKEN_VALUE",
     "ct0": "PASTE_CT0_VALUE"
   }
   ```

5. Restrict it: `chmod 600 ~/.tweetshot/auth.json`.

The script adds these cookies (plus `lang=en`) to the browser context on every run.

**Security:** `auth_token` gives full access to the account. Never commit, paste or share it. Prefer a dedicated secondary account. Logging out of x.com in the browser that issued the cookies invalidates them.

### 2. Translation: `config.json` (optional)

```json
{
  "noTranslate": ["pl"],
  "borderWidth": 16,
  "borderColor": "#FFFFFF"
}
```

All keys are optional. `borderWidth` and `borderColor` are the defaults for `--border` and `--border-color`.

`noTranslate` is a list of ISO language codes. X auto-translates posts into English; for posts in a listed language the script clicks "Show original". Codes are mapped to English names with `Intl.DisplayNames` (`pl` becomes "Polish") and matched against X's "Translated from Polish" label. If `config.json` is absent, no language is excluded.

### Environment variables

| Variable | Effect |
|---|---|
| `TWEETSHOT_HEADED=1` | Show the Chrome window (debugging). |

### Constants in `tweetshot.mjs`

| Constant | Default | Meaning |
|---|---|---|
| `W` | `640` | Viewport width in px. |
| `IMAGE_HOLD_MS` | `2500` | How long each gallery image is shown. |
| `HIDE` | CSS selector list | Elements hidden before capture (`BottomBar`, `sheetDialog`, `cookieBanner`). |
| `UA` | Chrome 141 on macOS | User agent. Update it occasionally. |
| smooth-scroll wait | `900` ms | Pause after each gallery scroll. |
| video timeout | 15 min | Safety cap in `playToEnd`. |

## Usage

```
tweetshot [--extract] [--size=X|XxY|--width=X|--height=Y] [--border=PX] [--border-color=#RRGGBB] [--no-translation] <tweet-url> [outdir]
tweetext  [--size=X|XxY|--width=X|--height=Y] <tweet-url> [outdir]     # = tweetshot --extract
```

| Argument | Default | Description |
|---|---|---|
| `<tweet-url>` | required | Any URL containing `/status/<id>` (`x.com` or `twitter.com`). The query string is dropped. |
| `[outdir]` | `~/Downloads` | Output folder, created if missing. |
| `--extract` | off | Skip the screenshot/recording and save the tweet's original media instead (see below). |
| `--size=X` | off | Rescale to fit inside a square X by X px (same as `--size=XxX`). |
| `--size=XxY` | off | Rescale output so it fits inside X by Y px (envelope). `--size=Xx` fixes the width, `--size=xY` fixes the height; the other side follows the aspect ratio. |
| `--width=X`, `--height=Y` | off | Aliases for `--size=Xx` and `--size=xY`. Used together they behave like `--size=XxY`. |
| `--border=PX` | `16` | Padding around the tweet capture, in CSS px (screenshots are 2x, so 16 gives 32 image px). `0` disables it. Ignored with `--extract`. |
| `--border-color=#RRGGBB` | `#FFFFFF` | Padding color, 6-digit hex (the `#` is optional). Quote it if your shell treats `#` specially. |
| `--no-translation` | off | Always revert X's auto-translation, whatever the language. |

Examples:

```zsh
tweetshot https://x.com/RetroMemoriesHQ/status/2119618225524842684
tweetshot --no-translation https://x.com/domjachas/status/2119552562072555771 ~/Pictures
TWEETSHOT_HEADED=1 tweetshot https://x.com/luusssso/status/2119591990866399524
```

**`--extract`** downloads every media item of the main tweet (not the quoted tweet) via the syndication endpoint. No browser or login is used. Images are saved in original size (`?name=orig`), videos/GIFs as the highest-bitrate MP4 (with audio; HLS via ffmpeg if no MP4 exists). Files are named `<tweet-id>-<n>.<ext>`. It fails with "no media found" for text-only or unavailable tweets.

**Border:** added right after capture and before rescaling, so `--size`/`--width`/`--height` apply to the final image including the padding. Defaults can be set in `config.json` (`borderWidth`, `borderColor`); flags override them.

**Rescaling** (`--size`, `--width`, `--height`) is applied after generation. With `--extract` each media file is rescaled with its own aspect ratio; without it the finished PNG/MP4 of the tweet is rescaled. Output is never upscaled: media smaller than the requested size keep their size. With both dimensions the result is the largest size that fits the box. Videos are re-encoded (libx264, audio copied); dimensions are rounded to even numbers, and values must be positive integers.

Output files are named `<tweet-id>.png` or `<tweet-id>.mp4` and overwrite existing ones. Video durations: single video = video length + ~0.6 s; gallery = sum of items (2.5 s per image, full length per video) + ~0.9 s per scroll + ~0.6 s.

Every run uses its own temporary browser, so several `tweetshot` commands can run in parallel (be gentle: X may rate-limit).

## Examples

Output of `tweetshot <tweet-url>` with default settings (files in [`docs/`](docs/)).

| Tweet type | Tweet | Output |
|---|---|---|
| Static image | https://x.com/sydmeadofficial/status/2031042354514366753 | ![Static image](docs/2031042354514366753.png) |
| GIF | https://x.com/LyonsMatthew/status/1371844186438258690 | [`1371844186438258690.mp4`](docs/1371844186438258690.mp4) |
| Video | https://x.com/Y2KKAIN/status/2031525661261574629 | [`2031525661261574629.mp4`](docs/2031525661261574629.mp4) |
| Image gallery | https://x.com/luusssso/status/2119591990866399524 | [`2119591990866399524.mp4`](docs/2119591990866399524.mp4) |
| Mixed image/video gallery | https://x.com/goshki/status/2005386147674157298 | [`2005386147674157298.mp4`](docs/2005386147674157298.mp4) |

## Code map (`tweetshot.mjs`)

| Function | Role |
|---|---|
| `launchRaw` / `launch` | Throwaway Chrome context (closing it closes the browser); `launch` injects `auth_token`, `ct0`, `lang=en` cookies. |
| `videoSources` | Fetches syndication JSON, returns `{mediaId: best mp4 URL}` for the main and quoted tweet. |
| `syndication` | Fetches the syndication JSON for the tweet id (shared by `--extract` and `videoSources`). |
| `extractMedia` | `--extract`: downloads photos/videos from `mediaDetails`. |
| `rescale` / `scaleFilter` | `--size`/`--width`/`--height`: in-place ffmpeg scale. |
| `injectVideos` | Overlays a `<video>` on each `img[src*="video_thumb"]`, climbing to the outermost same-size wrapper. |
| `untranslate` | Clicks "Show original" buttons per `--no-translation` / `noTranslate`. |
| `prepare` | Navigate, wait for `article`, dismiss cookies, pick the tweet article, untranslate, hide overlays, wait for images. |
| `galleryInfo` | Finds the gallery row and returns the kind (`image`/`video`) of each item; tags the row with `data-ts-gallery`. |
| `playToEnd` | Plays a video muted, resolves with start/end timestamps on `ended`. |
| main `try` block | Pass 1 (detect, screenshot) and pass 2 (record, ffmpeg crop/trim). |

The video is trimmed using wall-clock timestamps against the recording start, so alignment is approximate (about 0.2 s).

## Troubleshooting

| Symptom | Likely cause and fix |
|---|---|
| `Tweet not found ...` and `tweetshot-debug.png` in the output folder | Open the PNG. A login wall or "not safe" page means expired or missing cookies (below). A rate-limit or error page means retry later. A normal page means the selectors changed. |
| `⚠ Not logged in` warning, faded or missing stats bar | `auth.json` is missing, malformed or expired. Re-extract the cookies. |
| Login page appears with the right `auth.json` | Cookies expired, you logged out in the source browser, or X flagged the session. Log in again in normal Chrome and copy fresh values. |
| `net::ERR_HTTP_RESPONSE_CODE_FAILURE` | X rejects the request. Update `UA`, avoid `/i/status/` URLs, retry. |
| macOS prompts that Terminal wants to update or delete other apps | Deny it. Nothing needs it. |
| Keychain prompt | Should not occur (mock keychain flags are used). If it does, deny it. |
| Language is not English | Check the `lang=en` cookie and `?lang=en` in `prepare`; also set English in your X account settings. |
| Post was translated | Add its language to `noTranslate` or pass `--no-translation`. Quoted tweets cannot be reverted (X offers no button). |
| Video post produced a PNG | The syndication endpoint returned no `video_info` (post deleted, age-restricted or endpoint changed), or the thumbnail selector changed. Check `videoSources()` output. |
| Recording is blank or an empty gallery video | `ffmpeg` not found, or Playwright's ffmpeg is missing: run `npx playwright install ffmpeg`. |
| Gallery recorded as a plain PNG or the first item only | `galleryInfo` did not find the scroll row. See below. |
| Playwright says browser/Chrome not found | Install Google Chrome, or update Playwright (`npm i playwright@latest`). |

### If X changes its HTML

X uses obfuscated class names, so the script relies on `data-testid` values, roles and structure. Hotspots to check first:

- `article` and `a[href*="/status/<id>"]` (tweet selection in `prepare`).
- `button` with text "Show original" and the "Translated from <Lang>" text (`untranslate`).
- `img[src*="video_thumb"]` and the `video_thumb/<id>` URL pattern (`injectVideos`, `videoSources`).
- Media ids in MP4 URLs matching `(amplify_video|ext_tw_video)/<id>/` (`videoSources`). Other paths, such as GIFs under `tweet_video`, are not matched.
- Gallery detection: a `div` with `overflow-x: auto|scroll`, `scrollWidth > clientWidth` and 2+ children (`galleryInfo`).
- The logged-out bottom bar: a fixed `aside` containing "Continue to X" / "See all the replies" (`prepare`).
- The `HIDE` selectors (`BottomBar`, `sheetDialog`, `cookieBanner`).
- The "Refuse non-essential cookies" button name (`prepare`).
- The syndication endpoint and its token formula (`videoSources`).

To debug, run with `TWEETSHOT_HEADED=1`, or write a throwaway Playwright script that opens the page with the same launch options and prints the DOM chain from the element in question (`getComputedStyle`, `childElementCount`).

### Updating dependencies

```zsh
cd ~/.tweetshot && npm i playwright@latest && npx playwright install ffmpeg
```

## Known limitations and ideas

- No audio in recorded video output (extracted media keep audio). Idea: download the MP4 (as `--extract` does) and mux with `ffmpeg -map 0:v -map 1:a -c copy -shortest`.
- Quoted-tweet translation cannot be reverted.
- Gallery handling was verified only on an all-image gallery. Video and mixed galleries rely on the same thumbnail injection as single videos but are untested.
- GIFs (`tweet_video`) and multiple videos outside a gallery are untested.
- Trim alignment is approximate (about 0.2 s).
- Relies on an undocumented syndication endpoint and X's current DOM, which can change without notice. Use for personal archiving and respect X's terms and the content owner's rights.
