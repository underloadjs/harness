// The recoverable-failures example agent. A live harness (it needs an endpoint)
// whose task is to exercise the failure path: a tool that throws two calls out of
// three, retried until it succeeds. It is a documented example, so its descriptor
// is `editable: false`.
import type { AgentProfile } from './types';

export const flaky: AgentProfile = {
    name: 'flaky',
    title: 'Recoverable failures agent',
    description: 'Example agent that retries a deliberately unreliable tool, showing that a tool error is readable data rather than the end of the run.',
    instruction: 'You are testing tool reliability.',
    guidelines: [
        'Call requestTools with tags like "retry" to enable the flaky tool, then call the flaky tool.',
        'If it fails, call it again with no arguments until it succeeds, then report the number of attempts.',
        'The other tools in the shared toolbox are available too, but this task only needs the flaky one.'
    ]
};
