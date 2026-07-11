// iPad model table. Physical sizes are the SCREEN active-display area (not the
// device body) in mm, given in PORTRAIT (w < h) — that's what a to-scale video
// wall needs. `native` is the native pixel resolution in portrait (w x h).
// Screen mm are computed from the quoted display diagonal at 4:3 (older iPads);
// approximate but good for calibration and user-correctable.
var MODELS = [
  { key: 'ipad-2',       name: 'iPad 2 (9.7")',          native: { w: 768,  h: 1024 }, screenMm: { w: 147.8, h: 197.1 } },
  { key: 'ipad-mini-2',  name: 'iPad mini 2 / 3 (7.9")', native: { w: 1536, h: 2048 }, screenMm: { w: 120.4, h: 160.5 } },
  { key: 'ipad-mini-4',  name: 'iPad mini 4 / 5 (7.9")', native: { w: 1536, h: 2048 }, screenMm: { w: 120.4, h: 160.5 } },
  { key: 'ipad-97',      name: 'iPad / Air / Pro 9.7"',  native: { w: 1536, h: 2048 }, screenMm: { w: 147.8, h: 197.1 } },
  { key: 'ipad-102',     name: 'iPad 10.2" (7–9 gen)',   native: { w: 1620, h: 2160 }, screenMm: { w: 155.4, h: 207.3 } },
  { key: 'ipad-air-105', name: 'iPad Air / Pro 10.5"',   native: { w: 1668, h: 2224 }, screenMm: { w: 160.0, h: 213.4 } },
  { key: 'ipad-mini-6',  name: 'iPad mini 6 (8.3")',     native: { w: 1488, h: 2266 }, screenMm: { w: 124.2, h: 189.2 } },
  { key: 'ipad-109',     name: 'iPad 10.9" / Air 4/5',   native: { w: 1640, h: 2360 }, screenMm: { w: 161.5, h: 232.4 } },
  { key: 'ipad-pro-11',  name: 'iPad Pro 11"',           native: { w: 1668, h: 2388 }, screenMm: { w: 159.0, h: 230.0 } },
  { key: 'ipad-pro-129', name: 'iPad Pro 12.9"',         native: { w: 2048, h: 2732 }, screenMm: { w: 196.0, h: 262.0 } }
];

// Default pick when a native resolution matches several models (the 2048x1536
// family is ambiguous: mini vs 9.7"). We default to the mini — the user's stated
// device — and let them correct it in the admin.
var AMBIGUOUS_DEFAULT = { '1536x2048': 'ipad-mini-2' };

function byKey(key) {
  for (var i = 0; i < MODELS.length; i++) { if (MODELS[i].key === key) { return MODELS[i]; } }
  return null;
}

// Guess a model from a reported native resolution (any orientation).
function guess(px1, px2) {
  var a = Math.min(px1, px2), b = Math.max(px1, px2);
  var tag = a + 'x' + b;
  if (AMBIGUOUS_DEFAULT[tag]) { return AMBIGUOUS_DEFAULT[tag]; }
  for (var i = 0; i < MODELS.length; i++) {
    var m = MODELS[i];
    if (m.native.w === a && m.native.h === b) { return m.key; }
  }
  return null;
}

// Effective screen size (mm) for a model in a given orientation.
function screenMm(key, orientation) {
  var m = byKey(key);
  if (!m) { return null; }
  if (orientation === 'landscape') { return { w: m.screenMm.h, h: m.screenMm.w }; }
  return { w: m.screenMm.w, h: m.screenMm.h };
}

module.exports = { MODELS: MODELS, byKey: byKey, guess: guess, screenMm: screenMm };
