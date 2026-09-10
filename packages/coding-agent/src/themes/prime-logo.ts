/**
 * Pre-rendered ASCII versions of the Prime butterfly mark.
 *
 * Source: assets/brand/prime-butterfly.svg
 * Re-render at any width: `uv run scripts/render-logo.py --width N`
 */

/** ~10 rows × 32 cols. The default brand mark — half-block butterfly, splash-ready. */
export const PRIME_BUTTERFLY_LOGO = `                          ▄▄███▀
    ▄▄▄▄▄              ▄█████▀
    ██████▄         ▄██████▀
   ▄███▀███▄     ▄███▀▄██▀
   ███ ▄████▄▄▄████▀▄▄██
  ▀██  ▀█████████▀▀▀▀▀▀
  ▄██   ██████▀▀ ▄███
 █████    ▀█▄▄▄█████▀
███████▄  ████████▀
▀███▀▀    █████▀`;

/** Compact 6-row × 20-column butterfly, rendered from the brand SVG at width 20. */
export const PRIME_COMPACT_BUTTERFLY_LOGO = `   ▄▄          ▄▄██▀
   ███▄     ▄████▀
  ██ ██▄ ▄██▀▄█▀
 ▀█  █████▀██▀
▄███ ▀▀█▄▄███
████▀ ████▀▀`;
