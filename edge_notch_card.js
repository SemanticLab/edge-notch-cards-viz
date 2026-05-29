// EdgeNotchCard — interactive SVG diagram of a McBee-style edge-notch card.
//
//   const card = new EdgeNotchCard(container, {
//     decoding,                    // object shaped like scripts/data/notch_decoding.json
//     slotCounts: { top:36, bottom:37, left:16, right:15 },  // optional override
//     universalNotches: { top: [34] },                       // shown notched by default
//     onCategoryHover: (info) => {},  // { edge, name, positions }  (or null on leave)
//     onCategoryClick: (info) => {},
//     onSlotHover:     (info) => {},  // { edge, pos, categories } (or null on leave)
//     onSlotClick:     (info) => {},
//   });
//   card.highlight({ edge: 'top', name: 'physics' });
//   card.clearHighlight();
//   card.destroy();

const SVG_NS = 'http://www.w3.org/2000/svg';
const DEFAULT_SLOT_COUNTS = { top: 36, bottom: 37, left: 16, right: 15 };

// Qualitative palette (ColorBrewer Dark2) used when highlightCompanions is on,
// to give each hovered hole's category groups a distinct color.
const COMPANION_PALETTE = [
  '#1b9e77', '#d95f02', '#7570b3', '#e7298a', '#66a61e', '#e6ab02', '#a6761d',
];

function el(tag, attrs = {}, parent = null) {
  const node = document.createElementNS(SVG_NS, tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v == null) continue;
    node.setAttribute(k, String(v));
  }
  if (parent) parent.appendChild(node);
  return node;
}

function htmlEl(tag, className, parent) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (parent) parent.appendChild(node);
  return node;
}

// Group decoded entries by edge and produce a flat list of categories per edge.
// Returns: { top: [{name, positions, meta}], bottom: [...], left: [...], right: [...] }
function buildCategoryIndex(decoding) {
  const out = { top: [], bottom: [], left: [], right: [] };
  if (!decoding) return out;

  // Top: technicalFields, each with a 2-position pair. List every field
  // individually (duplicates with the same pair are kept — they will all light
  // up the same two slots when hovered).
  if (decoding.top_field_codes) {
    for (const [name, info] of Object.entries(decoding.top_field_codes)) {
      out.top.push({
        name,
        positions: info.pair.slice(),
        meta: { recall: info.recall, n: info.n, kind: 'field' },
      });
    }
    // Sort by leftmost position so the labels roughly run from left to right
    // along the top edge — same-pair entries cluster together.
    out.top.sort((a, b) => {
      const pa = Math.min(...a.positions), pb = Math.min(...b.positions);
      if (pa !== pb) return pa - pb;
      const sa = Math.max(...a.positions), sb = Math.max(...b.positions);
      if (sa !== sb) return sa - sb;
      return a.name.localeCompare(b.name);
    });
  }

  // Bottom: geographic. NEW SHAPE — each state has one PRIMARY notch (the
  // single-needle code an operator would actually use) plus zero or more
  // COMPANIONS (positions nearly always co-notched with the primary, likely
  // wide grouped notches or within-state refinements). The viz renders the
  // primary as a full notch and companions as "secondary" notches so the
  // distinction is visible.
  if (decoding.bottom_geo_codes) {
    for (const [name, info] of Object.entries(decoding.bottom_geo_codes)) {
      // Support both new shape ({primary, companions}) and legacy
      // ({positions: [{pos,...}]}) — falls back gracefully if someone passes
      // an older decoding file.
      let primaryPos = null;
      let companionPositions = [];
      if (info.primary && typeof info.primary.pos === 'number') {
        primaryPos = info.primary.pos;
        companionPositions = (info.companions || []).map((c) => c.pos);
      } else if (Array.isArray(info.positions) && info.positions.length) {
        // Legacy fallback: treat the first position as primary
        primaryPos = info.positions[0].pos;
        companionPositions = info.positions.slice(1).map((p) => p.pos);
      } else {
        continue;
      }
      out.bottom.push({
        name,
        positions: [primaryPos, ...companionPositions],
        primaryPos,
        companionPositions,
        meta: {
          n: info.n,
          confidence: info.confidence || null,
          kind: 'geo',
          primary: info.primary || null,
          companions: info.companions || null,
        },
      });
    }
    // Sort bottom-edge labels by confidence (high first) then by sample size
    const confidenceOrder = { high: 0, medium: 1, low: 2, anecdotal: 3 };
    out.bottom.sort((a, b) => {
      const ca = confidenceOrder[a.meta.confidence] ?? 99;
      const cb = confidenceOrder[b.meta.confidence] ?? 99;
      if (ca !== cb) return ca - cb;
      return (b.meta.n || 0) - (a.meta.n || 0);
    });
  }

  // Right: alpha — show every letter A..Z that appears in the profile, even
  // those with weak signals. If only strong positions are precomputed, use
  // them; otherwise derive from the profile at any non-trivial rate.
  if (decoding.right_alpha) {
    const ra = decoding.right_alpha;
    const strong = ra.per_letter_strong_positions
      || derivePerLetterStrong(ra.per_letter_profile, 0.4);
    if (strong) {
      // Letters that appear in the strong list, plus letters from the profile
      // (so we don't hide letters that only have weak signal)
      const allLetters = new Set(Object.keys(strong));
      if (ra.per_letter_profile) {
        for (const l of Object.keys(ra.per_letter_profile)) allLetters.add(l);
      }
      for (const letter of allLetters) {
        const positions = (strong[letter] || []).map(Number);
        out.right.push({
          name: letter,
          positions,
          meta: { kind: 'alpha', hasSignal: positions.length > 0 },
        });
      }
      out.right.sort((a, b) => a.name.localeCompare(b.name));
    }
  }

  // Left edge: meaning unknown. We previously hypothesized it encoded the
  // number of names on the back, but the names accrue over time and a count
  // that grows can't be represented by a fixed set of punched holes — so the
  // left edge is left unclassified.

  return out;
}

function derivePerLetterStrong(profile, threshold) {
  if (!profile) return null;
  const out = {};
  for (const [letter, posMap] of Object.entries(profile)) {
    const strong = Object.entries(posMap)
      .filter(([, rate]) => rate >= threshold)
      .map(([p]) => Number(p));
    if (strong.length) out[letter] = strong.sort((a, b) => a - b);
  }
  return out;
}

class EdgeNotchCard {
  constructor(container, options = {}) {
    if (!container) throw new Error('EdgeNotchCard: container is required');
    this.container = container;
    this.options = options;
    this.slotCounts = { ...DEFAULT_SLOT_COUNTS, ...(options.slotCounts || {}) };
    this.universalNotches = options.universalNotches || { top: [34] };
    this.categoriesByEdge = buildCategoryIndex(options.decoding);
    // When false, no edge titles or category labels are drawn — just the card
    // and its holes (the card-host shrinks its gutters to match).
    this.showEdgeLabels = options.showEdgeLabels !== false;
    // When true, hovering a hole notches its category partners with the
    // distinct .enc-companion style instead of the same notch as the hovered
    // hole, so a pair reads as "this hole + its linked hole(s)".
    this.highlightCompanions = !!options.highlightCompanions;
    // Persistent user-selected notches (canonical "edge:pos" keys). These stay
    // notched across hovers; transient hover/preview draws on top.
    this.selectedNotches = new Set();
    // Called after every layout with the card's on-screen rect, so callers can
    // position an overlay inside the card face.
    this.onLayout = typeof options.onLayout === 'function' ? options.onLayout : null;

    // Listener registry — supports both options.onXxx and on('xxx', fn)
    this.listeners = {
      categoryHover: [], categoryClick: [],
      slotHover: [], slotClick: [],
    };
    for (const [evt, opt] of [
      ['categoryHover', 'onCategoryHover'],
      ['categoryClick', 'onCategoryClick'],
      ['slotHover',    'onSlotHover'],
      ['slotClick',    'onSlotClick'],
    ]) {
      if (typeof options[opt] === 'function') this.listeners[evt].push(options[opt]);
    }

    this.activeHighlight = null;  // { type: 'category'|'slot', edge, key }
    this.resizeObserver = null;

    this._buildSkeleton();
    this._layout();
    this._installResizeObserver();
  }

  // --- Public API ---------------------------------------------------------

  on(event, fn) {
    const key = event.startsWith('on') ? event[2].toLowerCase() + event.slice(3) : event;
    if (this.listeners[key]) this.listeners[key].push(fn);
    return this;
  }

  off(event, fn) {
    const key = event.startsWith('on') ? event[2].toLowerCase() + event.slice(3) : event;
    const arr = this.listeners[key];
    if (!arr) return this;
    const i = arr.indexOf(fn);
    if (i >= 0) arr.splice(i, 1);
    return this;
  }

  highlight(target) {
    // target: { edge, name } for a category, or { edge, pos } for a slot
    if (!target) return this.clearHighlight();
    if (target.name != null) {
      this._activateCategory(target.edge, target.name, { source: 'api' });
    } else if (target.pos != null) {
      this._activateSlot(target.edge, target.pos, { source: 'api' });
    }
  }

  clearHighlight() {
    this._deactivate({ source: 'api' });
  }

  // Transiently notch an explicit set of positions (no category lookup), e.g.
  // to preview a category from an external list. list: [{edge, pos, color, faint}].
  previewPositions(list) {
    this._clearActiveDom();
    this.activeHighlight = { type: 'preview' };
    for (const it of list || []) {
      this._setSlotNotched(it.edge, it.pos, true, { color: it.color, faint: it.faint });
    }
  }

  clearPreview() {
    this._clearActiveDom();
    this.activeHighlight = null;
  }

  // Persistent selection (the user's chosen "needles"). Keyed canonically so a
  // corner hole counts once.
  toggleSelected(edge, pos) {
    const canon = this._canonicalFor(edge, pos);
    const key = canon.edge + ':' + canon.pos;
    if (this.selectedNotches.has(key)) this.selectedNotches.delete(key);
    else this.selectedNotches.add(key);
    this._clearActiveDom();           // re-render with selection applied
    this.activeHighlight = null;
    return this.selectedNotches.has(key);
  }

  isSelected(edge, pos) {
    const canon = this._canonicalFor(edge, pos);
    return this.selectedNotches.has(canon.edge + ':' + canon.pos);
  }

  clearSelected() {
    this.selectedNotches.clear();
    this._clearActiveDom();
    this.activeHighlight = null;
  }

  // Replace the whole selection in one re-render. list: [{edge, pos}].
  setSelectedNotches(list) {
    this.selectedNotches = new Set((list || []).map(({ edge, pos }) => {
      const c = this._canonicalFor(edge, pos);
      return c.edge + ':' + c.pos;
    }));
    this._clearActiveDom();
    this.activeHighlight = null;
  }

  getSelected() {
    return [...this.selectedNotches].map((k) => {
      const [e, p] = k.split(':');
      return { edge: e, pos: Number(p) };
    });
  }

  // Card face rectangle in container pixels — for positioning an overlay inside
  // the card. Accounts for the SVG's xMidYMid 'meet' letterboxing.
  getCardRect() {
    const r = this.svg.getBoundingClientRect();
    const vbW = this.viewW || r.width;
    const vbH = this.viewH || r.height;
    const scale = Math.min(r.width / vbW, r.height / vbH);
    const offX = (r.width - vbW * scale) / 2;
    const offY = (r.height - vbH * scale) / 2;
    return {
      left: offX + this.cardX * scale,
      top: offY + this.cardY * scale,
      width: this.cardW * scale,
      height: this.cardH * scale,
    };
  }

  destroy() {
    if (this.resizeObserver) {
      try { this.resizeObserver.disconnect(); } catch (_) {}
      this.resizeObserver = null;
    }
    this.container.innerHTML = '';
  }

  // --- Internal: DOM construction ----------------------------------------

  _buildSkeleton() {
    this.container.classList.add('enc-root');
    this.container.innerHTML = '';
    this.svg = el('svg', {
      xmlns: SVG_NS,
      class: 'enc-svg',
      preserveAspectRatio: 'xMidYMid meet',
    });
    this.svg.style.width = '100%';
    this.svg.style.height = '100%';
    this.svg.style.display = 'block';
    this.container.appendChild(this.svg);

    // Groups in draw order: card → slots → connector lines → labels
    this.gCard       = el('g', { class: 'enc-card-group' }, this.svg);
    this.gSlots      = el('g', { class: 'enc-slots' }, this.svg);
    this.gLines      = el('g', { class: 'enc-lines' }, this.svg);
    this.gLabels     = el('g', { class: 'enc-labels' }, this.svg);

    this._injectStyles();
  }

  _injectStyles() {
    if (document.getElementById('enc-styles')) return;
    const style = document.createElement('style');
    style.id = 'enc-styles';
    style.textContent = `
      .enc-root { position: relative; width: 100%; height: 100%; min-height: 320px;
                   font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; }
      .enc-svg { background: transparent; }
      .enc-card-body { fill: #f6efd6; stroke: #2a2a2a; stroke-width: 1.2; }
      .enc-hole { fill: #fafafa; stroke: #555; stroke-width: 0.6; cursor: pointer;
                   transition: fill 120ms ease; }
      .enc-hole.enc-universal { fill: #d8c98a; }
      .enc-hole.enc-active   { fill: #1b1b1b; stroke: #1b1b1b; }
      .enc-hole.enc-related-dim { stroke: #888; }
      .enc-slot-hit { fill: transparent; cursor: pointer; }
      .enc-label { font-size: 11px; fill: #2a2a2a; cursor: pointer;
                    transition: fill 120ms ease, font-weight 120ms ease; }
      .enc-label-bg { fill: rgba(255,255,255,0.6); stroke: rgba(0,0,0,0.0); rx: 3; ry: 3;
                       transition: fill 120ms ease, stroke 120ms ease; }
      .enc-label-group:hover .enc-label-bg,
      .enc-label-group.enc-active .enc-label-bg { fill: #fff3a6; stroke: #c4a000; stroke-width: 0.6; }
      .enc-label-group.enc-active .enc-label { font-weight: 600; fill: #000; }
      .enc-label-group.enc-dim .enc-label { opacity: 0.35; }
      /* Bottom-edge confidence bands. High = full weight, anecdotal = much lighter.
         These apply *before* hover dim, so a low-confidence label that you're
         hovering still becomes prominent. */
      .enc-label-group.enc-conf-high    .enc-label { fill: #1a1a1a; }
      .enc-label-group.enc-conf-medium  .enc-label { fill: #555; }
      .enc-label-group.enc-conf-low     .enc-label { fill: #888; font-style: italic; }
      .enc-label-group.enc-conf-anecdotal .enc-label { fill: #aaa; font-style: italic; }
      .enc-line { stroke: #c4a000; stroke-width: 1.2; fill: none; opacity: 0; pointer-events: none;
                   transition: opacity 120ms ease; }
      .enc-line.enc-active { opacity: 0.85; }
      /* Primary notch (the actual one-needle code for a bottom-edge state):
         distinctively colored so the user can tell it apart from companions,
         which are notched too but aren't THE encoding. */
      .enc-hole.enc-active.enc-primary { fill: #c4262e; stroke: #8a1318; }
      .enc-line.enc-active.enc-primary { stroke: #c4262e; stroke-width: 2;
                                          opacity: 1; }
      .enc-edge-title { font-size: 10px; fill: #888; text-transform: uppercase;
                         letter-spacing: 0.08em; pointer-events: none; }
      .enc-chamfer { fill: #f6efd6; stroke: #2a2a2a; stroke-width: 1.2; }
      /* Persistent user-selected notch ("needle"). Overrides the transient
         active fill so chosen positions stay distinct. */
      .enc-hole.enc-active.enc-selected { fill: #11324f; stroke: #07203a; }
    `;
    document.head.appendChild(style);
  }

  // --- Internal: layout ---------------------------------------------------

  _installResizeObserver() {
    if (typeof ResizeObserver === 'undefined') {
      window.addEventListener('resize', () => this._layout());
      return;
    }
    this.resizeObserver = new ResizeObserver(() => this._layout());
    this.resizeObserver.observe(this.container);
  }

  _maxLabelLen(cats) {
    let max = 0;
    for (const c of cats) max = Math.max(max, c.name.length);
    return max;
  }

  _measureLabelGutter() {
    // No labels → just a thin uniform margin so the card nearly fills the host.
    if (!this.showEdgeLabels) {
      const PAD = 16;
      return { top: PAD, bottom: PAD, left: PAD, right: PAD };
    }
    // Top/bottom labels are rendered VERTICALLY (rotated 90°) so they don't
    // overlap each other when there are many. Their *visual height* therefore
    // equals their character count × ~6.5px. Left/right labels are horizontal
    // so their width equals their character count × ~6.5px.
    // Empirically: rendered 11px proportional font averages ~7.2px per char
    // for the kinds of strings we use (mostly lowercase ascii). Pad on each
    // end accommodates the edge title and a little breathing room.
    const CHAR_PX = 7.2;
    const PAD = 28;
    const longestTop    = this._maxLabelLen(this.categoriesByEdge.top);
    const longestBottom = this._maxLabelLen(this.categoriesByEdge.bottom);
    const longestLeft   = this._maxLabelLen(this.categoriesByEdge.left);
    const longestRight  = this._maxLabelLen(this.categoriesByEdge.right);
    return {
      top:    Math.max(80, longestTop    * CHAR_PX + PAD),
      bottom: Math.max(80, longestBottom * CHAR_PX + PAD),
      left:   Math.max(80, longestLeft   * CHAR_PX + PAD),
      right:  Math.max(80, longestRight  * CHAR_PX + PAD),
    };
  }

  _layout() {
    const rect = this.container.getBoundingClientRect();
    const W = Math.max(320, rect.width);
    const H = Math.max(240, rect.height || rect.width * 0.7);

    // Card has the same long:short ratio as a real McBee card (long edge has
    // 36/37 slots vs 15/16 on the short edge → ~2.4:1).
    const CARD_RATIO = 36 / 15;
    const gutters = this._measureLabelGutter();

    // Solve for card width/height that fits in W×H minus gutters. Lock the
    // wide-card aspect: width comes first, height follows. Only shrink width
    // if forcing wide-ratio would overflow vertically.
    let cardW = Math.max(180, W - gutters.left - gutters.right);
    let cardH = cardW / CARD_RATIO;
    const availH = Math.max(120, H - gutters.top - gutters.bottom);
    if (cardH > availH) {
      cardH = availH;
      cardW = cardH * CARD_RATIO;
    }
    const viewW = cardW + gutters.left + gutters.right;
    const viewH = cardH + gutters.top  + gutters.bottom;
    this.svg.setAttribute('viewBox', `0 0 ${viewW} ${viewH}`);

    this.cardX = gutters.left;
    this.cardY = gutters.top;
    this.cardW = cardW;
    this.cardH = cardH;
    this.gutters = gutters;
    this.viewW = viewW;
    this.viewH = viewH;

    this._renderAll();
    if (this.onLayout) this.onLayout(this.getCardRect());
  }

  // --- Internal: render ---------------------------------------------------

  _renderAll() {
    [this.gCard, this.gSlots, this.gLines, this.gLabels].forEach((g) => {
      while (g.firstChild) g.removeChild(g.firstChild);
    });
    this._renderCard();
    this._renderSlots();
    this._applySelected();
    this._renderLabels();
    // Re-apply highlight if active (e.g. after a resize)
    if (this.activeHighlight) {
      const h = this.activeHighlight;
      this.activeHighlight = null;
      if (h.type === 'preview') { /* preview is transient; drop on re-render */ }
      else if (h.type === 'category') this._activateCategory(h.edge, h.key, { source: 'restore' });
      else if (h.type === 'slot') this._activateSlot(h.edge, h.key, { source: 'restore' });
    }
  }

  _renderCard() {
    // Card with a clipped top-right chamfer (front orientation).
    const x = this.cardX, y = this.cardY, w = this.cardW, h = this.cardH;
    const chamfer = Math.min(w, h) * 0.05;
    const d = [
      `M ${x} ${y}`,
      `L ${x + w - chamfer} ${y}`,
      `L ${x + w} ${y + chamfer}`,
      `L ${x + w} ${y + h}`,
      `L ${x} ${y + h}`,
      'Z',
    ].join(' ');
    el('path', { d, class: 'enc-card-body' }, this.gCard);
  }

  _slotPosition(edge, pos) {
    // pos is 1-indexed. Returns {cx, cy} for the hole center inside the card.
    // Slots run corner-to-corner: pos 1 is AT the start corner of the edge,
    // pos N is AT the end corner. The four corner holes are therefore SHARED
    // between two adjacent edges (e.g. top pos 1 == left pos 1).
    const x = this.cardX, y = this.cardY, w = this.cardW, h = this.cardH;
    const count = this.slotCounts[edge];
    const inset = Math.min(w, h) * 0.05;  // distance from card edge to hole row
    const span = (edge === 'top' || edge === 'bottom') ? w : h;
    const usable = span - 2 * inset;
    const step = usable / (count - 1);
    const along = inset + step * (pos - 1);
    if (edge === 'top')    return { cx: x + along, cy: y + inset };
    if (edge === 'bottom') return { cx: x + along, cy: y + h - inset };
    if (edge === 'left')   return { cx: x + inset, cy: y + along };
    if (edge === 'right')  return { cx: x + w - inset, cy: y + along };
    throw new Error('unknown edge: ' + edge);
  }

  // Returns [{edge, pos}, ...] — all (edge, pos) tuples that refer to the same
  // physical hole. For non-corner holes this is just the input. For corners,
  // it includes the shared adjacent-edge entry too.
  _aliasesFor(edge, pos) {
    const counts = this.slotCounts;
    const aliases = [{ edge, pos }];
    // Front-card corner mapping (chamfer is top-right):
    //   top 1     ⇔ left 1     (top-left)
    //   top N     ⇔ right 1    (top-right, on chamfer)
    //   bottom 1  ⇔ left M     (bottom-left)
    //   bottom N  ⇔ right M    (bottom-right)
    if (edge === 'top' && pos === 1)             aliases.push({ edge: 'left',  pos: 1 });
    if (edge === 'top' && pos === counts.top)    aliases.push({ edge: 'right', pos: 1 });
    if (edge === 'bottom' && pos === 1)          aliases.push({ edge: 'left',  pos: counts.left });
    if (edge === 'bottom' && pos === counts.bottom) aliases.push({ edge: 'right', pos: counts.right });
    if (edge === 'left' && pos === 1)            aliases.push({ edge: 'top',    pos: 1 });
    if (edge === 'left' && pos === counts.left)  aliases.push({ edge: 'bottom', pos: 1 });
    if (edge === 'right' && pos === 1)           aliases.push({ edge: 'top',    pos: counts.top });
    if (edge === 'right' && pos === counts.right) aliases.push({ edge: 'bottom', pos: counts.bottom });
    return aliases;
  }

  // Choose a single canonical (edge, pos) for each physical hole. We render
  // each physical hole exactly once. For corners, we pick the long-edge
  // representation (top/bottom) so the hole's primary categorical home is
  // unambiguous; the short-edge alias still routes to it via the alias map.
  _canonicalFor(edge, pos) {
    const aliases = this._aliasesFor(edge, pos);
    if (aliases.length === 1) return aliases[0];
    // Prefer top, then bottom, then left, then right
    const order = { top: 0, bottom: 1, left: 2, right: 3 };
    return aliases.sort((a, b) => order[a.edge] - order[b.edge])[0];
  }

  // Render the visual for one physical hole. When notched: a U-shape slot
  // — the cardstock between the hole and the outer edge has been cut away,
  // so the shape is the hole-circle continued out to the card edge by a
  // rectangle whose width = hole diameter. The inner end is the original
  // hole's semicircle; the outer end is open to the card edge.
  _renderHoleShape(edge, pos, holeR, notched, opts = {}) {
    const { cx, cy } = this._slotPosition(edge, pos);
    if (!notched) {
      return el('circle', { cx, cy, r: holeR, class: 'enc-hole' });
    }
    // Distance from hole center to the card's outer edge (this varies for
    // corners, which are inset from BOTH edges — we cut to the nearer edge).
    let outerX, outerY;
    if (edge === 'top')    { outerX = cx; outerY = this.cardY; }
    if (edge === 'bottom') { outerX = cx; outerY = this.cardY + this.cardH; }
    if (edge === 'left')   { outerX = this.cardX; outerY = cy; }
    if (edge === 'right')  { outerX = this.cardX + this.cardW; outerY = cy; }

    // Build the slot path: start at one side of the hole's inner-semicircle
    // junction, draw a half-circle around the inner end, then straight out
    // to the outer edge, across, and back. Coordinates are expressed in a
    // local frame where +Y points toward the outer edge, then rotated.
    const cls = 'enc-hole enc-active'
              + (opts.primary ? ' enc-primary' : '')
              + (opts.companion ? ' enc-companion' : '')
              + (opts.selected ? ' enc-selected' : '');
    // Direction unit vectors per edge (outward normal of the card edge)
    const dir = ({
      top:    { nx: 0,  ny: -1 },
      bottom: { nx: 0,  ny:  1 },
      left:   { nx: -1, ny:  0 },
      right:  { nx: 1,  ny:  0 },
    })[edge];
    // Tangent (perpendicular to outward normal) — for the width of the slot
    const tx = -dir.ny;
    const ty =  dir.nx;
    // Inner-semicircle endpoints (perpendicular to slot direction)
    const ix1 = cx - tx * holeR;
    const iy1 = cy - ty * holeR;
    const ix2 = cx + tx * holeR;
    const iy2 = cy + ty * holeR;
    // Outer endpoints (at the card edge, ±holeR on the tangent)
    const ox1 = outerX - tx * holeR;
    const oy1 = outerY - ty * holeR;
    const ox2 = outerX + tx * holeR;
    const oy2 = outerY + ty * holeR;
    // sweep flag: pick the half-circle that bulges AWAY from the outer edge
    // (i.e. into the card body). With our normals, sweep=0 works.
    const d = [
      `M ${ix1} ${iy1}`,
      `A ${holeR} ${holeR} 0 0 0 ${ix2} ${iy2}`,
      `L ${ox2} ${oy2}`,
      `L ${ox1} ${oy1}`,
      'Z',
    ].join(' ');
    const path = el('path', { d, class: cls });
    if (opts.color) {
      path.style.fill = opts.color;
      path.style.stroke = opts.color;
      // Faint = a co-notched companion rather than the category's real code,
      // so it reads as secondary to the primary notch.
      if (opts.faint) { path.style.fillOpacity = '0.35'; path.style.strokeOpacity = '0.35'; }
    }
    return path;
  }

  _renderSlots() {
    this.slotNodes = {};  // { edge: { pos: <canonical-record> } }
    const holeR = Math.min(this.cardW / this.slotCounts.top,
                            this.cardH / this.slotCounts.left) * 0.32;
    const universal = this.universalNotches;
    this.holeR = holeR;

    // First pass: figure out the canonical (edge, pos) for each physical
    // hole. We render each canonical hole once; aliases (corner shares)
    // reuse the same DOM node.
    const canonicalKey = (e, p) => `${e}:${p}`;
    const rendered = new Map();  // canonicalKey → node record

    for (const edge of ['top', 'bottom', 'left', 'right']) {
      this.slotNodes[edge] = {};
      const count = this.slotCounts[edge];
      for (let pos = 1; pos <= count; pos++) {
        const canon = this._canonicalFor(edge, pos);
        const key = canonicalKey(canon.edge, canon.pos);

        // If we've already rendered this physical hole under another edge
        // (the corner case), just register the alias and skip the draw.
        if (rendered.has(key)) {
          this.slotNodes[edge][pos] = rendered.get(key);
          continue;
        }

        // First time we see this physical hole — draw it under the canonical
        // edge/pos.
        const isUniversal = (universal[canon.edge] || []).includes(canon.pos);
        const { cx, cy } = this._slotPosition(canon.edge, canon.pos);
        const shape = this._renderHoleShape(canon.edge, canon.pos, holeR, false);
        if (isUniversal) shape.classList.add('enc-universal');
        this.gSlots.appendChild(shape);

        // Hit area
        const hit = el('circle', {
          cx, cy,
          r: holeR * 1.5,
          class: 'enc-slot-hit',
        }, this.gSlots);
        hit.dataset.edge = canon.edge;
        hit.dataset.pos = String(canon.pos);

        const record = {
          shape, hit,
          canonEdge: canon.edge,
          canonPos: canon.pos,
          isUniversal,
          aliases: this._aliasesFor(canon.edge, canon.pos),
        };

        // Wire interaction. Hovering a slot activates ALL the (edge, pos)
        // aliases — so hovering a corner-hole highlights categories from
        // both adjacent edges.
        hit.addEventListener('mouseenter', () =>
          this._activateSlot(canon.edge, canon.pos, { source: 'hover' }));
        hit.addEventListener('mouseleave', () =>
          this._deactivate({ source: 'hover' }));
        hit.addEventListener('click', (ev) => {
          const info = this._slotInfo(canon.edge, canon.pos);
          this._emit('slotClick', { ...info, event: ev });
        });

        rendered.set(key, record);
        this.slotNodes[edge][pos] = record;
      }
    }
  }

  _renderLabels() {
    this.labelNodes = { top: [], bottom: [], left: [], right: [] };
    if (!this.showEdgeLabels) return;
    const cats = this.categoriesByEdge;

    // Edge titles
    const edgeTitles = {
      top:    'TOP — technical fields (2-of-N)',
      bottom: 'BOTTOM — geographic',
      right:  'RIGHT — surname letter',
      left:   'LEFT — unclassified',
    };
    el('text', {
      x: this.cardX + this.cardW / 2, y: this.gutters.top * 0.35,
      'text-anchor': 'middle', class: 'enc-edge-title',
    }, this.gLabels).textContent = edgeTitles.top;
    el('text', {
      x: this.cardX + this.cardW / 2, y: this.cardY + this.cardH + this.gutters.bottom - 6,
      'text-anchor': 'middle', class: 'enc-edge-title',
    }, this.gLabels).textContent = edgeTitles.bottom;
    el('text', {
      x: this.gutters.left * 0.35, y: this.cardY + this.cardH / 2,
      'text-anchor': 'middle', class: 'enc-edge-title',
      transform: `rotate(-90 ${this.gutters.left * 0.35} ${this.cardY + this.cardH / 2})`,
    }, this.gLabels).textContent = edgeTitles.left;
    el('text', {
      x: this.cardX + this.cardW + this.gutters.right - 12, y: this.cardY + this.cardH / 2,
      'text-anchor': 'middle', class: 'enc-edge-title',
      transform: `rotate(90 ${this.cardX + this.cardW + this.gutters.right - 12} ${this.cardY + this.cardH / 2})`,
    }, this.gLabels).textContent = edgeTitles.right;

    // Lay labels into evenly-spaced rows beside their edge
    this._layoutLabelEdge('top', cats.top);
    this._layoutLabelEdge('bottom', cats.bottom);
    this._layoutLabelEdge('left', cats.left);
    this._layoutLabelEdge('right', cats.right);
  }

  _layoutLabelEdge(edge, categories) {
    if (!categories || categories.length === 0) return;
    const lineH = 14;
    const start = (edge === 'top' || edge === 'bottom')
      ? this.cardX
      : this.cardY;
    const span = (edge === 'top' || edge === 'bottom')
      ? this.cardW
      : this.cardH;
    const step = span / categories.length;

    categories.forEach((cat, i) => {
      const along = start + step * (i + 0.5);
      let labelX, labelY, textAnchor, rotate = 0;
      // Top/bottom: render labels VERTICALLY (perpendicular to the edge) so
      // many labels can sit side-by-side without overlapping.
      if (edge === 'top') {
        labelX = along;
        labelY = this.cardY - 10;
        textAnchor = 'start';   // text starts away from card, grows up
        rotate = -90;           // reads bottom-to-top
      } else if (edge === 'bottom') {
        labelX = along;
        labelY = this.cardY + this.cardH + 10;
        textAnchor = 'start';   // text starts at card, grows down
        rotate = 90;            // reads top-to-bottom
      } else if (edge === 'left') {
        labelX = this.cardX - 8;
        labelY = along;
        textAnchor = 'end';
      } else {
        labelX = this.cardX + this.cardW + 8;
        labelY = along;
        textAnchor = 'start';
      }

      // Confidence-based class so the viz can de-emphasize low/anecdotal
      // findings without hiding them.
      const confidence = cat.meta && cat.meta.confidence;
      const confidenceClass = confidence ? ` enc-conf-${confidence}` : '';
      const g = el('g', { class: 'enc-label-group' + confidenceClass }, this.gLabels);
      g.dataset.edge = edge;
      g.dataset.name = cat.name;
      if (confidence) g.dataset.confidence = confidence;
      g.style.cursor = 'pointer';

      // The text node — we render first to measure, then add a bg underneath.
      const t = el('text', {
        x: labelX, y: labelY,
        'text-anchor': textAnchor,
        'dominant-baseline': 'middle',
        class: 'enc-label',
        transform: rotate ? `rotate(${rotate} ${labelX} ${labelY})` : null,
      }, g);
      t.textContent = cat.name;

      // Tooltip with extra context. For bottom-edge geo we surface n, recall,
      // and confidence so users can see *why* a state's label is dim.
      const tt = el('title', {}, g);
      let tooltip = cat.fullName ? `${cat.fullName} · positions ${cat.positions.join(', ')}` : null;
      if (cat.meta && cat.meta.kind === 'geo' && cat.meta.primary) {
        const m = cat.meta;
        tooltip = `${cat.name} (n=${m.n}, ${m.confidence || 'unknown'} confidence)`
                + `\n  primary pos ${m.primary.pos} @ ${(m.primary.recall * 100).toFixed(1)}% recall`;
        if (cat.companionPositions && cat.companionPositions.length) {
          tooltip += `\n  companions: pos ${cat.companionPositions.join(', pos ')}`;
        }
      } else if (!tooltip) {
        tooltip = `${cat.name} · positions ${cat.positions.join(', ')}`;
      }
      tt.textContent = tooltip;

      g.addEventListener('mouseenter', () => this._activateCategory(edge, cat.name, { source: 'hover' }));
      g.addEventListener('mouseleave', () => this._deactivate({ source: 'hover' }));
      g.addEventListener('click', (ev) => {
        const info = this._categoryInfo(edge, cat.name);
        this._emit('categoryClick', { ...info, event: ev });
      });

      this.labelNodes[edge].push({ group: g, text: t, cat, anchor: { x: labelX, y: labelY } });
    });
  }

  // --- Internal: activation / lookup -------------------------------------

  _findCategory(edge, name) {
    const list = this.categoriesByEdge[edge] || [];
    return list.find((c) => c.name === name) || null;
  }

  _categoryInfo(edge, name) {
    const cat = this._findCategory(edge, name);
    if (!cat) return { edge, name, positions: [], meta: null };
    return {
      edge, name,
      positions: cat.positions.slice(),
      primaryPos: cat.primaryPos ?? null,
      companionPositions: cat.companionPositions ? cat.companionPositions.slice() : [],
      meta: cat.meta,
    };
  }

  _slotInfo(edge, pos) {
    // Which categories involve this slot — checked across ALL edges this
    // physical hole is part of (so corners report categories from both
    // adjacent edges).
    const aliases = this._aliasesFor(edge, pos);
    const seen = new Set();
    const cats = [];
    for (const a of aliases) {
      for (const c of (this.categoriesByEdge[a.edge] || [])) {
        if (!c.positions.includes(a.pos)) continue;
        const key = a.edge + '' + c.name;
        if (seen.has(key)) continue;
        seen.add(key);
        cats.push({ edge: a.edge, name: c.name, positions: c.positions.slice(), meta: c.meta });
      }
    }
    return { edge, pos, aliases, categories: cats };
  }

  _activateCategory(edge, name, { source }) {
    const cat = this._findCategory(edge, name);
    if (!cat) return;
    this._clearActiveDom();
    this.activeHighlight = { type: 'category', edge, key: name };

    // Light up the label
    for (const ln of this.labelNodes[edge]) {
      if (ln.cat.name === name) ln.group.classList.add('enc-active');
      else ln.group.classList.add('enc-dim');
    }
    // Dim other edges' labels
    for (const e of ['top', 'bottom', 'left', 'right']) {
      if (e === edge) continue;
      for (const ln of this.labelNodes[e]) ln.group.classList.add('enc-dim');
    }
    const anchor = this._labelAnchor(edge, name);

    // Render each position as its own notch. For bottom-edge geo we
    // distinguish the PRIMARY (the actual one-needle code) from companions
    // by class — the primary gets a highlighted color so the user can tell
    // which notch IS the encoding vs which positions just co-occur.
    const primaryPos = (typeof cat.primaryPos === 'number') ? cat.primaryPos : null;
    for (const pos of cat.positions) {
      const isPrimary = (primaryPos !== null) && (pos === primaryPos);
      this._setSlotNotched(edge, pos, true, { primary: isPrimary });
      if (anchor) this._drawConnector(edge, pos, anchor, { primary: isPrimary });
    }
    this._emit('categoryHover', this._categoryInfo(edge, name));
  }

  _activateSlot(edge, pos, { source }) {
    this._clearActiveDom();
    this.activeHighlight = { type: 'slot', edge, key: pos };

    const node = this.slotNodes[edge]?.[pos];
    if (!node) return;
    // Find any categories on this edge that include this position
    const matchingCats = (this.categoriesByEdge[edge] || [])
      .filter((c) => c.positions.includes(pos));

    const info = this._slotInfo(edge, pos);

    if (this.highlightCompanions) {
      // Color holes by their position GROUP so each category's partners are
      // visually distinct and match the colored entry in the hover panel.
      // Categories sharing the exact same holes share a color. The hovered
      // hole itself is painted last as a neutral notch so it always reads as
      // "the hole you're on" regardless of how many groups include it.
      const sigColor = new Map();
      let ci = 0;
      for (const c of info.categories) {
        const sig = c.positions.slice().sort((a, b) => a - b).join(',');
        if (!sigColor.has(sig)) {
          sigColor.set(sig, COMPANION_PALETTE[ci++ % COMPANION_PALETTE.length]);
        }
        c.color = sigColor.get(sig);
      }
      for (const c of info.categories) {
        // For bottom-edge states, only the PRIMARY position is the real
        // one-needle code; the rest are co-notched companions (often noise at
        // low sample size), so render them faint.
        const primaryPos = (c.meta && c.meta.kind === 'geo' && c.meta.primary)
          ? c.meta.primary.pos : null;
        for (const p of c.positions) {
          if (c.edge === edge && p === pos) continue;  // hovered hole drawn last
          const faint = (primaryPos !== null) && (p !== primaryPos);
          this._setSlotNotched(c.edge, p, true, { color: c.color, faint });
        }
      }
      this._setSlotNotched(edge, pos, true);
    } else {
      // Single active notch for the hovered hole plus every position in any
      // matching category (so a pair shows together).
      const allPositions = new Set([pos]);
      for (const c of matchingCats) for (const p of c.positions) allPositions.add(p);
      for (const p of allPositions) this._setSlotNotched(edge, p, true);
    }

    // Highlight + dim labels (only present when showEdgeLabels)
    const matchingNames = new Set(matchingCats.map((c) => c.name));
    for (const e of ['top', 'bottom', 'left', 'right']) {
      for (const ln of this.labelNodes[e]) {
        if (e === edge && matchingNames.has(ln.cat.name)) ln.group.classList.add('enc-active');
        else ln.group.classList.add('enc-dim');
      }
    }
    for (const c of matchingCats) {
      const anchor = this._labelAnchor(edge, c.name);
      if (!anchor) continue;
      for (const p of c.positions) this._drawConnector(edge, p, anchor);
    }
    this._emit('slotHover', info);
  }

  _deactivate({ source }) {
    if (!this.activeHighlight) return;
    const prev = this.activeHighlight;
    this._clearActiveDom();
    this.activeHighlight = null;
    if (prev.type === 'category') this._emit('categoryHover', null);
    else this._emit('slotHover', null);
  }

  _clearActiveDom() {
    // Reset all labels
    for (const e of ['top', 'bottom', 'left', 'right']) {
      for (const ln of this.labelNodes[e]) {
        ln.group.classList.remove('enc-active');
        ln.group.classList.remove('enc-dim');
      }
    }
    // Reset all slots back to default. Dedupe via canonical so corner-shared
    // holes are reset only once.
    const seen = new Set();
    for (const e of ['top', 'bottom', 'left', 'right']) {
      for (const pos in this.slotNodes[e]) {
        const node = this.slotNodes[e][pos];
        const key = node.canonEdge + ':' + node.canonPos;
        if (seen.has(key)) continue;
        seen.add(key);
        this._setSlotNotched(e, Number(pos), false);
      }
    }
    // Re-apply persistent selection so it survives the reset.
    this._applySelected();
    // Remove connector lines
    while (this.gLines.firstChild) this.gLines.removeChild(this.gLines.firstChild);
  }

  _applySelected() {
    for (const key of this.selectedNotches) {
      const [e, p] = key.split(':');
      this._setSlotNotched(e, Number(p), true, { selected: true });
    }
  }

  _setSlotNotched(edge, pos, notched, opts = {}) {
    const node = this.slotNodes[edge]?.[pos];
    if (!node) return;
    // Always re-render under the canonical edge so the notch cuts toward the
    // correct outer edge (matters at corners, where two edges share the hole).
    const newShape = this._renderHoleShape(node.canonEdge, node.canonPos, this.holeR, notched, opts);
    if (node.isUniversal && !notched) newShape.classList.add('enc-universal');
    node.shape.replaceWith(newShape);
    node.shape = newShape;
  }

  _labelAnchor(edge, name) {
    for (const ln of this.labelNodes[edge] || []) {
      if (ln.cat.name === name) return ln.anchor;
    }
    return null;
  }

  _drawConnector(edge, pos, anchor, opts = {}) {
    const { cx, cy } = this._slotPosition(edge, pos);
    // Connector goes from the slot center to a point just *outside* the
    // notch opening, then sweeps toward the label anchor. The endpoint
    // lands at the label anchor (the rotation pivot of the label text),
    // which is at the card's edge — so lines never cross label text.
    let cx1, cy1, cx2, cy2, endX, endY;
    if (edge === 'top') {
      endX = anchor.x; endY = anchor.y;
      cx1 = cx;       cy1 = cy - 24;
      cx2 = endX;     cy2 = endY + 14;
    } else if (edge === 'bottom') {
      endX = anchor.x; endY = anchor.y;
      cx1 = cx;       cy1 = cy + 24;
      cx2 = endX;     cy2 = endY - 14;
    } else if (edge === 'left') {
      endX = anchor.x; endY = anchor.y;
      cx1 = cx - 24;  cy1 = cy;
      cx2 = endX + 14; cy2 = endY;
    } else {
      endX = anchor.x; endY = anchor.y;
      cx1 = cx + 24;  cy1 = cy;
      cx2 = endX - 14; cy2 = endY;
    }
    const d = `M ${cx} ${cy} C ${cx1} ${cy1}, ${cx2} ${cy2}, ${endX} ${endY}`;
    const cls = 'enc-line enc-active' + (opts.primary ? ' enc-primary' : '');
    const path = el('path', { d, class: cls }, this.gLines);
    return path;
  }

  // --- Internal: events ---------------------------------------------------

  _emit(event, payload) {
    const arr = this.listeners[event];
    if (!arr) return;
    for (const fn of arr) {
      try { fn(payload); } catch (e) { console.error('EdgeNotchCard listener error:', e); }
    }
  }
}

// UMD-ish export
if (typeof module !== 'undefined' && module.exports) {
  module.exports = EdgeNotchCard;
} else if (typeof window !== 'undefined') {
  window.EdgeNotchCard = EdgeNotchCard;
}
