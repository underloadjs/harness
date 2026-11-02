// @underload/harness tools/webdownload — `download`, byte retrieval with the
// multimodal hand-off.
//
// TYPE-ONLY BARREL (same rule as ../files and ../command)
// ------------------------------------------------------
// A VALUE re-export from a `*.tool.ts` entry would statically evaluate that
// entry — and with it the fetch implementation — at import time, which is
// exactly what the lazy catalogue (../lazy, ../index) exists to avoid. The tool
// value is reached through the generated descriptor loader; the entry's own
// bounds (`MAX_DOWNLOAD_CONTENT_BYTES`, `DOWNLOAD_REQUEST_TIMEOUT_MS`) are
// imported from the entry file directly by its focused tests.
//
// The argument and result shapes live in ../../types (the single type owner),
// because the harness, the server and the transport all name them; the entry
// declares only its local bounds.
//
// Cross-references:
//   - ./download.tool.ts        — the entry (metadata + registration + execute)
//   - ../../core/tool-media.ts  — the `toolMedia()` envelope and its profiles
//   - ../../shared/attachments.ts — the 20 MiB download profile
export type { DownloadParameters, DownloadResult } from '../../types';
