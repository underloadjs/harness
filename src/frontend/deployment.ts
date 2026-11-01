// Where the harness API lives when the UI is hosted on a STATIC origin.
//
// THE PROBLEM THIS SOLVES (the GitHub Pages deployment): `.github/workflows/ci.yml`
// publishes `src/frontend/dist` to `https://underloadjs.github.io/harness/`. That
// host serves the bundle and NOTHING ELSE — there is no `/api`, no `/v1/harness`,
// no upstream. The client's documented fallback root is the origin-relative
// `/api`, so on Pages every request resolved to `https://underloadjs.github.io/api/…`
// and returned GitHub's 404 HTML page: the UI booted, then reported
// "The harness server returned a non-JSON response". A relative root can never
// work there, because the API is a separate process on a separate machine/port by
// design (see ../server/service.ts).
//
// THE RULE: when the page is loaded from a GitHub Pages host and the operator has
// not pinned a root (`?apiRoot=`, injected config, or build-time
// `VITE_HARNESS_API`), the client dials this ABSOLUTE chain instead, in order, and
// keeps the first entry that answers `GET <root>/health`:
//
//   1. `http://localhost:5000/v1/harness`  — the service gateway on THIS machine
//      (the machine viewing the page), which is the normal dev host;
//   2. `http://127.0.0.1:5000/v1/harness`  — the same gateway, IPv4 spelling;
//   3. `http://192.168.50.109:5000/v1/harness` — the standard LAN host.
//
// WHY BOTH LOOPBACK SPELLINGS: the service gateway binds `0.0.0.0` (IPv4 only,
// packages/underload/service/src/server/start.ts), while a browser resolves
// `localhost` to `::1` FIRST on Windows (measured in this repo — see
// ./vite-proxy.ts `DEV_SERVER_HOST`). A `localhost`-only candidate therefore
// refused connections on a machine whose gateway was up and listening on IPv4,
// which is exactly the "Pages is not connecting to the harness server" symptom.
// Probing both spellings costs one fast connection-refused when the first is dead.
//
// WHY THE LAN ENTRY IS LAST: it is the shared machine, so it is the right answer
// for a laptop with no local gateway and the wrong answer (a stale transcript) for
// a machine that has its own. Local first also keeps the saved provider key on the
// viewer's own host whenever possible (see ./api.ts — the key is POSTed to the
// resolved root).
//
// CROSS-ORIGIN REQUIREMENTS the client cannot satisfy alone:
//   - CORS + Private Network Access: the service loader installs
//     `cors({ origin: '*', allowHeaders: '*' })` and stamps
//     `Access-Control-Allow-Private-Network: true` on every response, so the
//     preflight for the `X-Harness-Client` header is answered;
//   - the harness Origin gate (../server/service.ts) must accept a GitHub Pages
//     Origin — it does, via `isPagesOrigin` in ../shared/origin.ts;
//   - MIXED CONTENT: Pages serves this UI over HTTPS while the harness serves
//     plain HTTP. Browsers exempt `localhost`/`127.0.0.1` (potentially
//     trustworthy), but Chrome blocks an HTTPS page fetching a plain-HTTP LAN
//     address, so entry 3 needs relaxed mixed-content blocking or an
//     HTTPS-terminating proxy in front of :5000. The chain degrades honestly: a
//     blocked candidate simply fails the probe and the next one is tried.
//
// These constants mirror the monorepo's `config/environment` (`src/host.ts`,
// `src/port.ts`). That package is not published to npm and this package is
// published standalone, so the values are restated here (the same convention the
// `distribution/*` UIs use) and named identically to stay greppable.
import { isPagesHostname } from '../shared/origin';

// Standard local area network host name (config/environment/src/host.ts).
export const LOCAL_AREA_NETWORK_HOST_NAME = '192.168.50.109';

// The @underload/service gateway port — the ONLY port clients dial there
// (config/environment/src/port.ts `LOCAL_AREA_NETWORK_DATABASE_PORT`). The
// harness endpoint declares no port of its own, so `/v1/harness` is served by
// that gateway (see ../server/endpoint/harness/service-route.ts).
export const LOCAL_AREA_NETWORK_DATABASE_PORT = 5000;

// The canonical service mount. Mirrors `SERVICE_MOUNT` in ../server/api.ts, which
// this bundle must not import at runtime (the client barrel stays server-free).
export const HARNESS_SERVICE_MOUNT = '/v1/harness';

// One candidate root per host that runs the gateway: scheme + host + port + mount,
// with no trailing slash, so `${root}/health` and `${root}/sessions` concatenate
// exactly like every other API root (./api.ts `normalizeApiRoot`).
const serviceRoot = (host: string): string =>
    `http://${host}:${LOCAL_AREA_NETWORK_DATABASE_PORT}${HARNESS_SERVICE_MOUNT}`;

// The static-host chain, in probe order. Every entry is a full API root, so a
// caller may use one directly (a `?apiRoot=` naming one of these is trusted: it is
// operator data compiled into this bundle, not a value a link can invent).
export const STATIC_API_CANDIDATES: readonly string[] = [
    serviceRoot('localhost'),
    serviceRoot('127.0.0.1'),
    serviceRoot(LOCAL_AREA_NETWORK_HOST_NAME)
];

// True when THIS page is served from a GitHub Pages host, i.e. a static host with
// no API of its own. Read defensively: the module is also evaluated in Node (the
// published client barrel), where there is no location at all, and a host with no
// location is by definition not a Pages deployment.
export const isStaticPagesHost = (): boolean => {
    const hostname = globalThis.location?.hostname;

    return hostname !== undefined && isPagesHostname(hostname);
};
