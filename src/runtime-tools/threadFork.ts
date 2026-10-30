// threadFork — standalone baseline entry; runtime dispatch owns the branch.
import { THREAD_FORK_METADATA } from '../core/metadata';

export const metadata = THREAD_FORK_METADATA;

export const execute = () => {
    throw new Error(
        'threadFork requires the harness run that owns the conversation; call it from a model tool call.'
    );
};
