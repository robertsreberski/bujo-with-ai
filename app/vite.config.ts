import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';
import { fileURLToPath, URL } from 'node:url';

import tailwindcss from '@tailwindcss/vite';
import react from '@vitejs/plugin-react';
import { defineConfig, type Plugin } from 'vite';

const PRECACHE_PLACEHOLDER = '__JOURNAL_PRECACHE_JSON__';
// iOS reads launch images from the home-screen bookmark, never over fetch, so
// precaching the (device-specific, mostly unused) splash set only burns budget.
const PRECACHE_EXCLUDED = /^splash[/\\]/;
const MCP_CONTRACT_MODULE_SUFFIX = '/server/src/contracts/mcp.ts';
const PUBLIC_DIRECTORY = fileURLToPath(new URL('./public', import.meta.url));
const INDEX_HTML = fileURLToPath(new URL('./index.html', import.meta.url));

function sourceText(source: string | Uint8Array): string {
  return typeof source === 'string' ? source : new TextDecoder().decode(source);
}

function publicFiles(directory = PUBLIC_DIRECTORY): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = resolve(directory, entry.name);
    return entry.isDirectory() ? publicFiles(path) : [path];
  });
}

export function journalShellRevision(
  indexSource: string | Uint8Array,
  assetManifest: Array<{ url: string; revision: string }>,
): string {
  const canonicalManifest = [...assetManifest].sort(
    (left, right) =>
      left.url.localeCompare(right.url) || left.revision.localeCompare(right.revision),
  );
  return createHash('sha256')
    .update(sourceText(indexSource))
    .update(JSON.stringify(canonicalManifest))
    .digest('hex')
    .slice(0, 16);
}

/** Injects a revisioned precache list without the vulnerable Workbox build toolchain. */
export function journalServiceWorkerPlugin(): Plugin {
  return {
    name: 'journal-service-worker',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      const emittedManifest = Object.values(bundle)
        .filter((output) => output.fileName !== 'sw.js' && !output.fileName.endsWith('.map'))
        .map((output) => {
          const contents = output.type === 'asset' ? sourceText(output.source) : output.code;
          return {
            url: `/${output.fileName}`,
            revision: createHash('sha256').update(contents).digest('hex').slice(0, 16),
          };
        });
      const publicManifest = publicFiles()
        .filter((path) => !PRECACHE_EXCLUDED.test(relative(PUBLIC_DIRECTORY, path)))
        .map((path) => {
          const contents = readFileSync(path);
          return {
            url: `/${relative(PUBLIC_DIRECTORY, path).split(sep).join('/')}`,
            revision: createHash('sha256').update(contents).digest('hex').slice(0, 16),
          };
        });
      // Vite emits transformed index.html after Rollup's generateBundle hook.
      // Key its revision to the complete emitted asset graph so every app build
      // fetches the newly transformed shell during service-worker install.
      const shellEntry = {
        url: '/index.html',
        revision: journalShellRevision(readFileSync(INDEX_HTML), [
          ...emittedManifest,
          ...publicManifest,
        ]),
      };
      const manifest = [
        ...new Map(
          [...emittedManifest, ...publicManifest, shellEntry].map((entry) => [entry.url, entry]),
        ).values(),
      ].sort((left, right) => left.url.localeCompare(right.url));

      const worker = bundle['sw.js'];
      if (!worker || worker.type !== 'chunk') {
        this.error('The Journal service-worker entry was not emitted as sw.js.');
      }

      const placeholder = new RegExp(`(["'])${PRECACHE_PLACEHOLDER}\\1`);
      if (!placeholder.test(worker.code)) {
        this.error('The Journal service-worker precache placeholder was not found.');
      }
      worker.code = worker.code.replace(placeholder, JSON.stringify(JSON.stringify(manifest)));
    },
  };
}

/** Fails the production build if the server-only MCP contract graph leaks into a browser chunk. */
export function browserContractBoundaryPlugin(): Plugin {
  return {
    name: 'journal-browser-contract-boundary',
    apply: 'build',
    enforce: 'post',
    generateBundle(_options, bundle) {
      for (const output of Object.values(bundle)) {
        if (output.type !== 'chunk') continue;
        const leakedModule = Object.keys(output.modules).find((id) =>
          id.replaceAll('\\', '/').endsWith(MCP_CONTRACT_MODULE_SUFFIX),
        );
        if (leakedModule === undefined) continue;
        this.error(
          `Server-only MCP contract ${leakedModule} leaked into browser chunk ${output.fileName}.`,
        );
      }
    },
  };
}

export default defineConfig({
  plugins: [
    react(),
    // optimize: false is load-bearing — Tailwind's Lightning CSS pass rewrites
    // color syntax inside custom-property values (rgb(0 0 0 / 70%) → #000000b3),
    // which breaks the byte-exact DESIGN_TOKENS contract in release-evidence.
    // Vite's esbuild minifier handles CSS instead, preserving specified values.
    tailwindcss({ optimize: false }),
    browserContractBoundaryPlugin(),
    journalServiceWorkerPlugin(),
  ],
  build: {
    rollupOptions: {
      input: {
        app: fileURLToPath(new URL('./index.html', import.meta.url)),
        sw: fileURLToPath(new URL('./src/sw.ts', import.meta.url)),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: 'assets/[name]-[hash][extname]',
      },
    },
  },
  server: {
    port: 5173,
    strictPort: true,
    proxy: {
      '/api': { target: 'http://127.0.0.1:5178', changeOrigin: false },
      '/healthz': { target: 'http://127.0.0.1:5178', changeOrigin: false },
      '/mcp': { target: 'http://127.0.0.1:5178', changeOrigin: false },
    },
  },
});
