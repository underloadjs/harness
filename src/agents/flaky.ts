// The recoverable-failures example agent. A live harness (it needs an endpoint)
// whose task is to exercise the failure path: a tool that throws two calls out of
// three, retried until it succeeds. It is a documented example template and, like
// every registry entry, editable (R20.1): a metadata-only PATCH keeps its factory
// and the testFlaky extra; an executable PATCH rebuilds the live toolbox with the
// extra retained.
//
// T14: the harness id stays `flaky`; the TOOL is `testFlaky` and discovery goes
// through toolRequest.
import type { AgentProfile } from './types';

export const flaky: AgentProfile = {
    name: 'flaky',
    title: 'Recoverable failures agent',
    description: 'Example agent that retries a deliberately unreliable tool, showing that a tool error is readable data rather than the end of the run.',
    instruction: 'You are testing tool reliability.',
    guidelines: [
        'Call toolRequest with tags like "retry" to enable the testFlaky tool, then call testFlaky.',
        'If it fails, call it again with no arguments until it succeeds, then report the number of attempts.',
        'The other tools in the shared toolbox are available too, but this task only needs the testFlaky one.'
    ]
};
