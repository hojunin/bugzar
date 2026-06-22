#!/usr/bin/env node
/**
 * Bugzar — report admin CLI (PR-16).
 *
 * Hard-deletes every R2 asset under `reports/<id>/` and drops a tombstone
 * so future `/r/<id>` requests return 410 Gone. Jira tickets are unaffected
 * — only the public report URL changes state.
 *
 * Usage:
 *   BUGZAR_ADMIN_SECRET=<secret> node scripts/delete-report.mjs <reportId>
 *   BUGZAR_ADMIN_SECRET=<secret> node scripts/delete-report.mjs <reportId> --dry-run
 *   BUGZAR_ADMIN_SECRET=<secret> node scripts/delete-report.mjs <reportId> --worker-url https://bugzar-backend.workers.dev
 *
 * Defaults:
 *   --worker-url      $BUGZAR_WORKER_URL or https://bugzar-backend.workers.dev
 *   --dry-run         false (prints the curl-equivalent without making the request)
 */

import { parseArgs } from 'node:util';

const { values, positionals } = parseArgs({
  args: process.argv.slice(2),
  options: {
    'worker-url': { type: 'string' },
    'dry-run': { type: 'boolean', default: false },
    help: { type: 'boolean', default: false, short: 'h' },
  },
  allowPositionals: true,
});

if (values.help || positionals.length === 0) {
  console.log('사용법: node scripts/delete-report.mjs <reportId> [--worker-url <url>] [--dry-run]');
  console.log('');
  console.log('환경변수:');
  console.log('  BUGZAR_ADMIN_SECRET (필수)  Worker 의 ADMIN_SECRET 과 일치해야 함');
  console.log('  BUGZAR_WORKER_URL  (선택)  기본: https://bugzar-backend.workers.dev');
  process.exit(values.help ? 0 : 1);
}

const reportId = positionals[0];
if (!/^[a-z0-9]{1,40}$/i.test(reportId)) {
  console.error(`reportId 형식이 잘못됐어요: ${reportId}`);
  process.exit(1);
}

const workerUrl =
  values['worker-url'] ?? process.env.BUGZAR_WORKER_URL ?? 'https://bugzar-backend.workers.dev';
const adminSecret = process.env.BUGZAR_ADMIN_SECRET;

if (!adminSecret) {
  console.error('BUGZAR_ADMIN_SECRET 환경 변수가 필요해요.');
  console.error('  예) export BUGZAR_ADMIN_SECRET=$(cat ~/.bugzar-admin-secret)');
  process.exit(1);
}

const targetUrl = `${workerUrl.replace(/\/+$/, '')}/reports/${reportId}`;

if (values['dry-run']) {
  console.log('[dry-run] 다음 요청을 보낼 예정입니다:');
  console.log(`  curl -X DELETE -H 'Authorization: Bearer <REDACTED>' ${targetUrl}`);
  process.exit(0);
}

const res = await fetch(targetUrl, {
  method: 'DELETE',
  headers: { Authorization: `Bearer ${adminSecret}` },
});

let body;
try {
  body = await res.json();
} catch {
  body = { error: 'non-json response', status: res.status };
}

if (!res.ok) {
  console.error(`삭제 실패 (HTTP ${res.status}):`, body);
  process.exit(1);
}

console.log(`삭제 완료 — reportId=${body.reportId}, 제거된 파일=${body.deletedKeys}개`);
console.log('Jira 티켓 본문은 그대로 유지됩니다. 클릭 시 410 Gone 페이지가 표시됩니다.');
