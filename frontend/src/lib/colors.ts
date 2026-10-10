export type RGB = [number, number, number];

export function hexToRgb(hex: string): RGB {
  const h = hex.replace("#", "").trim();
  const full = h.length === 3 ? h.split("").map((c) => c + c).join("") : h;
  const n = parseInt(full, 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255];
}

/** three.js treats vertex colours as linear; convert sRGB hex values before mixing. */
export function toLinear([r, g, b]: RGB): RGB {
  const f = (c: number) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4));
  return [f(r), f(g), f(b)];
}

/** Read a colour token from :root (linear RGB), so the 3D view follows the active theme. */
export function tokenRgb(name: string, fallback: string): RGB {
  const value = getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return toLinear(hexToRgb(value.startsWith("#") ? value : fallback));
}

// The viewer field is dark in both themes, so cortex shading is fixed.
export const CORTEX_GYRUS: RGB = toLinear(hexToRgb("#b3b9c2"));
export const CORTEX_SULCUS: RGB = toLinear(hexToRgb("#666d78"));
const WHITE: RGB = [1, 1, 1];

export function mixInto(out: Float32Array, i: number, a: RGB, b: RGB, t: number): void {
  out[i] = a[0] + (b[0] - a[0]) * t;
  out[i + 1] = a[1] + (b[1] - a[1]) * t;
  out[i + 2] = a[2] + (b[2] - a[2]) * t;
}

/** Sequential ramp in one clip's colour: low = the clip hue, high = a lighter tint of it. */
export function glow(color: RGB, n: number): RGB {
  const t = 0.3 * n;
  return [
    color[0] + (WHITE[0] - color[0]) * t,
    color[1] + (WHITE[1] - color[1]) * t,
    color[2] + (WHITE[2] - color[2]) * t,
  ];
}
