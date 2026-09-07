// Fullsize — background service worker.
// The "doing" half: fetch candidate URLs cross-origin, convert the format when
// asked, and trigger the download.
//
// Milestone 4: the format picker. 'original' still hands the winning URL
// straight to chrome.downloads so the bytes reach disk untouched; png and jpg
// go through the offscreen document, which owns the OffscreenCanvas conversion
// and the blob URL that a service worker cannot create.

console.log('Fullsize service worker ready');

const OFFSCREEN_URL = 'offscreen.html';

const MIME_FOR_FORMAT = {
  png: 'image/png',
  jpg: 'image/jpeg',
};

// Extension for a content type, used when the URL gives us no usable one.
const EXT_FOR_TYPE = {
  'image/jpeg': 'jpg',
  'image/jpg': 'jpg',
  'image/png': 'png',
  'image/gif': 'gif',
  'image/webp': 'webp',
  'image/avif': 'avif',
  'image/svg+xml': 'svg',
  'image/bmp': 'bmp',
  'image/tiff': 'tif',
  'image/x-icon': 'ico',
};

// Enough to reach the original on a slow CDN, short enough not to hang the UI.
const FETCH_TIMEOUT_MS = 20000;

// A resolver run yields a handful of guesses; this stops a pathological page
// from firing dozens of requests.
const MAX_CANDIDATES = 8;

// ── Filenames ──────────────────────────────────────────────────────────────

// chrome.downloads rejects path separators, control characters and the Windows
// reserved set, so scrub them before they ever reach the API.
function safeFilename(suggested, preferredExt) {
  let name = String(suggested || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/[\x00-\x1f\x7f]/g, '')
    .replace(/^[.\s]+/, '')
    .trim();

  if (!name) name = 'fullsize-image';

  // Cap the stem, not the whole string — truncating blind would eat the
  // extension and Chrome would save an extensionless file.
  const dot = name.lastIndexOf('.');
  let stem = dot > 0 ? name.slice(0, dot) : name;
  const nameExt = dot > 0 ? name.slice(dot + 1).toLowerCase() : '';

  // The response's content type is the best evidence of what the bytes really
  // are, and CDNs happily serve WebP from a .jpg path. Prefer it, and keep the
  // extension already on the name as the fallback. This is also what turns
  // `photo.webp` into `photo.png` on a conversion, rather than `photo.webp.png`.
  const valid = /^[a-z0-9]{2,5}$/;
  let ext = valid.test(preferredExt || '') ? preferredExt : '';
  if (!ext && valid.test(nameExt)) ext = nameExt;

  if (stem.length > 150) stem = stem.slice(0, 150);

  // No extension we can stand behind. Return nothing rather than guessing:
  // omitting `filename` lets Chrome derive it from Content-Type and
  // Content-Disposition, which beats saving an extensionless file.
  if (!ext) return '';

  return `${stem}.${ext}`;
}

// The filename should describe the file we actually saved, so it comes from the
// URL that won the candidate walk — not from what the page happened to display.
// Otherwise a resolved Wikimedia original lands on disk still called
// `250px-Whatever.png`, which is a lie about its contents.
function basenameFromUrl(url) {
  if (/^data:/i.test(url) || /^blob:/i.test(url)) return '';
  try {
    const path = new URL(url).pathname;
    return decodeURIComponent(path.split('/').pop() || '');
  } catch (_) {
    return '';
  }
}

function extFromUrl(url) {
  const dataUrl = /^data:([^;,]+)/i.exec(url);
  if (dataUrl) return EXT_FOR_TYPE[dataUrl[1].toLowerCase()] || '';

  try {
    const path = new URL(url).pathname;
    const match = /\.([a-z0-9]{2,5})$/i.exec(path);
    return match ? match[1].toLowerCase() : '';
  } catch (_) {
    return '';
  }
}

function extFor(url, contentType) {
  return EXT_FOR_TYPE[contentType] || extFromUrl(url);
}

// A source already in the requested format needs no conversion at all. Saving
// the raw bytes is faster, avoids a decode and re-encode, and cannot drop an
// alpha channel by construction — there is no canvas involved to drop it on.
function alreadyInFormat(format, contentType) {
  if (format === 'png') return contentType === 'image/png';
  if (format === 'jpg') return contentType === 'image/jpeg' || contentType === 'image/jpg';
  return false;
}

// ── Candidate probing ──────────────────────────────────────────────────────

async function decodeSize(blob) {
  try {
    const bitmap = await createImageBitmap(blob);
    const size = { width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return size;
  } catch (_) {
    return null; // not a decodable raster image
  }
}

// Fetch one candidate and confirm it really is an image. Returns null for
// anything unusable so the caller can move to the next guess.
async function probe(url) {
  let res;
  try {
    res = await fetch(url, {
      credentials: 'omit',
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
  } catch (_) {
    return null; // network error, DNS failure, blocked, timed out
  }

  if (!res.ok) return null;

  const contentType = (res.headers.get('content-type') || '')
    .split(';')[0]
    .trim()
    .toLowerCase();

  let blob;
  try {
    blob = await res.blob();
  } catch (_) {
    return null;
  }
  if (!blob.size) return null;

  const type = contentType || (blob.type || '').toLowerCase();
  if (!type.startsWith('image/')) return null;

  // SVG is vector and createImageBitmap cannot decode it in a worker, so skip
  // the size check rather than rejecting a perfectly good file.
  if (type === 'image/svg+xml') {
    return { url, blob, type, width: 0, height: 0, vector: true };
  }

  const size = await decodeSize(blob);
  if (!size) return null;

  return { url, blob, type, width: size.width, height: size.height, vector: false };
}

// Walk the ranked list and take the first candidate that loads and is at least
// as big as what the page was already showing.
async function pickBest(candidates, referenceArea) {
  let fallback = null;

  for (const url of candidates) {
    const hit = await probe(url);
    if (!hit) continue;

    if (hit.vector || hit.width * hit.height >= referenceArea) return hit;

    // It loaded, but it decoded smaller than the on-screen image: some CDNs
    // answer an unknown/stripped URL with a default small render instead of a
    // 404. Keep the biggest of these and carry on looking.
    if (!fallback || hit.width * hit.height > fallback.width * fallback.height) {
      fallback = hit;
    }
  }

  return fallback;
}

// ── Offscreen document ─────────────────────────────────────────────────────

// Chrome permits exactly one offscreen document per extension, and a second
// createDocument call throws. Two clicks in quick succession would race, so
// concurrent callers share one in-flight promise.
let creating = null;

async function ensureOffscreen() {
  if (await chrome.offscreen.hasDocument()) return;

  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_URL,
        reasons: ['BLOBS'],
        justification:
          'Create a blob URL for the converted image so chrome.downloads can save it.',
      })
      .finally(() => {
        creating = null;
      });
  }

  try {
    await creating;
  } catch (err) {
    // Lost a race we did not detect — fine, as long as a document now exists.
    if (!(await chrome.offscreen.hasDocument())) throw err;
  }
}

async function convertViaOffscreen(url, format) {
  await ensureOffscreen();

  const reply = await chrome.runtime.sendMessage({
    target: 'fullsize-offscreen',
    type: 'FULLSIZE_CONVERT',
    url,
    format,
  });

  return reply || { ok: false, reason: 'No reply from the converter' };
}

// Blob URLs stay alive until revoked, and revoking one mid-download truncates
// the file — so hold each until Chrome reports the download settled.
const pendingRevoke = new Map(); // downloadId -> blob URL

chrome.downloads.onChanged.addListener((delta) => {
  if (!delta.state) return;

  const state = delta.state.current;
  if (state !== 'complete' && state !== 'interrupted') return;

  const url = pendingRevoke.get(delta.id);
  if (!url) return;
  pendingRevoke.delete(delta.id);

  chrome.runtime
    .sendMessage({ target: 'fullsize-offscreen', type: 'FULLSIZE_REVOKE', url })
    .catch(() => {
      // The offscreen document is already gone, which revoked it for us.
    });
});

// ── Download ───────────────────────────────────────────────────────────────

function startDownload({ url, stem, ext }) {
  return new Promise((resolve) => {
    const filename = safeFilename(stem, ext);
    const options = { url, saveAs: false };
    if (filename) options.filename = filename;

    chrome.downloads.download(options, (downloadId) => {
      if (chrome.runtime.lastError || downloadId === undefined) {
        resolve({
          ok: false,
          reason: chrome.runtime.lastError
            ? chrome.runtime.lastError.message
            : 'Download did not start',
        });
        return;
      }
      resolve({ ok: true, id: downloadId });
    });
  });
}

async function handleDownload(message) {
  const candidates = (Array.isArray(message.candidates) ? message.candidates : [])
    .filter(Boolean)
    .slice(0, MAX_CANDIDATES);

  if (!candidates.length) {
    return { ok: false, reason: 'No candidate URL supplied' };
  }

  const format = MIME_FOR_FORMAT[message.format] ? message.format : 'original';
  const referenceArea = Number(message.referenceArea) || 0;

  const hit = await pickBest(candidates, referenceArea);
  if (!hit) {
    return { ok: false, reason: 'All candidates failed to load' };
  }

  // Name the file after the source that won, whatever we end up encoding it as.
  const stem = basenameFromUrl(hit.url) || message.suggestedName;

  const passthrough = alreadyInFormat(format, hit.type);

  if (format === 'original' || passthrough) {
    // Raw bytes, straight to disk. Deliberately no canvas round-trip: that
    // would re-encode and lose quality for no reason.
    const result = await startDownload({
      url: hit.url,
      stem,
      ext: extFor(hit.url, hit.type),
    });
    if (result.ok) {
      const label = passthrough ? `${format} (already ${hit.type}, saved raw)` : 'original';
      console.log(
        `Fullsize: ${label} ${hit.width || '?'}x${hit.height || '?'} ${hit.type} — ${hit.url}`,
      );
    }
    return result;
  }

  // createImageBitmap cannot rasterise SVG here, and an SVG is already
  // resolution-independent, so converting it would only throw away quality.
  if (hit.vector) {
    return { ok: false, reason: 'SVG cannot be converted — use Original' };
  }

  const converted = await convertViaOffscreen(hit.url, format);
  if (!converted.ok) return converted;

  const result = await startDownload({ url: converted.url, stem, ext: format });

  if (!result.ok) {
    // Nothing will settle, so release the blob now rather than waiting for the
    // five-minute backstop in the offscreen document.
    chrome.runtime
      .sendMessage({
        target: 'fullsize-offscreen',
        type: 'FULLSIZE_REVOKE',
        url: converted.url,
      })
      .catch(() => {});
    return result;
  }

  pendingRevoke.set(result.id, converted.url);

  // `alpha` is read back off the canvas, so it reports what the encoder was
  // actually handed — not what we intended to hand it.
  const alphaNote =
    converted.alpha === null || converted.alpha === undefined
      ? ''
      : `, alpha ${converted.alpha ? 'preserved' : 'none'}`;

  console.log(
    `Fullsize: ${format} ${converted.width}x${converted.height} ` +
      `${(converted.size / 1024).toFixed(0)} KB (from ${hit.type})${alphaNote} — ${hit.url}`,
  );
  return { ok: true };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Anything addressed to the offscreen document is not ours to answer.
  if (!message || message.target || message.type !== 'FULLSIZE_DOWNLOAD') return false;

  handleDownload(message)
    .then(sendResponse)
    .catch((err) => {
      sendResponse({ ok: false, reason: err?.message || 'Unexpected error' });
    });

  return true; // keep the message channel open for the async sendResponse
});
