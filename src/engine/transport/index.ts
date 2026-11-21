// @underload/harness transport — the wire protocol layer.
//
// A transport turns a HarnessStreamRequest into an async iterable of stream
// events. It never executes tools and never mutates agent history.
//
// `listModels` is the sibling lookup: providers advertise what they serve at
// GET {baseURL}/models, and the harness UI/server need those ids before a
// session can pick a model. It shares the URL normalization, bearer auth, and
// error-message rules with the chat transport (see ./models.ts).
export {
    openAICompatible,
    MAX_EXTRA_BODY_BYTES,
    MAX_RESPONSE_SCHEMA_NAME_CHARS,
    // (issue 0004) The one machine name for "the prompt does not fit". The transport
    // raises it for a provider 400/413 size rejection; ../core/agent.ts raises the
    // same code from its pre-request guard and treats it as non-retriable.
    CONTEXT_OVERFLOW_CODE,
    PROVIDER_REQUEST_BODY_CODE
} from './openai';
// (T6) The provider failure classes and their bounds. The codes are what
// ../core/agent.ts switches on for its retry policy; the defaults and variable names
// are the operator-facing contract (`.env.example` quotes the same names).
export {
    PROVIDER_CONNECTION_CODE,
    PROVIDER_TIMEOUT_CODE,
    // (T8, AC3) The third provider failure class: a deterministic refusal. Exported so
    // ../core/agent.ts can keep it out of the ladder on the same switch as the others.
    PROVIDER_REJECTED_CODE,
    // (2026-11-17) The fourth class: the gateway's own in-stream `aborted` answer, i.e.
    // a cancel that did not come from our signal. Also exported is the DIAGNOSTICS-only
    // class of a codeless provider-transit failure, which carries no retry code and is
    // therefore not a `PROVIDER_*_CODE` — see ./provider-timeouts.ts.
    PROVIDER_ABORTED_CODE,
    PROVIDER_TRANSIT_CLASS,
    // The gateway's in-stream error vocabulary (the wire half) and the ONE translator
    // from it to the codes above. Exported so a host on a custom transport can classify
    // the same frames the built-in one does instead of re-deriving the table.
    PROVIDER_WIRE_ABORTED,
    PROVIDER_WIRE_CONNECTION,
    PROVIDER_WIRE_DECODE,
    PROVIDER_WIRE_TIMEOUT,
    PROVIDER_WIRE_UNKNOWN,
    PROVIDER_WIRE_UPSTREAM_STATUS,
    providerWireFailureOf,
    providerWireMessage,
    DEFAULT_PROVIDER_RESPONSE_HEAD_TIMEOUT_MS,
    DEFAULT_PROVIDER_FIRST_TOKEN_TIMEOUT_MS,
    DEFAULT_PROVIDER_STREAM_CHUNK_TIMEOUT_MS,
    PROVIDER_RESPONSE_HEAD_TIMEOUT_ENV,
    PROVIDER_FIRST_TOKEN_TIMEOUT_ENV,
    PROVIDER_STREAM_CHUNK_TIMEOUT_ENV,
    PROVIDER_TIMEOUT_MAX_MS,
    resolveProviderTimeout,
    providerURLOf,
    connectionFailureOf,
    // The single shape-checking reader of a transport's structured `details`. Both
    // ../core/agent.ts (`retry.provider`) and ../harness.ts (the terminal `error`
    // record) read diagnostics through this one function.
    providerDiagnosticsOf
} from './provider-timeouts';
export type { ProviderConnectionFailure, ProviderTimeoutPhase, ProviderWireFailure } from './provider-timeouts';
export { listModels, ModelListError } from './models';
export type { ModelListConfiguration, ModelListErrorKind } from './models';
