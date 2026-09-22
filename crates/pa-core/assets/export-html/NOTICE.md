# Export template assets

The session HTML export template (`template.html`, `template.css`,
`template.js`) is the product export template, copied verbatim so exported
files match the reference product byte-for-byte, including its wire-internal
identifiers (`pi-url-params`, `pi-share-base-url`, and the `pi-share:v1`
storage key - the share-viewer service injects those, so they must stay).

Vendored JavaScript (kept byte-identical, minified upstream):

- `vendor/marked.min.js` - marked, MIT License, https://github.com/markedjs/marked
- `vendor/highlight.min.js` - highlight.js, BSD-3-Clause License, https://highlightjs.org

Both are embedded into every exported HTML file by the exporter.
