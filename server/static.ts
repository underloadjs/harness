// Static file serving for the built UI.
//
// `yarn build:playground` emits `playground/dist`; the standalone server mounts it
// here so `yarn serve` is a single process for both the API and the UI. Hashed
// assets get an immutable cache; the entry document never does.

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import path from 'node:path';

const MIME_TYPES: Readonly<Record<string, string>> = {
    '.css': 'text/css; charset=utf-8',
    '.html': 'text/html; charset=utf-8',
    '.ico': 'image/x-icon',
    '.jpeg': 'image/jpeg',
    '.jpg': 'image/jpeg',
    '.js': 'text/javascript; charset=utf-8',
    '.json': 'application/json; charset=utf-8',
    '.map': 'application/json; charset=utf-8',
    '.png': 'image/png',
    '.svg': 'image/svg+xml',
    '.webp': 'image/webp'
};

const contentType = (filePath: string): string =>
    MIME_TYPES[path.extname(filePath).toLowerCase()] ?? 'application/octet-stream';

export type StaticHandler = (request: IncomingMessage, response: ServerResponse) => Promise<boolean>;

export const createStaticHandler = (root: string): StaticHandler => {
    const absoluteRoot = path.resolve(root);

    const sendFile = async (
        request: IncomingMessage,
        response: ServerResponse,
        filePath: string
    ): Promise<boolean> => {
        try {
            const info = await stat(filePath);
            if (!info.isFile()) return false;

            response.statusCode = 200;
            response.setHeader('Content-Type', contentType(filePath));
            response.setHeader(
                'Cache-Control',
                filePath.includes(`${path.sep}assets${path.sep}`)
                    ? 'public, max-age=31536000, immutable'
                    : 'no-cache'
            );
            response.setHeader('Content-Length', String(info.size));

            if (request.method === 'HEAD') {
                response.end();
                return true;
            }

            await new Promise<void>((resolve, reject) => {
                const stream = createReadStream(filePath);
                stream.once('error', reject);
                stream.once('end', resolve);
                stream.pipe(response);
            });

            return true;
        } catch {
            return false;
        }
    };

    return async (request, response): Promise<boolean> => {
        if (request.method !== 'GET' && request.method !== 'HEAD') return false;

        const url = new URL(request.url ?? '/', 'http://localhost');

        let pathname: string;
        try {
            pathname = decodeURIComponent(url.pathname);
        } catch {
            return false;
        }

        const requested = pathname === '/' ? '/index.html' : pathname;
        const filePath = path.resolve(absoluteRoot, `.${requested}`);

        // Resolve rejects traversal outside the root, including encoded `..`.
        if (filePath !== absoluteRoot && !filePath.startsWith(`${absoluteRoot}${path.sep}`)) {
            return false;
        }

        if (await sendFile(request, response, filePath)) return true;

        // Single-page app fallback: any extensionless route renders index.html.
        // Assets that do not exist stay 404s rather than becoming HTML.
        if (path.extname(requested).length === 0) {
            return sendFile(request, response, path.join(absoluteRoot, 'index.html'));
        }

        return false;
    };
};
