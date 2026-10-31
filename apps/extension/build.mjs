// Builds the unpacked extension into dist/ and writes manifest.json.
// Settings come from environment variables so the same code serves dev and beta:
//   API_URL           e.g. https://stylist-dev-api.<...>.azurecontainerapps.io
//   GOOGLE_CLIENT_ID  OAuth client of type "Chrome Extension" for this extension's ID
import { build } from 'esbuild';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const here = new URL('.', import.meta.url).pathname;
const out = `${here}dist`;
const apiUrl = (process.env.API_URL ?? 'https://stylist-dev-api.blacksmoke-1ec8eb0e.eastus2.azurecontainerapps.io').replace(/\/$/, '');
const clientId = process.env.GOOGLE_CLIENT_ID ?? 'SET_GOOGLE_CLIENT_ID.apps.googleusercontent.com';

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });

await build({
  entryPoints: { background: `${here}src/background.ts`, content: `${here}src/content.ts`, sidepanel: `${here}src/sidepanel.ts` },
  bundle: true, outdir: out, format: 'iife', target: 'chrome120', minify: false,
  define: { __API_URL__: JSON.stringify(apiUrl) },
});
cpSync(`${here}static/sidepanel.html`, `${out}/sidepanel.html`);
cpSync(`${here}static/icon128.png`, `${out}/icon128.png`);

const shops = ['https://www.amazon.in/*', 'https://www.amazon.com/*', 'https://www.myntra.com/*', 'https://www.flipkart.com/*', 'https://www.ajio.com/*'];
const imageHosts = ['https://m.media-amazon.com/*', 'https://images-na.ssl-images-amazon.com/*', 'https://assets.myntassets.com/*',
  'https://*.flixcart.com/*', 'https://assets.ajio.com/*'];
const manifest = {
  manifest_version: 3,
  name: 'Stylist – try clothes on you',
  short_name: 'Stylist',
  version: JSON.parse(readFileSync(`${here}package.json`, 'utf8')).version,
  description: 'Collects the clothes you look at while shopping and shows them on you.',
  // Public key: fixes the extension ID (hpclhbchhihihiamgekdojdhpknhggna) for Google sign-in and storage CORS.
  key: readFileSync(`${here}static/public-key.txt`, 'utf8').trim(),
  icons: { 128: 'icon128.png' },
  action: { default_title: 'Open Stylist' },
  side_panel: { default_path: 'sidepanel.html' },
  background: { service_worker: 'background.js' },
  permissions: ['identity', 'storage', 'sidePanel'],
  host_permissions: [...shops, ...imageHosts, `${apiUrl}/*`],
  content_scripts: [{ matches: shops, js: ['content.js'], run_at: 'document_idle' }],
  oauth2: { client_id: clientId, scopes: ['openid', 'email', 'profile'] },
};
writeFileSync(`${out}/manifest.json`, JSON.stringify(manifest, null, 2));
console.log(`built ${out} (API ${apiUrl}, Google client ${clientId.startsWith('SET_') ? 'NOT SET' : 'set'})`);
