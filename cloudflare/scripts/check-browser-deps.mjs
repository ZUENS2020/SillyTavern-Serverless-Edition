import assert from 'node:assert/strict';

import { imageDimensionsFromData } from 'image-dimensions';
import showdown from 'showdown';

const converter = new showdown.Converter({ metadata: true, completeHTMLDocument: true });
const metadataPayload = '---\ntitle: </title><script>alert(1)</script>\n---\n\n# safe\n';
const metadataHtml = converter.makeHtml(metadataPayload);
assert(!metadataHtml.includes('</title><script>'), 'Showdown metadata title escaping regressed');
assert(metadataHtml.includes('&lt;/title&gt;&lt;script&gt;'), 'Showdown metadata payload was not escaped');

const redosInput = `www.example.com/a${')'.repeat(80_000)}`;
const started = performance.now();
new showdown.Converter({ simplifiedAutoLink: true }).makeHtml(redosInput);
const redosMs = Math.round(performance.now() - started);
assert(redosMs < 5_000, `Showdown URL parsing exceeded the 5 s ReDoS guard (${redosMs} ms)`);

const pixel = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
    'base64',
);
const dimensions = imageDimensionsFromData(pixel);
assert.deepEqual(dimensions, { width: 1, height: 1, type: 'png' });

await import('../../src/transformers.js');

console.log(JSON.stringify({ metadataEscaped: true, redosMs, imageDimensions: dimensions, optionalLocalMl: true }));
