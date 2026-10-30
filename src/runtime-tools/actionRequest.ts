// actionRequest — standalone baseline entry; runtime dispatch owns the owner run.
import { ACTION_REQUEST_METADATA } from '../core/metadata';

export const metadata = ACTION_REQUEST_METADATA;

export const execute = () => {
    throw new Error(
        'actionRequest requires the harness run that owns the conversation; call it from a model tool call.'
    );
};
