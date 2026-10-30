// chapterManage — standalone source entry; state lives in the harness record store.
import { CHAPTER_MANAGE_METADATA } from '../core/metadata';
import type { ToolContext } from '../types';

export const metadata = CHAPTER_MANAGE_METADATA;

export const execute = (context: ToolContext) =>
    context.harness === undefined
        ? Promise.reject(new Error('chapterManage requires the live harness reference.'))
        : context.harness.runtime.executeRecordTool('chapterManage', context);
