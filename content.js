// Fullsize — content script.
// The "seeing" half: detect images, show the hover UI, run the Resolution
// Resolver, and hand a ranked candidate list to the background worker.
//
// Milestone 3: the Resolution Resolver. The format picker lands in Milestone 4.

(() => {
  'use strict';

  // An image qualifies if *either* dimension reaches this. Requiring both would
  // reject wide-but-short logos and banners (the Shopify logo is 137x52) and
  // tall-but-narrow strips, which are real images people want to save.
  const MIN_SIZE = 64;

  // ...but one long dimension alone is not enough, or a 1px-tall hairline
  // divider or an 800x1 tracking pixel would qualify. Demanding the area of a
  // 64x64 square as well keeps the logos and drops the decoration.
  const MIN_AREA = MIN_SIZE * MIN_SIZE;

  // How long the success / failure tint stays on the button.
  const FEEDBACK_MS = 1400;

  // Long enough to read a failure reason, short enough not to loiter.
  const TOAST_MS = 5000;

  // Breathing room between the control and the image's edge, and between the
  // control and the edge of the viewport.
  const GUTTER = 6;

  const SAVE_TITLE = 'Save the original file';

  // Query keys that mean "resize me". Dropping them asks the CDN for the source.
  const RESIZE_KEYS = [
    'w', 'width', 'h', 'height', 'size', 'resize',
    'fit', 'q', 'quality', 'dpr',
  ];

  // The picker. 'original' is first because it is the honest default: raw bytes,
  // never re-encoded.
  const FORMATS = [
    ['original', 'Original', 'Raw bytes, never re-encoded'],
    ['png', 'PNG', 'Lossless, keeps transparency'],
    ['jpg', 'JPG', 'Smaller file, no transparency'],
  ];

  let ui = null;            // injected container, created lazily on first hover
  let saveBtn = null;       // primary button — saves in the original format
  let menu = null;          // the Original / PNG / JPG picker
  let menuOpen = false;
  let bar = null;           // the Save + caret row, measured for positioning
  let toast = null;         // failure message, created on first failure
  let target = null;        // image the UI is currently attached to
  let frame = 0;            // pending requestAnimationFrame for repositioning
  let feedbackTimer = 0;
  let toastTimer = 0;

  // ── URL helpers ────────────────────────────────────────────────────────────

  function absolute(url) {
    if (!url) return '';
    try {
      return new URL(url, location.href).href;
    } catch (_) {
      return '';
    }
  }

  // Apply one rewrite and keep it only if it actually changed something.
  function variant(url, pattern, replacement) {
    const next = url.replace(pattern, replacement);
    return next !== url ? [next] : [];
  }

  // ── srcset parsing ─────────────────────────────────────────────────────────

  function isWhitespace(ch) {
    return ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === '\f';
  }

  // Hand-rolled scanner rather than `srcset.split(',')`. A srcset URL is
  // terminated by whitespace, not by a comma, so commas *inside* a URL are
  // legal — and Cloudinary transform URLs (`/upload/w_400,h_300,c_fill/`) are
  // full of them. Splitting on commas shreds those into garbage fragments.
  function parseSrcset(srcset) {
    const s = String(srcset || '');
    const out = [];
    let i = 0;

    while (i < s.length) {
      // Skip the whitespace and separator commas between candidates.
      while (i < s.length && (isWhitespace(s[i]) || s[i] === ',')) i++;
      if (i >= s.length) break;

      const start = i;
      while (i < s.length && !isWhitespace(s[i])) i++;
      const raw = s.slice(start, i);

      // A URL with trailing commas is a candidate carrying no descriptor.
      const url = raw.replace(/,+$/, '');
      const hadTrailingComma = url !== raw;

      let descriptor = '';
      if (!hadTrailingComma) {
        while (i < s.length && isWhitespace(s[i])) i++;
        const dStart = i;
        while (i < s.length && s[i] !== ',') i++;
        descriptor = s.slice(dStart, i).trim();
        if (s[i] === ',') i++;
      }

      if (url) out.push({ url, descriptor });
    }

    return out;
  }

  function descriptorWeight(descriptor) {
    const match = /^([\d.]+)([wxh])$/.exec(descriptor);
    if (!match) return { kind: 'x', value: 1 }; // no descriptor means 1x
    return { kind: match[2], value: parseFloat(match[1]) };
  }

  // Every URL in a srcset, largest first.
  function rankSrcset(srcset) {
    const entries = parseSrcset(srcset).map((entry) => ({
      url: entry.url,
      ...descriptorWeight(entry.descriptor),
    }));
    if (!entries.length) return [];

    // `w` and `x` units are not comparable — 800w is not 400x bigger than 2x.
    // Rank inside one family, preferring width descriptors when present.
    const hasWidths = entries.some((entry) => entry.kind === 'w');
    const pool = hasWidths ? entries.filter((entry) => entry.kind === 'w') : entries;

    return pool
      .sort((a, b) => b.value - a.value)
      .map((entry) => entry.url);
  }

  // Every srcset that describes this image, including the ones on sibling
  // <source> elements. Those are the case most tools miss: inside a <picture>
  // the high-res entries usually live on <source>, and the <img> tag only knows
  // the small fallback URL.
  function srcsetsFor(img) {
    const sets = [];
    if (img.srcset) sets.push(img.srcset);

    const parent = img.parentElement;
    if (parent && parent.tagName === 'PICTURE') {
      parent.querySelectorAll('source[srcset]').forEach((source) => {
        sets.push(source.getAttribute('srcset'));
      });
    }

    const lazySet = img.getAttribute('data-srcset');
    if (lazySet) sets.push(lazySet);

    return sets.filter(Boolean);
  }

  // ── Resize-parameter stripping ─────────────────────────────────────────────

  // Given one URL, guess at "bigger" versions of it. The guesses come back in
  // two tiers, because they are not equally safe:
  //
  //   strips     — targeted rewrites that each remove a *known* resize marker.
  //                A miss 404s, so the worker falls through and it costs one
  //                request and nothing else.
  //   lastResort — the blind full-query drop. On a CDN where a query parameter
  //                is a required auth token, dropping the query can return a
  //                large default or placeholder image instead of failing, which
  //                looks exactly like a successful upgrade. This must never
  //                outrank a URL we already know to be good.
  function resizeVariants(url) {
    const out = [];
    const lastResort = [];
    const empty = { strips: [], lastResort: [] };

    const abs = absolute(url);
    if (!abs || abs.startsWith('data:')) return empty;

    let u;
    try {
      u = new URL(abs);
    } catch (_) {
      return empty; // unparseable URL — skip
    }

    // Wikimedia: /wikipedia/commons/thumb/4/47/File.png/250px-File.png
    //   -> drop /thumb/ and the trailing /NNNpx-… to reach the original file.
    if (u.hostname.endsWith('wikimedia.org') && u.pathname.includes('/thumb/')) {
      const original = u.pathname
        .replace('/thumb/', '/')
        .replace(/\/[^/]*px-[^/]+$/, '');
      if (original !== u.pathname) out.push(u.origin + original);
    }

    // WordPress: name-1024x683.jpg -> name.jpg
    out.push(...variant(abs, /-\d+x\d+(?=\.[a-zA-Z]{3,4}(?:$|[?#]))/, ''));

    // WordPress 5.3+ also parks the untouched upload beside a -scaled copy.
    out.push(...variant(abs, /-scaled(?=\.[a-zA-Z]{3,4}(?:$|[?#]))/, ''));

    // Shopify: name_400x400.jpg / name_400x.jpg / name_400x@2x.jpg -> name.jpg
    out.push(...variant(abs, /_\d+x\d*(?:@\d+x)?(?=\.[a-zA-Z]{3,4}(?:$|[?#]))/, ''));

    // Cloudinary: /upload/w_400,h_300,c_fill/v1/name.jpg -> /upload/v1/name.jpg
    if (u.pathname.includes('/upload/')) {
      out.push(...variant(abs, /\/upload\/[^/]*(?:w_|h_|c_)[^/]*\//, '/upload/'));
    }

    // Query-param resizers (imgix, Unsplash, Contentful, Sanity, generic):
    // drop the keys we recognise and ask for the source.
    const trimmed = new URL(abs);
    let touched = false;
    RESIZE_KEYS.forEach((key) => {
      if (trimmed.searchParams.has(key)) {
        trimmed.searchParams.delete(key);
        touched = true;
      }
    });
    if (touched) out.push(trimmed.href);

    // Last resort for CDNs whose parameters we do not recognise: drop the query
    // wholesale. Signed URLs will 403 and we simply fall through.
    if (u.search) {
      const bare = new URL(abs);
      bare.search = '';
      lastResort.push(bare.href);
    }

    // The known-key strip and the wholesale drop often land on the same URL —
    // on Unsplash's `?w=300&q=60` both produce the bare photo URL. When they
    // agree there is nothing blind about it, so let the safe tier claim it and
    // drop it from the risky tier.
    const strips = [...new Set(out)];
    return {
      strips,
      lastResort: lastResort.filter((href) => !strips.includes(href)),
    };
  }

  // ── The resolver ───────────────────────────────────────────────────────────

  // Build the ranked candidate list for an image, best first.
  function resolveCandidates(img) {
    const base = img.currentSrc || img.src || '';

    const lazy = [
      img.getAttribute('data-src'),
      img.getAttribute('data-original'),
      img.getAttribute('data-lazy-src'),
      img.getAttribute('data-full-src'),
    ].filter(Boolean);

    const srcsetUrls = [];
    srcsetsFor(img).forEach((set) => srcsetUrls.push(...rankSrcset(set)));

    // Seeds are the URLs worth trying to strip: the biggest advertised
    // resolution first, then what is actually on screen, then lazy attributes.
    const seeds = [srcsetUrls[0], base, ...lazy].filter(Boolean);

    const out = [];
    const risky = [];

    seeds.forEach((seed) => {
      const { strips, lastResort } = resizeVariants(seed);
      // Targeted strips rank above the seed itself — the seed is the known-good
      // floor we fall back to.
      out.push(...strips, absolute(seed));
      risky.push(...lastResort);
    });

    // Remaining srcset entries, largest first, as later fallbacks.
    srcsetUrls.forEach((url) => out.push(absolute(url)));

    out.push(absolute(img.currentSrc), absolute(img.src));

    // The blind full-query drops go dead last, behind every URL we already know
    // to be good. Trying one before the on-screen URL risks silently saving a
    // CDN's placeholder when the query held a required auth token.
    out.push(...risky);

    // Dedupe keeps each URL's *first* position, so a risky entry that also
    // appears in the safe tier stays high rather than being demoted.
    return [...new Set(out.filter(Boolean))];
  }

  // ── Eligibility ────────────────────────────────────────────────────────────

  // Take the larger of the decoded and the laid-out size. A lazy-load
  // placeholder is a 1x1 GIF but already occupies the real image's box, and we
  // want the button there too — that is how case 5 of the fixture passes.
  function displaySize(img) {
    const rect = img.getBoundingClientRect();
    return {
      w: Math.max(img.naturalWidth || 0, rect.width),
      h: Math.max(img.naturalHeight || 0, rect.height),
    };
  }

  function isEligible(node) {
    if (!node || node.tagName !== 'IMG') return false;
    const { w, h } = displaySize(node);
    return (w >= MIN_SIZE || h >= MIN_SIZE) && w * h >= MIN_AREA;
  }

  // ── Injected UI ────────────────────────────────────────────────────────────

  // Capture-phase everywhere, and swallow every event: galleries routinely wrap
  // images in a link or a lightbox trigger, and none of our clicks may reach it.
  function wire(el, handler) {
    el.addEventListener('click', (e) => {
      swallow(e);
      handler();
    }, true);
    el.addEventListener('mousedown', swallow, true);
  }

  function buildUI() {
    ui = document.createElement('div');
    ui.className = 'fs-ui';

    bar = document.createElement('div');
    bar.className = 'fs-bar';

    saveBtn = document.createElement('button');
    saveBtn.className = 'fs-btn fs-save';
    saveBtn.type = 'button';
    saveBtn.textContent = 'Save';
    saveBtn.title = SAVE_TITLE;
    saveBtn.setAttribute('aria-label', 'Save this image in its original format');
    wire(saveBtn, () => pick('original'));

    const more = document.createElement('button');
    more.className = 'fs-btn fs-more';
    more.type = 'button';
    more.textContent = '▾';
    more.title = 'Choose a format';
    more.setAttribute('aria-label', 'Choose a format');
    more.setAttribute('aria-haspopup', 'menu');
    wire(more, toggleMenu);

    bar.append(saveBtn, more);

    menu = document.createElement('div');
    menu.className = 'fs-menu';
    menu.setAttribute('role', 'menu');

    FORMATS.forEach(([format, label, hint]) => {
      const item = document.createElement('button');
      item.className = 'fs-item';
      item.type = 'button';
      item.textContent = label;
      item.title = hint;
      item.setAttribute('role', 'menuitem');
      wire(item, () => {
        closeMenu();
        pick(format);
      });
      menu.appendChild(item);
    });

    ui.append(bar, menu);
    // Parent to <html>, not <body>: an absolutely positioned child resolves
    // against the nearest *positioned* ancestor, and plenty of sites set
    // `body { position: relative }`. That would offset every coordinate we
    // compute by the body's own origin. <html> is effectively never positioned,
    // so document coordinates stay honest.
    document.documentElement.appendChild(ui);
  }

  function toggleMenu() {
    menuOpen = !menuOpen;
    ui.classList.toggle('fs-open', menuOpen);
    // The picker changes the UI's height, so re-clamp: opening it near the
    // bottom of the window would otherwise push the items off-screen.
    place();
  }

  function closeMenu() {
    menuOpen = false;
    if (ui) ui.classList.remove('fs-open');
  }

  function swallow(e) {
    e.preventDefault();
    e.stopPropagation();
  }

  // Positioned in document coordinates against <html>, so ordinary page
  // scrolling needs no work — only transformed or overflow-scrolled ancestors
  // do, which the scroll listener below covers.
  function place() {
    frame = 0;
    if (!target || !ui) return;
    if (!target.isConnected) return hide();

    const r = target.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return hide();

    // Measure rather than assume: the bar's width depends on the host page's
    // rendering of our own font stack, which we cannot know ahead of time.
    const barBox = bar.getBoundingClientRect();
    const uiBox = ui.getBoundingClientRect();
    const barW = barBox.width;
    const uiH = uiBox.height; // includes the picker when it is open

    // Sit in the image's top-right corner, except on an image narrower than the
    // control itself — a 137px-wide logo would leave the bar hanging off the
    // left edge, so pin those to the image's left instead.
    let left = r.width < barW + GUTTER * 2
      ? r.left
      : r.left + r.width - GUTTER - barW;
    let top = r.top + GUTTER;

    // Never leave the viewport. Without this the control is unreachable on an
    // image flush against the right edge, or one taller than the window.
    left = Math.max(GUTTER, Math.min(left, window.innerWidth - barW - GUTTER));
    top = Math.max(GUTTER, Math.min(top, window.innerHeight - uiH - GUTTER));

    // These MUST be written as `important`. styles.css sets
    // `all: initial !important` on this element, and in the cascade an
    // important author declaration outranks a *normal* inline one — so a plain
    // `ui.style.top = …` is silently discarded, `top`/`left` resolve to `auto`,
    // and an absolutely positioned element with auto offsets falls back to its
    // static position: the end of the document, below everything. Writing them
    // with `important` puts them back on top, and as a bonus makes them immune
    // to a host page's `* { top: 0 !important }`.
    ui.style.setProperty('top', `${top + window.scrollY}px`, 'important');
    ui.style.setProperty('left', `${left + window.scrollX}px`, 'important');
  }

  function schedulePlace() {
    if (!frame && target) frame = requestAnimationFrame(place);
  }

  function show(img) {
    if (!ui) buildUI();
    if (target === img) return;
    closeMenu();
    target = img;
    clearFeedback();
    ui.classList.add('fs-visible');
    place();
  }

  function hide() {
    // Reaching an open picker means travelling off the image and over page
    // content, so a stray mouseover must not tear the UI down mid-journey.
    if (menuOpen) return;
    target = null;
    if (ui) ui.classList.remove('fs-visible');
  }

  // Unconditional teardown, for the paths that must win over an open menu.
  function dismiss() {
    closeMenu();
    hide();
  }

  // ── Feedback ───────────────────────────────────────────────────────────────

  function clearFeedback() {
    if (feedbackTimer) {
      clearTimeout(feedbackTimer);
      feedbackTimer = 0;
    }
    if (saveBtn) {
      saveBtn.classList.remove('fs-busy', 'fs-ok', 'fs-err');
      saveBtn.textContent = 'Save';
      saveBtn.title = SAVE_TITLE;
      saveBtn.disabled = false;
    }
  }

  function setFeedback(state, reason) {
    clearFeedback();
    saveBtn.classList.add(state);
    if (reason) saveBtn.title = reason;

    if (state === 'fs-busy') {
      saveBtn.textContent = '…';
      saveBtn.disabled = true;
      return;
    }

    saveBtn.textContent = state === 'fs-ok' ? 'Saved' : 'Failed';
    feedbackTimer = setTimeout(clearFeedback, FEEDBACK_MS);
  }

  // Only paint the reply onto the button if it is still the same image — the
  // pointer may have moved on while the download was in flight.
  function settle(img, state, reason) {
    if (target !== img) return;
    setFeedback(state, reason);
  }

  // ── Failure toast ──────────────────────────────────────────────────────────

  // A tinted button only reports a failure if the pointer happens to still be
  // on the same image, and a tooltip only if the user thinks to hover it. The
  // toast is the one place a reason cannot be missed. Failures only — success
  // is already obvious from the button and the browser's own download shelf.
  function buildToast() {
    toast = document.createElement('div');
    toast.className = 'fs-toast';
    toast.setAttribute('role', 'status');
    toast.setAttribute('aria-live', 'polite');
    toast.addEventListener('click', (e) => {
      swallow(e);
      hideToast();
    }, true);
    document.documentElement.appendChild(toast);
  }

  function showToast(text) {
    if (!toast) buildToast();
    toast.textContent = text;
    toast.classList.add('fs-toast-on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, TOAST_MS);
  }

  function hideToast() {
    if (toastTimer) {
      clearTimeout(toastTimer);
      toastTimer = 0;
    }
    if (toast) toast.classList.remove('fs-toast-on');
  }

  // ── Save ───────────────────────────────────────────────────────────────────

  function suggestName(url) {
    if (/^data:/i.test(url)) return '';
    try {
      const path = new URL(url, location.href).pathname;
      return decodeURIComponent(path.split('/').pop() || '');
    } catch (_) {
      return '';
    }
  }

  function pick(format) {
    if (!target) return;

    const img = target;
    const candidates = resolveCandidates(img);
    if (!candidates.length) {
      setFeedback('fs-err', 'No image URL found');
      showToast('Fullsize found no usable URL for this image.');
      return;
    }

    hideToast();
    setFeedback('fs-busy');

    chrome.runtime.sendMessage(
      {
        type: 'FULLSIZE_DOWNLOAD',
        candidates,
        format,
        // Only a fallback for a winner with no usable basename. Take it from
        // the on-screen URL, which is stable — the last candidate is now the
        // blind query drop, which is the least descriptive of the set.
        suggestedName: suggestName(img.currentSrc || img.src || ''),
        // The on-screen pixel count. The worker rejects any "upgrade" that
        // decodes smaller than this, because some CDNs answer a stripped URL
        // with a default small render instead of a 404.
        referenceArea: (img.naturalWidth || 0) * (img.naturalHeight || 0),
      },
      (reply) => {
        if (reply && reply.ok) return settle(img, 'fs-ok');

        const why = chrome.runtime.lastError
          ? chrome.runtime.lastError.message
          : (reply && reply.reason) || 'No reply from the background worker';

        settle(img, 'fs-err', why);
        showToast(`Fullsize couldn't save this image — ${why}`);
      },
    );
  }

  // ── Dry run (fixture section 9) ────────────────────────────────────────────

  // Print the candidate list a URL produces, without touching the network.
  // Reads the fixture's [data-dryrun] entries, or takes a URL directly.
  function dryRun(url) {
    const targets = url
      ? [url]
      : Array.from(document.querySelectorAll('[data-dryrun]'), (n) =>
        n.textContent.trim());

    if (!targets.length) {
      console.log('Fullsize: no [data-dryrun] URLs here. Try __fullsizeDryRun(someUrl).');
      return [];
    }

    const results = targets.map((t) => {
      const { strips, lastResort } = resizeVariants(t);
      const seed = absolute(t);

      // Mirror the real ranking: targeted strips, the known-good URL, then the
      // blind query drops.
      const unique = [...new Set([...strips, seed, ...lastResort].filter(Boolean))];
      const risky = new Set(lastResort);

      console.group(`Fullsize · ${t}`);
      unique.forEach((c, i) => {
        let note = '';
        if (c === seed) note = '  (original, unchanged)';
        else if (risky.has(c)) note = '  (last resort — blind query drop)';
        console.log(`${i + 1}. ${c}${note}`);
      });
      if (unique.length === 1) console.log('   nothing to strip');
      console.groupEnd();

      return { url: t, candidates: unique };
    });

    return results;
  }

  // Exposed for the fixture. Content scripts run in an isolated world, so this
  // is reachable from the DevTools console only after switching the context
  // dropdown from "top" to "Fullsize".
  self.__fullsizeDryRun = dryRun;
  self.__fullsizeResolve = resolveCandidates;

  // ── Wiring ─────────────────────────────────────────────────────────────────

  // One delegated listener covers every image on the page, including ones added
  // after load by lazy galleries or infinite scroll — no MutationObserver and no
  // per-image bookkeeping. Capture phase, so a page handler that calls
  // stopPropagation cannot blind us.
  document.addEventListener(
    'mouseover',
    (e) => {
      const node = e.target;
      if (ui && ui.contains(node)) return; // pointer moved onto our own button
      if (isEligible(node)) show(node);
      else hide();
    },
    true,
  );

  // A click anywhere but our own UI closes the picker. Capture phase so a page
  // that calls stopPropagation cannot leave the menu stuck open — but
  // deliberately *not* swallowed, so the page still receives its own click.
  document.addEventListener('click', (e) => {
    if (menuOpen && ui && !ui.contains(e.target)) dismiss();
  }, true);

  // Escape closes the picker, and is consumed only when it actually did so —
  // otherwise we would eat the keystroke a page lightbox was waiting for.
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape' || !menuOpen) return;
    dismiss();
    e.stopPropagation();
  }, true);

  // Capture, so scrolling inside an overflow container is caught too.
  window.addEventListener('scroll', schedulePlace, true);
  window.addEventListener('resize', schedulePlace);
})();
