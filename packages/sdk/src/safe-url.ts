// isSafeUrl moved to @bugzar/shared so the viewer (design replay href) can share
// the same guard. Re-exported here so the existing SDK import sites
// (ConnectGate/PublishedView/UploadedLink/ResultChip) and tests keep working.
export { isSafeUrl } from '@bugzar/shared';
