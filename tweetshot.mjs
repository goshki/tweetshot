import { chromium } from 'playwright';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';

const args = process.argv.slice(2);
const noTranslation = args.includes('--no-translation');
const extract = args.includes('--extract');
// --size=XxY (envelope), --size=Xx (width only), --size=xY (height only); --width=X / --height=Y are aliases
const val = name => args.find(a => a.startsWith(`--${name}=`))?.slice(name.length + 3);
let sizeW = 0, sizeH = 0;
const sizeErrors = [];
const size = val('size');
if (size !== undefined) {
  const m = size.match(/^(?:(\d+)|(\d*)x(\d*))$/i);
  if (!m || Number(m[1] ?? 0) + Number(m[2] || 0) + Number(m[3] || 0) === 0) sizeErrors.push(`Invalid --size: ${size} (expected X, XxY, Xx or xY)`);
  else if (m[1]) sizeW = sizeH = Number(m[1]);
  else { sizeW = Number(m[2] || 0); sizeH = Number(m[3] || 0); }
}
for (const [name, set] of [['width', v => { sizeW = v; }], ['height', v => { sizeH = v; }]]) {
  const v = val(name);
  if (v === undefined) continue;
  if (/^\d+$/.test(v) && Number(v) > 0) set(Number(v)); else sizeErrors.push(`Invalid --${name}: ${v}`);
}
const rescaleOn = sizeW > 0 || sizeH > 0;
const [url, outdirArg = path.join(os.homedir(), 'Downloads')] = args.filter(a => !a.startsWith('--'));
const id = url?.match(/status\/(\d+)/)?.[1];
const usage = 'usage: tweetshot [--extract] [--size=X|XxY|--width=X|--height=Y] [--border=PX] [--border-color=#RRGGBB] [--no-translation] <tweet-url> [outdir]';
if (!id) { console.error(usage); process.exit(1); }
if (sizeErrors.length) { console.error(`${sizeErrors.join('\n')}\n${usage}`); process.exit(1); }

// ~/.tweetshot/config.json: { "noTranslate": ["pl"] } = language codes whose tweets are never left translated
const cfgFile = path.join(os.homedir(), '.tweetshot', 'config.json');
const cfg = fs.existsSync(cfgFile) ? JSON.parse(fs.readFileSync(cfgFile, 'utf8')) : {};

// Padding around the tweet capture (not applied to --extract). config.json: { "borderWidth": 16, "borderColor": "#FFFFFF" }; flags override
const borderRaw = val('border') ?? cfg.borderWidth ?? 16;
const borderColorRaw = val('border-color') ?? cfg.borderColor ?? '#FFFFFF';
const borderCss = Number(borderRaw);
if (!Number.isInteger(borderCss) || borderCss < 0 || !/^#?[0-9a-f]{6}$/i.test(borderColorRaw)) {
  console.error(`Invalid border: width "${borderRaw}" (non-negative integer expected), color "${borderColorRaw}" (#RRGGBB expected)\n${usage}`);
  process.exit(1);
}
const borderColor = '0x' + borderColorRaw.replace('#', '');

const keepOriginal = (cfg.noTranslate || []).map(c => new Intl.DisplayNames(['en'], { type: 'language' }).of(c));

const outdir = path.resolve(outdirArg);
fs.mkdirSync(outdir, { recursive: true });
const W = 640;
const cleanUrl = url.split('?')[0] + '?lang=en';
const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
const HIDE = '[data-testid="BottomBar"],[data-testid="sheetDialog"],[data-testid="cookieBanner"]{display:none!important}';

// Fresh, throwaway browser context per call; session comes from auth.json. Closing the context closes the browser.
const launchRaw = async ({ deviceScaleFactor, viewport = { width: W, height: 1000 }, recordVideo } = {}) => {
  const browser = await chromium.launch({
    channel: 'chrome',
    headless: !process.env.TWEETSHOT_HEADED,
    args: ['--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation', '--use-mock-keychain', '--password-store=basic'],
  });
  const ctx = await browser.newContext({
    viewport, deviceScaleFactor, recordVideo, colorScheme: 'light', locale: 'en-US', userAgent: UA,
  });
  const closeCtx = ctx.close.bind(ctx);
  ctx.close = async () => { await closeCtx(); await browser.close(); };
  return ctx;
};

const authFile = path.join(os.homedir(), '.tweetshot', 'auth.json');
const launch = async (o = {}) => {
  const ctx = await launchRaw(o);
  if (fs.existsSync(authFile)) {
    const a = JSON.parse(fs.readFileSync(authFile, 'utf8'));
    await ctx.addCookies([
      ...['auth_token', 'ct0'].filter(n => a[n]).map(name => ({
        name, value: a[name], domain: '.x.com', path: '/', secure: true, httpOnly: name === 'auth_token', sameSite: 'None',
      })),
      { name: 'lang', value: 'en', domain: '.x.com', path: '/', secure: true, sameSite: 'None' },
    ]);
  }
  return ctx;
};

const syndication = async () => {
  const token = ((Number(id) / 1e15) * Math.PI).toString(36).replace(/(0+|\.)/g, '');
  const res = await fetch(`https://cdn.syndication.twimg.com/tweet-result?id=${id}&token=${token}&lang=en`);
  if (!res.ok) throw new Error(`syndication returned HTTP ${res.status}`);
  const j = await res.json();
  // video carousels are "unified cards": their media sits in a JSON string inside the card
  if (!j.mediaDetails?.length) {
    try {
      const u = JSON.parse(j.card?.binding_values?.unified_card?.string_value);
      const ids = Object.values(u.component_objects).flatMap(c => c.data?.media_list?.map(m => m.id) || []);
      const ents = ids.length ? ids.map(i => u.media_entities[i]) : Object.values(u.media_entities);
      j.mediaDetails = ents.filter(Boolean);
    } catch {}
  }
  return j;
};

const ff = a => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...a], { stdio: 'inherit' });
const evenPx = n => Math.ceil(n / 2) * 2;

// ffmpeg scale filter: never upscales; both sides = fit inside the box, one side = match it; aspect ratio kept, even dimensions
const scaleFilter = () => sizeW && sizeH
  ? `scale=w='min(${sizeW},iw)':h='min(${sizeH},ih)':force_original_aspect_ratio=decrease:force_divisible_by=2`
  : sizeW ? `scale='trunc(min(${sizeW},iw)/2)*2':-2` : `scale=-2:'trunc(min(${sizeH},ih)/2)*2'`;

// Pad an image in place; `scale` converts CSS px to image px (2 for the 2x screenshot)
function addBorder(file, scale) {
  const b = Math.round(borderCss * scale);
  if (!b) return;
  const ext = path.extname(file);
  const tmp = file.slice(0, -ext.length) + '.padding' + ext;
  ff(['-i', file, '-vf', `pad=iw+${2 * b}:ih+${2 * b}:${b}:${b}:color=${borderColor}`, tmp]);
  fs.renameSync(tmp, file);
}

// Rescale an image/video in place according to --size/--width/--height
function rescale(file) {
  const ext = path.extname(file);
  const tmp = file.slice(0, -ext.length) + '.scaling' + ext;
  const codec = ext === '.mp4' ? ['-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-c:a', 'copy']
    : ext === '.png' ? [] : ['-q:v', '2'];
  ff(['-i', file, '-vf', scaleFilter(), ...codec, tmp]);
  fs.renameSync(tmp, file);
}

// --extract: download the original media of the main tweet (no browser, no login needed)
async function extractMedia() {
  const j = await syndication();
  const media = j.mediaDetails || [];
  if (!media.length) throw new Error('no media found in this tweet');
  let n = 0;
  for (const m of media) {
    n++;
    const base = path.join(outdir, `${id}-${n}`);
    let file;
    if (m.type === 'photo') {
      const ext = path.extname(new URL(m.media_url_https).pathname) || '.jpg';
      file = base + ext;
      const res = await fetch(`${m.media_url_https}?name=orig`);
      if (!res.ok) throw new Error(`image download failed: HTTP ${res.status}`);
      fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
    } else {
      const vs = m.video_info?.variants || [];
      const mp4 = vs.filter(v => v.content_type === 'video/mp4').sort((a, b) => b.bitrate - a.bitrate)[0];
      const hls = vs.find(v => v.content_type === 'application/x-mpegURL');
      file = base + '.mp4';
      if (mp4) {
        const res = await fetch(mp4.url);
        if (!res.ok) throw new Error(`video download failed: HTTP ${res.status}`);
        fs.writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      } else if (hls) ff(['-i', hls.url, '-c', 'copy', '-bsf:a', 'aac_adtstoasc', file]);
      else throw new Error(`no downloadable variant for media ${n}`);
    }
    if (rescaleOn) rescale(file);
    console.log('✔ Saved', file);
  }
}

// Best mp4 per media id, from X's public syndication endpoint (main tweet and quoted tweet)
async function videoSources() {
  try {
    const j = await syndication();
    const map = {};
    const walk = o => {
      if (!o || typeof o !== 'object') return;
      for (const [k, v] of Object.entries(o)) {
        if (k === 'video_info') {
          const best = v.variants.filter(x => x.content_type === 'video/mp4').sort((a, b) => b.bitrate - a.bitrate)[0];
          const mid = best?.url.match(/(?:amplify_video|ext_tw_video)\/(\d+)\/|tweet_video\/([\w-]+)\.mp4/)?.slice(1).find(Boolean);
          if (mid) map[mid] = best.url;
        } else walk(v);
      }
    };
    walk(j);
    return map;
  } catch { return {}; }
}

// X doesn't mount its player in headless Chrome, so overlay a plain <video> on each video thumbnail
function injectVideos(art, map) {
  return art.evaluate((el, map) => {
    let n = 0;
    for (const img of el.querySelectorAll('img[src*="video_thumb"]')) {
      const src = map[img.src.match(/video_thumb\/([\w-]+)/)?.[1]];
      // climb to the outermost wrapper with the same size as the thumbnail so X's play/duration overlays sit below the video
      const ir = img.getBoundingClientRect();
      let host = img.parentElement;
      for (let i = 0; i < 8 && host.parentElement; i++) {
        const r = host.parentElement.getBoundingClientRect();
        if (Math.abs(r.width - ir.width) > 2 || Math.abs(r.height - ir.height) > 2) break;
        host = host.parentElement;
      }
      if (!src) continue;
      if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
      const v = document.createElement('video');
      Object.assign(v, { src, muted: true, playsInline: true, preload: 'auto' });
      Object.assign(v.style, {
        position: 'absolute', left: 0, top: 0, width: '100%', height: '100%',
        objectFit: 'cover', zIndex: 10, background: '#000', borderRadius: 'inherit',
      });
      host.appendChild(v);
      n++;
    }
    return n;
  }, map);
}

function untranslate(art) {
  return art.evaluate((el, { all, keep }) => {
    const leaves = [...el.querySelectorAll('button')].filter(e => e.textContent.trim() === 'Show original');
    for (const b of leaves) {
      let n = b, lang = null;
      for (let i = 0; i < 3 && n && !lang; i++, n = n.parentElement) lang = n.innerText?.match(/Translated from ([^\n]+)/)?.[1]?.trim();
      if (all || keep.includes(lang)) b.click();
    }
  }, { all: noTranslation, keep: keepOriginal });
}

async function prepare(page) {
  await page.goto(cleanUrl, { waitUntil: 'domcontentloaded' });
  const tweets = page.locator('article');
  try {
    await tweets.first().waitFor({ timeout: 30000 });
  } catch (e) {
    const dbg = path.join(outdir, 'tweetshot-debug.png');
    await page.screenshot({ path: dbg }).catch(() => {});
    console.error(`Tweet not found. Page: "${await page.title()}" ${page.url()}\nDebug screenshot: ${dbg}`);
    throw e;
  }
  await page.getByRole('button', { name: /refuse non-essential cookies/i }).click({ timeout: 3000 }).catch(() => {});
  if (await page.locator('a[href="/login"]').count()) {
    console.warn('⚠ Not logged in: the stats bar will be faded/hidden. Refresh the cookies in auth.json.');
  }
  const withId = tweets.filter({ has: page.locator(`a[href*="/status/${id}"]`) });
  const art = (await withId.count()) ? withId.first() : tweets.first();
  if (noTranslation || keepOriginal.length) await art.getByText('Show original').first().waitFor({ timeout: 4000 }).catch(() => {});
  await untranslate(art);
  await page.waitForTimeout(500);
  await page.addStyleTag({ content: HIDE });
  // Logged-out "See all the replies / Continue to X" bar: fixed to the viewport bottom, appears late
  await page.evaluate(() => {
    const kill = () => document.querySelectorAll('aside').forEach(e => {
      if (getComputedStyle(e).position === 'fixed' && /Continue to X|See all the replies/.test(e.innerText)) e.remove();
    });
    kill();
    new MutationObserver(kill).observe(document.body, { childList: true, subtree: true });
  });
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => [...document.querySelectorAll('article img')].every(i => i.complete), null, { timeout: 15000 }).catch(() => {});
  await page.waitForTimeout(1000);
  return art;
}

const even = evenPx;

// Multi-media posts are a horizontal scroll-snap row; tag it and report each item's kind
function galleryInfo(art) {
  return art.evaluate(el => {
    const row = [...el.querySelectorAll('div')].find(d => {
      const s = getComputedStyle(d);
      return /auto|scroll/.test(s.overflowX) && d.scrollWidth > d.clientWidth + 4 && d.childElementCount > 1;
    });
    if (!row) return null;
    row.setAttribute('data-ts-gallery', '');
    return [...row.children].map(c => (c.querySelector('video, img[src*="video_thumb"]') ? 'video' : 'image'));
  });
}

const playToEnd = v => v.evaluate(v => new Promise(res => {
  let start = 0;
  v.muted = true; v.loop = false;
  // a native player may already be autoplaying; restart so the whole video is recorded
  v.pause(); v.currentTime = 0;
  v.addEventListener('playing', () => { start = start || Date.now(); }, { once: true });
  const done = () => res({ start: start || Date.now(), end: Date.now() });
  v.addEventListener('ended', done, { once: true });
  v.play().catch(() => {});
  setTimeout(done, 15 * 60e3);
}));

const IMAGE_HOLD_MS = 2500;

try {
  if (extract) {
    await extractMedia();
    process.exit(0);
  }
  // Pass 1: detect media type, screenshot single images, measure the tweet for video
  const ctx = await launch({ deviceScaleFactor: 2 });
  const page = await ctx.newPage();
  const art = await prepare(page);
  const sources = await videoSources();
  const nativeVideo = (await art.locator('video').count()) > 0;
  const injected = nativeVideo ? 0 : await injectVideos(art, sources);
  const kinds = await galleryInfo(art);
  const hasVideo = nativeVideo || injected > 0 || !!kinds;

  if (!hasVideo) {
    const out = path.join(outdir, `${id}.png`);
    await art.screenshot({ path: out });
    await ctx.close();
    addBorder(out, 2);
    if (rescaleOn) rescale(out);
    console.log('✔ Saved', out);
  } else {
    const r = await art.evaluate(el => {
      const b = el.getBoundingClientRect();
      return { x: b.x + scrollX, y: b.y + scrollY, w: b.width, h: b.height };
    });
    await ctx.close();

    // Pass 2: record the page while the media plays / scrolls. The viewport is tall enough to show the tweet without scrolling.
    const H = even(r.y + r.h + 20);
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tweetshot-'));
    const rctx = await launch({
      viewport: { width: W, height: H },
      recordVideo: { dir: tmp, size: { width: W, height: H } },
    });
    const t0 = Date.now();
    const p = await rctx.newPage();
    const a = await prepare(p);
    if (!(await a.locator('video').count())) await injectVideos(a, sources);
    const row = a.locator('[data-ts-gallery]');
    const rk = await galleryInfo(a);

    let start, end;
    if (rk) {
      console.log(`Gallery: ${rk.join(', ')}`);
      for (let i = 0; i < rk.length; i++) {
        if (i > 0) {
          await row.evaluate((s, i) => {
            const left = s.children[i].getBoundingClientRect().left - s.getBoundingClientRect().left + s.scrollLeft;
            s.scrollTo({ left, behavior: 'smooth' });
          }, i);
          await p.waitForTimeout(900);
        }
        const video = row.locator(':scope > *').nth(i).locator('video');
        let seg;
        if (rk[i] === 'video' && (await video.count())) seg = await playToEnd(video.first());
        else { const s = Date.now(); await p.waitForTimeout(IMAGE_HOLD_MS); seg = { start: s, end: Date.now() }; }
        if (i === 0) start = seg.start;
        end = seg.end;
      }
    } else {
      const vids = a.locator('video');
      await vids.evaluateAll(vs => vs.slice(1).forEach(v => { v.muted = true; v.loop = true; v.play().catch(() => {}); }));
      ({ start, end } = await playToEnd(vids.first()));
    }
    await p.waitForTimeout(400);
    const rec = await p.video().path();
    await rctx.close();

    const offset = Math.max(0, (start - t0) / 1000 - 0.2);
    const length = (end - start) / 1000 + 0.6;
    const out = path.join(outdir, `${id}.mp4`);
    execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y',
      '-i', rec, '-ss', offset.toFixed(2), '-t', length.toFixed(2),
      '-vf', `crop=${even(r.w)}:${even(r.h)}:${Math.round(r.x)}:${Math.round(r.y)}` +
        (borderCss ? `,pad=iw+${2 * borderCss}:ih+${2 * borderCss}:${borderCss}:${borderCss}:color=${borderColor}` : ''),
      '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '18', '-an', out], { stdio: 'inherit' });
    fs.rmSync(tmp, { recursive: true, force: true });
    if (rescaleOn) rescale(out);
    console.log('✔ Saved', out);
  }
} catch (e) {
  console.error('✘ tweetshot failed:', e.message);
  process.exit(1);
}
