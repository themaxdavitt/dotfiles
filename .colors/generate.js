#!/bin/sh
":"; // 2>/dev/null; exec mise x deno@2 -- deno run --quiet --allow-read --allow-net=web.archive.org --allow-write="$(dirname "$1")" --allow-env=NODE_ENV --minimum-dependency-age=2026-07-25T14:28:32Z "$0" "$@"
// 2026 color scheme — computes the palette the ghostty and Zed theme templates render.
//
// Base24 scheme built in OkLCh: neutrals on a fixed lightness ramp, an eight-hue
// accent ring rotated to best fit xkcd's colour-survey names, and bright/dim rows
// derived from it. Every slot pair is checked against APCA readability floors and
// generation THROWS rather than emitting an unreadable scheme.
//
// Usage: generate.js <xkcd-cache-path>   # prints the palette as JSON on stdout
//
// Deliberately one file, and repo tooling rather than a dotfile: chezmoi skips
// dot-prefixed source dirs, so this is never deployed. The upstream design tool
// (~/Projects/2026-color-scheme-js) keeps the exporters this machine does not use —
// base24 YAML, an HTML preview, and the canonical/contrast JSON reports.
import Color from "npm:colorjs.io@0.6.1";

// --- xkcd colour-survey data -------------------------------------------------
// Pinned to an immutable Wayback snapshot and checksummed, so the accent ring can
// never shift under us because xkcd.com changed or the archive served something
// unexpected. Cached locally so a regeneration works offline.
const XKCD_URL = "https://web.archive.org/web/20260702175112id_/https://xkcd.com/color/rgb.txt";
const XKCD_SHA256 = "450cca88fa6fa9a1e79c969969e05e6900b41a94f0a3a5f134e3d0b79077f890";

async function sha256Hex(bytes) {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function fetchXkcdRgb(cachePath) {
  try {
    const cached = await Deno.readFile(cachePath);
    if ((await sha256Hex(cached)) === XKCD_SHA256) return new TextDecoder().decode(cached);
  } catch {
    // No usable cache; fall through to the network.
  }

  const response = await fetch(XKCD_URL);
  if (!response.ok) {
    throw new Error(`xkcd data: ${response.status} ${response.statusText} from ${XKCD_URL}`);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());

  const digest = await sha256Hex(bytes);
  if (digest !== XKCD_SHA256) {
    throw new Error(
      `xkcd data: checksum mismatch\n  expected ${XKCD_SHA256}\n  got      ${digest}`,
    );
  }

  await Deno.mkdir(dirnameOf(cachePath), { recursive: true });
  await Deno.writeFile(cachePath, bytes);
  return new TextDecoder().decode(bytes);
}

function dirnameOf(path) {
  const i = path.lastIndexOf("/");
  return i <= 0 ? "/" : path.slice(0, i);
}

function parseXkcdColors(text) {
  const colors = {};
  for (const line of text.split("\n")) {
    if (!line || line.startsWith("#")) continue;
    const parts = line.split("\t");
    if (parts.length < 2) continue;
    colors[parts[0].trim()] = parts[1].trim();
  }
  return colors;
}

function xkcdTargetHues(text, targetNames) {
  const colors = parseXkcdColors(text);
  const missing = targetNames.filter((name) => !(name in colors));
  if (missing.length > 0) throw new Error(`Missing xkcd color names: ${missing.join(", ")}`);
  const hues = {};
  for (const name of targetNames) {
    const oklch = new Color(colors[name]).to("oklch");
    hues[name] = ((oklch.coords[2] % 360) + 360) % 360;
  }
  return hues;
}

// --- slot vocabulary ---------------------------------------------------------
const NEUTRAL_SLOTS = [
  "base00",
  "base01",
  "base02",
  "base03",
  "base04",
  "base05",
  "base06",
  "base07",
  "base10",
  "base11",
];

const ACCENT_SLOTS = [
  "base08",
  "base09",
  "base0A",
  "base0B",
  "base0C",
  "base0D",
  "base0E",
  "base0F",
];

const ACCENT_TARGET_NAMES = {
  base08: "red",
  base09: "orange",
  base0A: "yellow",
  base0B: "green",
  base0C: "cyan",
  base0D: "blue",
  base0E: "purple",
  base0F: "magenta",
};

const BRIGHT_SOURCE_SLOTS = {
  base12: "base08",
  base13: "base0A",
  base14: "base0B",
  base15: "base0C",
  base16: "base0D",
  base17: "base0E",
};

const DIM_SOURCE_SLOTS = {
  base18: "base08",
  base19: "base0A",
  base1A: "base0B",
  base1B: "base0C",
  base1C: "base0D",
  base1D: "base0E",
};

const ROLE_DESCRIPTIONS = {
  base00: "Default background",
  base01: "Elevated background, gutter, current line",
  base02: "Selection background",
  base03: "Comments, invisibles, inactive text",
  base04: "Secondary foreground and menu text",
  base05: "Default foreground, caret, delimiters, operators",
  base06: "Emphasized foreground",
  base07: "Strongest foreground",
  base08: "Red: variables, tags, errors, diff deleted",
  base09: "Orange: constants, booleans, attributes",
  base0A: "Yellow: classes, search text, markup bold",
  base0B: "Green: strings, inherited classes, diff inserted",
  base0C: "Cyan: support, regex, escape characters",
  base0D: "Blue: functions, methods, headings, focus",
  base0E: "Purple: keywords, selectors, markup italic",
  base0F: "Warning / dark-red-brown role, generated as ring-pure magenta",
  base10: "Background darker/lighter extension",
  base11: "Extreme background extension",
  base12: "Bright red",
  base13: "Bright yellow",
  base14: "Bright green",
  base15: "Bright cyan",
  base16: "Bright blue",
  base17: "Bright purple",
  base18: "Dim red",
  base19: "Dim yellow",
  base1A: "Dim green",
  base1B: "Dim cyan",
  base1C: "Dim blue",
  base1D: "Dim purple",
};

const PROFILE_FLOORS = {
  public: {
    body: 90.0,
    syntax: 75.0,
    support: 60.0,
    dim: 30.0,
    spot: 45.0,
    non_text: 15.0,
  },
};

const LIGHTNESS_CONFIGS = {
  "public/dark": {
    neutral: {
      base11: 0.0,
      base10: 0.2,
      base00: 0.26,
      base01: 0.29,
      base02: 0.59,
      base03: 0.78,
      base04: 0.86,
      base05: 0.94,
      base06: 0.97,
      base07: 1.0,
    },
    accent_l: 0.875,
    bright_l: 0.75,
  },
};

// Standard ANSI 16-color palette mapping from Base24 slots.
// Indices 8-15 use the dedicated Base24 bright variants (base12-base17).
const ANSI_PALETTE = [
  "base00", // 0  black
  "base08", // 1  red
  "base0B", // 2  green
  "base0A", // 3  yellow
  "base0D", // 4  blue
  "base0E", // 5  magenta
  "base0C", // 6  cyan
  "base05", // 7  white
  "base03", // 8  bright black
  "base12", // 9  bright red
  "base14", // 10 bright green
  "base13", // 11 bright yellow
  "base16", // 12 bright blue
  "base17", // 13 bright magenta
  "base15", // 14 bright cyan
  "base07", // 15 bright white
];

// --- colour math -------------------------------------------------------------
function maxChroma(L, H, iterations = 34) {
  if (L <= 0 || L >= 1) return 0;
  let low = 0;
  let high = 0.4;
  while (high < 2.0 && new Color("oklch", [L, high, H % 360]).to("srgb").inGamut()) {
    low = high;
    high *= 2;
  }
  for (let i = 0; i < iterations; i++) {
    const mid = (low + high) / 2;
    if (new Color("oklch", [L, mid, H % 360]).to("srgb").inGamut()) low = mid;
    else high = mid;
  }
  return low;
}

function maxUniformChroma(L, hues) {
  return Math.min(...hues.map((H) => maxChroma(L, H)));
}

function blendHex(fgHex, bgHex, alpha) {
  const blend = (fg, bg) => Math.round(parseInt(fg, 16) * alpha + parseInt(bg, 16) * (1 - alpha));
  const r = blend(fgHex.slice(1, 3), bgHex.slice(1, 3));
  const g = blend(fgHex.slice(3, 5), bgHex.slice(3, 5));
  const b = blend(fgHex.slice(5, 7), bgHex.slice(5, 7));
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

function makeSlotFromHex(slot, role, hex) {
  const r = parseInt(hex.slice(1, 3), 16) / 255;
  const g = parseInt(hex.slice(3, 5), 16) / 255;
  const b = parseInt(hex.slice(5, 7), 16) / 255;
  const oklch = new Color("srgb", [r, g, b]).to("oklch");
  const [L, C, H] = oklch.coords.map(Number);
  return {
    slot,
    role,
    oklch: { L, C: C ?? 0, H: isNaN(H) || H == null ? 0 : H },
    srgb: { r, g, b },
    hex,
  };
}

function makeSlot(slot, role, L, C, H) {
  const hue = ((H % 360) + 360) % 360;
  const srgb = new Color("oklch", [L, C, hue]).to("srgb");
  if (!srgb.inGamut("srgb", { epsilon: 2e-4 })) {
    throw new Error(`${slot} is outside sRGB gamut: oklch(${L}, ${C}, ${hue})`);
  }
  const [r, g, b] = srgb.coords.map((ch) => Math.max(0, Math.min(1, Number(ch))));
  const hex =
    "#" +
    [r, g, b]
      .map((ch) =>
        Math.round(ch * 255)
          .toString(16)
          .padStart(2, "0"),
      )
      .join("");
  return { slot, role, oklch: { L, C, H: hue }, srgb: { r, g, b }, hex };
}

// --- readability (APCA via colorjs.io) ---------------------------------------
function pairResult(name, fgSlot, bgSlot, floor) {
  const lc = Color.contrastAPCA(new Color(bgSlot.hex), new Color(fgSlot.hex));
  const abs_lc = Math.abs(lc);
  return {
    name,
    foreground: fgSlot.slot,
    background: bgSlot.slot,
    floor,
    lc: Math.round(lc * 1000) / 1000,
    abs_lc: Math.round(abs_lc * 1000) / 1000,
    passed: abs_lc + 1e-9 >= floor,
  };
}

function requiredPairSpecs(profile) {
  const floors = PROFILE_FLOORS[profile];
  const specs = [
    ["body", "base05", "base00", floors.body],
    ["current_line", "base05", "base01", floors.body],
    ["comments", "base03", "base00", floors.support],
    ["menu", "base04", "base00", floors.support],
    ["selection_foreground", "base05", "base02", floors.support],
    ["selection_emphasis", "base06", "base02", floors.support],
    ["focus_label", "base00", "base0D", floors.spot],
    ["urgent_label", "base00", "base08", floors.spot],
  ];
  for (const slot of ACCENT_SLOTS) {
    specs.push([`syntax_${slot}_normal`, slot, "base00", floors.syntax]);
    specs.push([`syntax_${slot}_elevated`, slot, "base01", floors.syntax]);
  }
  for (const slot of Object.keys(BRIGHT_SOURCE_SLOTS)) {
    specs.push([`bright_${slot}_normal`, slot, "base00", floors.support]);
  }
  for (const slot of Object.keys(DIM_SOURCE_SLOTS)) {
    specs.push([`dim_${slot}_normal`, slot, "base00", floors.dim]);
  }
  return specs;
}

function requiredPairResults(slots, profile) {
  return requiredPairSpecs(profile).map(([name, fg, bg, floor]) =>
    pairResult(name, slots[fg], slots[bg], floor),
  );
}

function assertRequiredPairsPass(results) {
  const failures = results.filter((r) => !r.passed);
  if (failures.length > 0) {
    const summary = failures
      .map(
        (r) =>
          `${r.name} ${r.foreground}/${r.background}=${r.abs_lc.toFixed(2)}<${r.floor.toFixed(2)}`,
      )
      .join(", ");
    throw new Error(`Required readability pairs failed: ${summary}`);
  }
}

// --- scheme construction -----------------------------------------------------
const DEFAULT_SCHEME_NAME = "2026 Color Scheme";
const DEFAULT_SLUG = "2026-color-scheme";
const DEFAULT_AUTHOR = "Generated by 2026-color-scheme";

function hueRing(rotation) {
  return Array.from({ length: ACCENT_SLOTS.length }, (_, i) => (rotation + i * 45) % 360);
}

function hueDelta(a, b) {
  return Math.abs(((a - b + 180) % 360) - 180);
}

// Takes the xkcd hue map rather than loading it, so fetching stays at the edge and
// the search itself is pure.
function optimizeHueRotation(targetHuesByName, rotationStep = 0.5) {
  if (rotationStep <= 0) throw new Error("rotationStep must be positive");
  const targetNames = ACCENT_SLOTS.map((slot) => ACCENT_TARGET_NAMES[slot]);
  const targetHues = targetNames.map((name) => targetHuesByName[name]);

  let bestRotation = 0;
  let bestScore = Infinity;
  for (let rotation = 0; rotation < 360; rotation += rotationStep) {
    const hues = hueRing(rotation);
    let sumSq = 0;
    for (let i = 0; i < hues.length; i++) sumSq += hueDelta(hues[i], targetHues[i]) ** 2;
    const rms = Math.sqrt(sumSq / hues.length);
    if (rms < bestScore) {
      bestScore = rms;
      bestRotation = rotation;
    }
  }
  return [bestRotation % 360, bestScore];
}

function candidateLightnesses(start, mode) {
  const step = 0.01;
  const candidates = [];
  if (mode === "dark") {
    const count = Math.round((0.99 - start) / step) + 1;
    for (let i = 0; i < Math.max(1, count); i++)
      candidates.push(+Math.min(0.99, start + i * step).toFixed(4));
  } else {
    const count = Math.round((start - 0.01) / step) + 1;
    for (let i = 0; i < Math.max(1, count); i++)
      candidates.push(+Math.max(0.01, start - i * step).toFixed(4));
  }
  return candidates;
}

function accentPairResults(profile, slots) {
  const floors = PROFILE_FLOORS[profile];
  const results = [];
  for (const slot of ACCENT_SLOTS) {
    results.push(pairResult(`syntax_${slot}_normal`, slots[slot], slots["base00"], floors.syntax));
    results.push(
      pairResult(`syntax_${slot}_elevated`, slots[slot], slots["base01"], floors.syntax),
    );
  }
  results.push(pairResult("focus_label", slots["base00"], slots["base0D"], floors.spot));
  results.push(pairResult("urgent_label", slots["base00"], slots["base08"], floors.spot));
  return results;
}

function buildAccentSlots(profile, mode, neutralSlots, hues, startL, chromaSafety) {
  for (const candidateL of candidateLightnesses(startL, mode)) {
    const maxC = maxUniformChroma(candidateL, hues);
    for (let idx = 0; idx <= 50; idx++) {
      const scale = chromaSafety * 0.98 ** idx;
      const candidateC = maxC * scale;
      if (candidateC < 0.002) break;
      const slots = { ...neutralSlots };
      for (let i = 0; i < ACCENT_SLOTS.length; i++) {
        slots[ACCENT_SLOTS[i]] = makeSlot(
          ACCENT_SLOTS[i],
          ROLE_DESCRIPTIONS[ACCENT_SLOTS[i]],
          candidateL,
          candidateC,
          hues[i],
        );
      }
      if (accentPairResults(profile, slots).every((r) => r.passed)) {
        const accentSlots = Object.fromEntries(ACCENT_SLOTS.map((s) => [s, slots[s]]));
        return [accentSlots, candidateL, candidateC];
      }
    }
  }
  throw new Error(`Could not find readable accent ring for ${profile}/${mode}`);
}

function candidateBrightLightnesses(startL) {
  const step = 0.005;
  const candidates = [];
  const count = Math.round((0.99 - startL) / step) + 1;
  for (let i = 0; i < Math.max(1, count); i++)
    candidates.push(+Math.min(0.99, startL + i * step).toFixed(4));
  return candidates;
}

function buildBrightSlots(profile, mode, neutralSlots, accentSlots, startL, chromaSafety) {
  const floors = PROFILE_FLOORS[profile];
  for (const candidateL of candidateBrightLightnesses(startL)) {
    const brightSlots = Object.fromEntries(
      Object.entries(BRIGHT_SOURCE_SLOTS).map(([brightSlot, sourceSlot]) => {
        const hue = accentSlots[sourceSlot].oklch.H;
        return [
          brightSlot,
          makeSlot(
            brightSlot,
            ROLE_DESCRIPTIONS[brightSlot],
            candidateL,
            maxChroma(candidateL, hue) * chromaSafety,
            hue,
          ),
        ];
      }),
    );
    const slots = { ...neutralSlots, ...accentSlots, ...brightSlots };
    if (
      Object.keys(BRIGHT_SOURCE_SLOTS).every(
        (slot) =>
          pairResult(`bright_${slot}_normal`, slots[slot], slots["base00"], floors.support).passed,
      )
    )
      return [brightSlots, candidateL];
  }
  throw new Error(`Could not find readable bright row for ${profile}/${mode}`);
}

function buildDimSlots(neutralSlots, accentSlots) {
  const bgHex = neutralSlots["base00"].hex;
  return Object.fromEntries(
    Object.entries(DIM_SOURCE_SLOTS).map(([dimSlot, sourceSlot]) => {
      const hex = blendHex(accentSlots[sourceSlot].hex, bgHex, 0.5);
      return [dimSlot, makeSlotFromHex(dimSlot, ROLE_DESCRIPTIONS[dimSlot], hex)];
    }),
  );
}

function buildNeutralSlots(profile, mode) {
  const config = LIGHTNESS_CONFIGS[`${profile}/${mode}`].neutral;
  return Object.fromEntries(
    NEUTRAL_SLOTS.map((slot) => [
      slot,
      makeSlot(slot, ROLE_DESCRIPTIONS[slot], config[slot], 0, 0),
    ]),
  );
}

function generateScheme({
  targetHues,
  profile = "public",
  mode = "dark",
  schemeName = DEFAULT_SCHEME_NAME,
  slug = DEFAULT_SLUG,
  author = DEFAULT_AUTHOR,
  hueRotation = null,
  rotationStep = 0.5,
  chromaSafety = 0.92,
} = {}) {
  if (!(profile in PROFILE_FLOORS)) throw new Error(`Unknown profile: ${profile}`);
  if (mode !== "dark" && mode !== "light") throw new Error(`Unknown mode: ${mode}`);
  const configKey = `${profile}/${mode}`;
  if (!(configKey in LIGHTNESS_CONFIGS)) throw new Error(`No config for ${configKey}`);
  if (chromaSafety <= 0 || chromaSafety > 1) throw new Error("chromaSafety must be in (0, 1]");

  if (hueRotation === null) [hueRotation] = optimizeHueRotation(targetHues, rotationStep);

  const config = LIGHTNESS_CONFIGS[configKey];
  const hues = hueRing(hueRotation);
  const neutralSlots = buildNeutralSlots(profile, mode);
  const [accentSlots, accentL, accentC] = buildAccentSlots(
    profile,
    mode,
    neutralSlots,
    hues,
    config.accent_l,
    chromaSafety,
  );
  const [brightSlots, brightL] = buildBrightSlots(
    profile,
    mode,
    neutralSlots,
    accentSlots,
    config.bright_l,
    chromaSafety,
  );
  const dimSlots = buildDimSlots(neutralSlots, accentSlots);
  const slots = { ...neutralSlots, ...accentSlots, ...brightSlots, ...dimSlots };
  const requiredPairs = requiredPairResults(slots, profile);
  assertRequiredPairsPass(requiredPairs);

  return {
    name: schemeName,
    slug,
    author,
    profile,
    mode,
    hueRotation,
    chromaSafety,
    accentL,
    accentC,
    brightL,
    dimAlpha: 0.5,
    slots,
    requiredPairs,
    outputStem: `${slug}-${profile}-${mode}`,
    displayName: `${schemeName} ${profile[0].toUpperCase()}${profile.slice(1)} ${mode[0].toUpperCase()}${mode.slice(1)}`,
  };
}

// --- palette emission --------------------------------------------------------
// The only output: a JSON palette on stdout. Deliberately says nothing about any
// consuming application — it exposes the Base24 slot vocabulary and the standard
// Base24→ANSI mapping, and stops there. Semantic naming ("surface", "comment",
// which player cursor gets which hue) belongs to whichever template renders it,
// so a new consumer never needs a field added here. Everything colour-derived is
// resolved on this side, including the alpha-blended dim row; templates only
// interpolate, and append a literal two-hex alpha suffix where they need one.
function palette(scheme) {
  const hex = (slot) => scheme.slots[slot].hex;
  return {
    name: scheme.name,
    displayName: scheme.displayName,
    author: scheme.author,
    appearance: scheme.mode,
    slots: Object.fromEntries(Object.keys(scheme.slots).map((s) => [s, hex(s)])),
    ansi: ANSI_PALETTE.map(hex),
  };
}

// --- entry point -------------------------------------------------------------
const [xkcdCachePath] = Deno.args;
if (!xkcdCachePath) {
  console.error("usage: generate.js <xkcd-cache-path>   # prints the palette as JSON");
  Deno.exit(2);
}

const targetNames = ACCENT_SLOTS.map((slot) => ACCENT_TARGET_NAMES[slot]);
const targetHues = xkcdTargetHues(await fetchXkcdRgb(xkcdCachePath), targetNames);
console.log(JSON.stringify(palette(generateScheme({ targetHues })), null, 2));
