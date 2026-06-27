import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';
const host = process.env.TAURI_DEV_HOST;
// Port the embedded Rust HTTP server (browser access) listens on.
const WEB_SERVER_PORT = 9870;
export default defineConfig(async () => ({
    plugins: [react()],
    clearScreen: false,
    resolve: {
        // Exact-match so the shims' own `@tauri-apps/api` import doesn't recurse.
        alias: [
            {
                find: /^@tauri-apps\/api\/core$/,
                replacement: fileURLToPath(new URL('./src/lib/tauri-core.ts', import.meta.url)),
            },
            {
                find: /^@tauri-apps\/api\/event$/,
                replacement: fileURLToPath(new URL('./src/lib/tauri-event.ts', import.meta.url)),
            },
        ],
    },
    server: {
        port: 1420,
        strictPort: true,
        host: host || false,
        hmr: host
            ? { protocol: 'ws', host, port: 1421 }
            : undefined,
        watch: { ignored: ['**/src-tauri/**'] },
        // In dev, browsing from a plain browser tab on :1420 proxies IPC/media/events
        // to the embedded Rust server so the same UI works with HMR.
        proxy: {
            '/__ipc': `http://localhost:${WEB_SERVER_PORT}`,
            '/__media': `http://localhost:${WEB_SERVER_PORT}`,
            '/__events': {
                target: `http://localhost:${WEB_SERVER_PORT}`,
                changeOrigin: true,
            },
        },
    },
    build: {
        rollupOptions: {
            output: {
                manualChunks(id) {
                    if (id.includes('node_modules/react/') || id.includes('node_modules/react-dom/')) {
                        return 'react-vendor';
                    }
                    if (id.includes('@tanstack')) {
                        return 'tanstack';
                    }
                    if (id.includes('zustand')) {
                        return 'state';
                    }
                    if (id.includes('@tauri-apps')) {
                        return 'tauri';
                    }
                },
            },
        },
    },
}));
