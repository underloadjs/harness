// locationManage — standalone source entry; state lives in the harness record store.
import { LOCATION_MANAGE_METADATA } from '../core/metadata';
import type { ToolContext } from '../types';

export const metadata = LOCATION_MANAGE_METADATA;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('locationManage requires the live harness reference.'))
        : context.harness.runtime.executeRecordTool('locationManage', context);
