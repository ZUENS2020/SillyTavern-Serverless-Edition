# Deploy-time third-party extensions

Drop a reviewed SillyTavern UI extension folder here (it must contain `manifest.json`), then run `npm run deploy`. The build scans this directory and the Worker advertises each folder as `third-party/<id>`.

Runtime git clone and zip upload are not available. Extensions are loaded from Static Assets at `/scripts/extensions/third-party/<id>/`. Relative imports such as `../../../../script.js` depend on that prefix.

Do not add extensions that:

- call `fetch('https://…')` or open a WebSocket to a Provider
- read Extras, `/api/secrets`, or a custom API URL
- ship `node_modules`, WebLLM, ChromaDB, or a Node server plugin

`npm run check:worker-policy` scans every JavaScript file in this directory (except `node_modules`) and fails the build on those patterns. Folders without `manifest.json` are ignored.
