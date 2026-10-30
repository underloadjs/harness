// profileManage — standalone source entry; state lives in the harness record store.
import { PROFILE_MANAGE_METADATA } from '../core/metadata';
import type { ToolContext } from '../types';

export const metadata = PROFILE_MANAGE_METADATA;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('profileManage requires the live harness reference.'))
        : context.harness.runtime.executeRecordTool('profileManage', context);
