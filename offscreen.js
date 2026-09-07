// Fullsize — offscreen document.
//
// Exists for exactly one reason: an MV3 service worker cannot call
// URL.createObjectURL, so converted bytes in the worker have no URL to hand to
// chrome.downloads. This is a real DOM context, where blob URLs work at any
// file size — unlike a base64 data: URL, which inflates by a third and falls
// over on a large conversion.
//
// The worker has already walked the candidate list and knows which URL won, so
// this file only ever handles one URL at a time. It re-fetches it (served from
// the HTTP cache, since the worker fetched it moments ago) rather than trying
// to receive the bytes: chrome.runtime messaging is JSON-serialised, so a Blob
// or an ArrayBuffer cannot cross that boundary intact.

const MIME_FOR_FORMAT = {
  png: 'image/png',
  jpg: 'image/jpeg',
};

// Visually lossless for photographs while still well under the original size.
const JPEG_QUALITY = 0.92;

// Blob URLs handed to the worker and not yet revoked. The worker revokes each
// one when its download finishes; the timer is only a backstop for the case
// where the worker is suspended before it can.
const REVOKE_BACKSTOP_MS = 5 * 60 * 1000;
const live = new Map(); // objectUrl -> timeout id

function hold(objectUrl) {
  const timer = setTimeout(() => revoke(objectUrl), REVOKE_BACKSTOP_MS);
  live.set(objectUrl, timer);
}

function revoke(objectUrl) {
  const timer = live.get(objectUrl);
  if (timer === undefined) return; // already revoked, or never ours
  clearTimeout(timer);
  live.delete(objectUrl);
  URL.revokeObjectURL(objectUrl);
}

// True if any sampled pixel is less than fully opaque. Samples up to 64 evenly
// spaced rows rather than pulling the whole surface: one getImageData over a
// 15-megapixel original would allocate 60 MB to answer a yes/no question.
// Returns null if the read fails, which is not worth failing a save over.
function hasTransparency(ctx, width, height) {
  try {
    const rows = Math.min(height, 64);
    for (let i = 0; i < rows; i++) {
      const y = Math.floor((i * height) / rows);
      const { data } = ctx.getImageData(0, y, width, 1);
      for (let a = 3; a < data.length; a += 4) {
        if (data[a] !== 255) return true;
      }
    }
    return false;
  } catch (_) {
    return null;
  }
}

async function convert({ url, format }) {
  const mime = MIME_FOR_FORMAT[format];
  if (!mime) return { ok: false, reason: `Unsupported format: ${format}` };

  let res;
  try {
    res = await fetch(url, { credentials: 'omit' });
  } catch (err) {
    return { ok: false, reason: `Could not fetch the image: ${err.message}` };
  }
  if (!res.ok) return { ok: false, reason: `Image fetch failed: HTTP ${res.status}` };

  const source = await res.blob();

  let bitmap;
  try {
    bitmap = await createImageBitmap(source);
  } catch (_) {
    return { ok: false, reason: 'Could not decode the image for conversion' };
  }

  // JPEG is the only format here with no alpha channel, so it is the only one
  // that may ever have a ground laid down. Deriving this once, by name, keeps
  // the fill from leaking into a format that needs its transparency.
  const needsOpaqueGround = mime === 'image/jpeg';

  // JPEG cannot carry alpha, so there is nothing to measure afterwards — the
  // answer is always "none". Only the other formats get the readback.
  const willProbeAlpha = !needsOpaqueGround;

  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);

  const ctx = canvas.getContext('2d', {
    // Ask for the alpha-capable backing store explicitly rather than relying on
    // the default. With `alpha: false` the canvas starts opaque black and every
    // transparent source pixel composites down to black — which is precisely
    // the "saved a PNG and got a black background" failure.
    alpha: true,

    // hasTransparency() issues up to 64 getImageData calls, and Chrome warns
    // that repeated readbacks want this hint: it keeps the backing store on the
    // CPU rather than round-tripping the GPU for each read. Set only when we
    // actually intend to read back, so the JPEG path — which never probes —
    // keeps the accelerated default. We draw exactly once either way, so there
    // is no meaningful cost to the drawing side.
    willReadFrequently: willProbeAlpha,
  });

  // A freshly constructed OffscreenCanvas is already fully transparent, and
  // this function builds a new one per call, so nothing can be inherited from
  // a previous conversion. Clearing anyway states the invariant the PNG path
  // depends on, and costs nothing next to decoding the image.
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (needsOpaqueGround) {
    // Without white underneath, transparent pixels composite against
    // transparent black and a logo saved as JPG arrives on a black slab.
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
  }

  ctx.drawImage(bitmap, 0, 0);
  bitmap.close();

  // Read the alpha back off the canvas before encoding. Whether a PNG kept its
  // transparency is otherwise only observable through an image viewer, and
  // viewers disagree about how to render it — some paint transparency black,
  // which looks exactly like a flattened file.
  const alpha = willProbeAlpha ? hasTransparency(ctx, canvas.width, canvas.height) : false;

  const out = await canvas.convertToBlob({ type: mime, quality: JPEG_QUALITY });

  // convertToBlob silently falls back to PNG for a type it cannot encode, so
  // check what we actually got rather than trusting the request.
  if (out.type !== mime) {
    return { ok: false, reason: `Encoder produced ${out.type}, not ${mime}` };
  }

  const objectUrl = URL.createObjectURL(out);
  hold(objectUrl);

  return {
    ok: true,
    url: objectUrl,
    alpha,
    type: out.type,
    size: out.size,
    width: canvas.width,
    height: canvas.height,
  };
}

// Content scripts and the worker all broadcast on chrome.runtime, and this
// document receives every one of those messages. The `target` field is what
// keeps us from answering mail addressed to the worker.
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || message.target !== 'fullsize-offscreen') return false;

  if (message.type === 'FULLSIZE_CONVERT') {
    convert(message)
      .then(sendResponse)
      .catch((err) => {
        sendResponse({ ok: false, reason: err?.message || 'Conversion failed' });
      });
    return true; // async reply
  }

  if (message.type === 'FULLSIZE_REVOKE') {
    revoke(message.url);
    sendResponse({ ok: true });
    return false;
  }

  return false;
});
