// @underload/harness util — leaf helpers shared by every other folder.
//
// A leaf on purpose: nothing here imports core, transport, or harness, so any
// layer can depend on it without creating a cycle.
export { HarnessError, isInstanceOf, toErrorInfo } from './errors';
// Surrogate-safe cuts and the wire-body sanitizer. Same leaf contract as `./errors`:
// a producer site in plugins/core/tools and the transport's send path all need the
// exact same pairing rule, and only a leaf can be imported by all of them.
export {
    clipPrefix,
    countLoneSurrogates,
    countWireLoneSurrogates,
    hasLoneSurrogate,
    isHighSurrogateCode,
    isLowSurrogateCode,
    pairSafeCut,
    sanitizeLoneSurrogates,
    sanitizeWireBody,
    trimBrokenLeadSurrogate,
    trimBrokenTrailSurrogate
} from './unicode';
export type { WireSanitizeResult } from './unicode';
