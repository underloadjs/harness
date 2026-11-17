// Provider-target diagnosis (T9): turn the transport's provider diagnostics into UI text.
//
// WHY THIS MODULE EXISTS. A stuck run used to say nothing the reader could act on: the
// tile read `task failed: Request to http://localhost:5500/providers/private/v1/… failed:
// fetch failed`, and the reader had no idea whether the UI was dialling 5500 or 6660, nor
// that a retry ladder was spending ~17 more minutes before giving up. Three facts answer
// that, and they are exactly the three the transport (T6) now emits and the contract
// already reports: the DIALLED target, the retry ladder, and the failure class.
//
// THE ONE RULE: never invent a value the frame did not carry.
//   - `provider` is ABSENT on an unclassified failure (src/types/index.ts:3344-3348), and
//     then every function here returns `undefined` so the caller keeps the wording it has
//     always used — a port is never guessed and a host is never defaulted.
//   - A URL that does not parse says nothing about a port, so `providerHostOf` answers
//     `undefined` rather than `localhost:80`. The scheme default (80/443) is filled ONLY
//     for a URL that actually parsed, because there the default is a fact of the scheme.
//
// Sources of the inputs (do not restate them in the UI beyond what they carry):
//   - `retry.provider`: ../types/index.ts `HarnessProviderAttemptDiagnostics` (T6) —
//     `errorClass`, redacted `url`, effective `port`, optional `phase`/`timeoutMs`/`errno`.
//   - terminal provider failure: `{ type: 'error', error: { message, code?, provider? } }`.
//     Both `code` and `provider` are DECLARED members of `HarnessErrorInfo`
//     (../types/index.ts) as of 2026-11-17, and `src/harness.ts` emits them on the terminal
//     record, so a terminal provider failure is read from fields. The prose-regex path in
//     `providerClassOf` / `timeoutDetailOf` survives ONLY as the historical fallback: a
//     session persisted before those fields existed carries the sentence and nothing else,
//     and re-opening it must render the same notice it does today.
//   - the effective per-session endpoint: `GET /sessions/{id}` `endpoint` (../shared/
//     harness-api.ts `SessionResource.endpoint`, mapped to the render model at
//     ./view-api.ts:167). A session ROW page carries `base_url: ''` (./view-api.ts:232),
//     which is "not reported", not "the empty endpoint" — hence the `isMissing` guards.
//   - `providerTimeouts` on `GET /config` (a parallel task's field): optional by contract,
//     so `providerTimeoutsOf` reads it field by field and answers `undefined` for a
//     document that does not carry it (AC4: absence must not throw or blank anything).
//
// Wording follows the tile's existing lowercase `·`-joined vocabulary — the removed
// T16/T19 retry line read `attempt 1 of 11 failed · retrying in 1.0s · HTTP 500`
// (../server/turn-projector.ts:2636-2658, ../ui/turns-retry.test.ts:742), and durations
// come from ./ui/time.ts `formatDuration` so 32000 reads `32.0s` everywhere.

import type { HarnessErrorInfo, HarnessProviderAttemptDiagnostics } from '../types';
import { formatDuration } from './ui/time';

// The two classes the transport emits (../transport/provider-timeouts.ts). `errorClass`
// is typed as a bare `string` in the contract, so this is a NAME set, not a narrowing
// union: an unknown class still renders its own label rather than being relabelled.
export const PROVIDER_CONNECTION_CLASS = 'provider-connection';
export const PROVIDER_TIMEOUT_CLASS = 'provider-timeout';

// The three bounds a `provider-timeout` can expire on — spelled from the same union as
// `HarnessProviderAttemptDiagnostics.phase` (../types/index.ts:849).
const PHASES = ['response-head', 'first-token', 'stream-chunk'] as const;
type ProviderPhase = (typeof PHASES)[number];

// `GET /config.providerTimeouts` (the parallel task's field). Every bound is optional
// AFTER reading, because a server that has not shipped the field answers nothing, and a
// server that ships half of it must not become three fake zeroes.
export type ProviderTimeouts = {
    responseHeadTimeoutMs?: number;
    firstTokenTimeoutMs?: number;
    streamChunkTimeoutMs?: number;
};

// The document `GET /config` answers: the generated `GlobalConfigDocument` plus the
// optional field. An intersection (not an edit to the generated contract) keeps this
// frontend-owned while the server side of the field lands in parallel.
export type HarnessConfigDocumentWithTimeouts<Doc> = Doc & { providerTimeouts?: ProviderTimeouts };

// One finite, non-negative number, otherwise `undefined` (never `NaN`, never a clamp).
const boundOf = (value: unknown): number | undefined =>
    typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined;

// Read `providerTimeouts` defensively. `undefined` means "this server told us nothing
// about its provider bounds" — the caller then prints NO line at all, which is AC4.
export const providerTimeoutsOf = (document: unknown): ProviderTimeouts | undefined => {
    if (document === null || typeof document !== 'object') return undefined;

    const raw = (document as { providerTimeouts?: unknown }).providerTimeouts;
    if (raw === null || typeof raw !== 'object') return undefined;

    const responseHeadTimeoutMs = boundOf((raw as ProviderTimeouts).responseHeadTimeoutMs);
    const firstTokenTimeoutMs = boundOf((raw as ProviderTimeouts).firstTokenTimeoutMs);
    const streamChunkTimeoutMs = boundOf((raw as ProviderTimeouts).streamChunkTimeoutMs);

    // Nothing usable in any of the three slots: report absence, not an empty object, so a
    // `providerTimeouts === undefined` test stays the single way the UI asks this question.
    if (responseHeadTimeoutMs === undefined && firstTokenTimeoutMs === undefined && streamChunkTimeoutMs === undefined) {
        return undefined;
    }

    return {
        ...(responseHeadTimeoutMs === undefined ? {} : { responseHeadTimeoutMs }),
        ...(firstTokenTimeoutMs === undefined ? {} : { firstTokenTimeoutMs }),
        ...(streamChunkTimeoutMs === undefined ? {} : { streamChunkTimeoutMs })
    };
};

// One bound, spelled the way the contract means it. `0` is not "zero seconds": the config
// document (../shared/harness-api.ts `GlobalConfigDocument.providerTimeouts`) states that
// `0` DISABLES that leg — it waits forever — so printing `0ms` would be the one number a
// reader misreads. Anything else is a duration, formatted like every other span in the UI.
const boundLabel = (milliseconds: number): string => (milliseconds === 0 ? 'off' : formatDuration(milliseconds));

// The settings-surface line for those bounds. Absent data = `undefined` = no line.
export const providerTimeoutsNote = (timeouts: ProviderTimeouts | undefined): string | undefined => {
    if (timeouts === undefined) return undefined;

    const parts: string[] = [];

    if (timeouts.responseHeadTimeoutMs !== undefined) {
        parts.push(`response head ${boundLabel(timeouts.responseHeadTimeoutMs)}`);
    }
    if (timeouts.firstTokenTimeoutMs !== undefined) {
        parts.push(`first token ${boundLabel(timeouts.firstTokenTimeoutMs)}`);
    }
    if (timeouts.streamChunkTimeoutMs !== undefined) {
        parts.push(`stream chunk ${boundLabel(timeouts.streamChunkTimeoutMs)}`);
    }

    return parts.length === 0 ? undefined : `provider timeouts · ${parts.join(' · ')}`;
};

// The host:port a base URL dials, with the scheme default filled in for a URL that
// PARSED (5500 is explicit here; 80/443 come from the scheme). `undefined` for a blank,
// absent or unparseable value — the caller then omits the target instead of naming one.
export const providerHostOf = (baseUrl: string | undefined | null): string | undefined => {
    const raw = (baseUrl ?? '').trim();
    if (raw.length === 0) return undefined;

    let parsed: URL;
    try {
        parsed = new URL(raw);
    } catch {
        return undefined;
    }

    // `URL.host` already carries an explicit port and omits the default one; the
    // scheme's default is appended because "which port?" is the whole question here.
    if (parsed.host.includes(':')) return parsed.host;

    const fallbackPort = parsed.protocol === 'https:' ? '443' : '80';
    return `${parsed.host}:${fallbackPort}`;
};

// The redacted dial target for a `retry.provider` block: its `url` (origin+path, safe to
// print) plus the effective port when the frame names one. Absent url AND port = nothing
// honest to show.
const providerUrlOf = (provider: HarnessProviderAttemptDiagnostics | undefined): string | undefined => {
    if (provider === undefined) return undefined;

    const url = typeof provider.url === 'string' ? provider.url.trim() : '';
    if (url.length > 0) return url;

    // A frame with no url but an explicit port still names a port; the host half is
    // unknown, so the honest statement is the bare port, not a guessed host.
    const port = boundOf(provider.port);
    return port === undefined ? undefined : `port ${port}`;
};

// The persistent header/status line: WHICH provider this conversation dials, and the
// model it runs. `endpoint` is the session's effective value (./view-api.ts:167); the
// fallback is what this browser would send on create, which is the next-honest answer
// before a session read has landed. A blank `base_url` (a row page) is absence.
export const providerTargetNote = (input: {
    baseUrl?: string | null;
    model?: string | null;
}): string | undefined => {
    const host = providerHostOf(input.baseUrl);
    const model = (input.model ?? '').trim();

    if (host === undefined && model.length === 0) return undefined;

    const parts: string[] = [];

    if (host !== undefined) parts.push(`provider ${host}`);
    if (model.length > 0) parts.push(`model ${model}`);

    return parts.join(' · ');
};

// The live retry line, from the `retry` frame plus its `provider` block. `undefined`
// when the frame carries no diagnostics (AC2: that case renders exactly as before) or
// when the frame's own numbers are unusable.
//
// Shape (attempt/delay come from the frame, reason and target from `provider`):
//   attempt 6 of 11 failed · retrying in 32.0s · ECONNREFUSED · http://localhost:5500/providers/private/v1
export const providerRetryNote = (frame: {
    attempt?: unknown;
    maxAttempts?: unknown;
    delayMs?: unknown;
    provider?: HarnessProviderAttemptDiagnostics;
    error?: { message?: unknown };
}): string | undefined => {
    const provider = frame.provider;
    if (provider === undefined) return undefined;

    const attempt = boundOf(frame.attempt);
    const maxAttempts = boundOf(frame.maxAttempts);
    const delayMs = boundOf(frame.delayMs);

    if (attempt === undefined || maxAttempts === undefined || delayMs === undefined) return undefined;

    // The reason: the platform errno when the transport recovered one (the short token a
    // reader recognises, `ECONNREFUSED`), else the error's own first line. Never empty.
    const errno = typeof provider.errno === 'string' ? provider.errno.trim() : '';
    const message = typeof frame.error?.message === 'string' ? frame.error.message.trim() : '';
    const reason = errno.length > 0 ? errno : message;

    const url = providerUrlOf(provider);

    const parts = [
        `attempt ${Math.trunc(attempt)} of ${Math.trunc(maxAttempts)} failed`,
        `retrying in ${formatDuration(delayMs)}`
    ];

    if (reason.length > 0) parts.push(reason);
    if (url !== undefined) parts.push(url);

    return parts.join(' · ');
};

// The class of a terminal provider failure: the STRUCTURED fields the frame carries, and
// only as a last resort the class named inside the server's own sentence.
//
// ORDER MATTERS, and it changed on 2026-11-17 (the unrecoverable-timeout report):
//   1. `error.code` — now a DECLARED member of `HarnessErrorInfo` (../types/index.ts) and
//      emitted on every terminal record whose failure is classified, so the common path
//      reads a field instead of pattern-matching a sentence;
//   2. `error.provider.errorClass` — the transport's diagnosis of the attempt that ended
//      the run, published on the SAME record as the `retry` frames since that change, and
//      the only source for a coded failure whose `code` was written by a custom transport
//      under a different spelling;
//   3. the message, which is the HISTORICAL fallback: a session persisted before those
//      fields existed carries prose only, and re-opening it must still name the class.
//
// Only the two classes this module has wording for are returned. A `provider-rejected`,
// `provider-aborted` or `provider-transit` failure answers `undefined` on purpose: the
// caller then keeps the generic rendering it has always had instead of being dressed in
// the timeout/connection layout those classes have no fields for.
//
// `undefined` = not a provider failure this UI can label → generic rendering.
const providerClassOf = (error: HarnessErrorInfo): string | undefined => {
    const stated = typeof error.code === 'string' ? error.code.trim() : '';
    if (stated === PROVIDER_CONNECTION_CLASS || stated === PROVIDER_TIMEOUT_CLASS) return stated;

    const fromProvider = typeof error.provider?.errorClass === 'string' ? error.provider.errorClass.trim() : '';
    if (fromProvider === PROVIDER_CONNECTION_CLASS || fromProvider === PROVIDER_TIMEOUT_CLASS) return fromProvider;

    // The terminal frame's message names the class verbatim (the coded-frame contract), so
    // matching it is reading the frame, not guessing at it. Historical records only.
    const message = typeof error.message === 'string' ? error.message : '';
    if (message.includes(PROVIDER_TIMEOUT_CLASS)) return PROVIDER_TIMEOUT_CLASS;
    if (message.includes(PROVIDER_CONNECTION_CLASS)) return PROVIDER_CONNECTION_CLASS;

    return undefined;
};

// A `host:port` inside a prose failure message, or undefined. Conservative: it has to
// look like an authority (a dot/bracket/localhost host plus a numeric port), so a bare
// number in a sentence is never read as a port.
const HOST_PORT = /\b(?:\[[0-9a-fA-F:.]+\]|[A-Za-z0-9][A-Za-z0-9.-]*):(\d{1,5})\b/;

const hostPortFromMessage = (message: string): string | undefined => {
    const found = HOST_PORT.exec(message);
    return found === null ? undefined : found[0];
};

// The phase + bound a `provider-timeout` expired on. Structured fields first; then the
// server's own sentence, which states both (an echo of it, never an invention).
const timeoutDetailOf = (
    message: string,
    provider: HarnessProviderAttemptDiagnostics | undefined
): string | undefined => {
    const phase = PHASES.find((candidate: ProviderPhase) =>
        provider?.phase === candidate || message.includes(candidate)
    );
    const boundMs = provider?.timeoutMs !== undefined ? boundOf(provider.timeoutMs) : undefined;

    // A stated bound wins. Otherwise the message's own `… bound 30000ms …` figure is
    // quoted in the server's spelling — a duration it wrote, not one derived here.
    const statedBound =
        boundMs !== undefined
            ? formatDuration(boundMs)
            : (() => {
                  const found = /(?:bound|timeout|window)\s+(?:of\s+)?(\d+(?:\.\d+)?(?:ms|s|m))/i.exec(message);
                  return found === null ? undefined : found[1];
              })();

    if (phase === undefined && statedBound === undefined) return undefined;

    const parts: string[] = [];
    if (phase !== undefined) parts.push(phase);
    if (statedBound !== undefined) parts.push(`bound ${statedBound}`);

    return parts.join(' · ');
};

// The terminal provider failure, spelled so the reader can act on it (AC3). `undefined`
// for anything the transport did not classify, so the caller keeps `error` + message.
//
//   provider-connection → dialled localhost:5500 · <message> · this is the provider address, set in Endpoint & model settings
//   provider-timeout    → response-head · bound 30.0s · <message>
export const providerFailureOf = (
    error: HarnessErrorInfo | undefined
): { label: string; text: string } | undefined => {
    if (error === undefined || error === null) return undefined;

    const label = providerClassOf(error);
    if (label === undefined) return undefined;

    const message = typeof error.message === 'string' ? error.message.trim() : '';
    const provider = error.provider;
    const parts: string[] = [];

    if (label === PROVIDER_CONNECTION_CLASS) {
        // The dialled target: the structured url when present, else the host:port the
        // server's own sentence names. Absent both → no target clause at all.
        const target = providerUrlOf(provider) ?? hostPortFromMessage(message);
        if (target !== undefined) parts.push(`dialled ${target}`);
    } else {
        const detail = timeoutDetailOf(message, provider);
        if (detail !== undefined) parts.push(detail);
    }

    if (message.length > 0) parts.push(message);

    // The diagnosis the user actually needed: that the address in the failure IS the
    // provider address this UI dials. Only stated when a target was actually shown, so
    // the hint can never point at a port nobody printed.
    if (label === PROVIDER_CONNECTION_CLASS && parts.length > 0 && parts[0].startsWith('dialled ')) {
        parts.push('this is the provider address, set in Endpoint & model settings');
    }

    return { label, text: parts.join(' · ') };
};
