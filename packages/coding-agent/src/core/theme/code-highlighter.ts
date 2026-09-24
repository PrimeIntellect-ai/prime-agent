/**
 * Thin wrapper around cli-highlight so the heavy highlight.js dependency
 * (~350ms import) can be loaded lazily via dynamic import. The static import
 * here keeps it bundled in the compiled Bun binary.
 */

export { highlight, supportsLanguage } from "cli-highlight";
