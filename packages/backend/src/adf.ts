/**
 * Atlassian Document Format (ADF) builders for Jira description bodies.
 *
 * Jira Cloud's REST API expects descriptions as ADF — a structured JSON tree,
 * not markdown. Each top-level Bug / Design report section is a `heading` +
 * a list/paragraph block. The shapes are loosely typed (ADF nodes have many
 * optional attrs) so we keep the inputs narrow and let the JSON be `unknown`
 * to Jira's parser — invalid ADF is a hard 400 on creation, which we catch
 * upstream.
 *
 * Tests in `adf.test.ts` cover the node-by-node structure since visual
 * regression on a JSON tree is the only practical way to verify ADF.
 */

export type AdfNode = {
  type: string;
  attrs?: Record<string, unknown>;
  content?: AdfNode[];
  marks?: Array<{ type: string; attrs?: Record<string, unknown> }>;
  text?: string;
};

export type AdfDoc = {
  type: 'doc';
  version: 1;
  content: AdfNode[];
};

/**
 * Structured LLM output for the Bug (영상 모드) form. Mirrors the schema in
 * `jira-draft.ts` — keep the two in sync if you change one.
 */
export interface BugDraft {
  title: string;
  overview: string;
  reproSteps: string[];
  envBullets: string[];
  attachments: {
    consoleError: string | null;
    failedRequest: string | null;
  };
}

/**
 * Structured LLM output for the Design (디자인 모드) form. Each `item`
 * corresponds to one element the user selected on the page; the LLM's job
 * is to turn the user's terse memo into a readable issue + suggestion.
 *
 * The `selector` is echoed straight from the input — the model is told
 * never to invent or modify it — so `jsonToDesignAdf` can re-join each
 * item to its `SelectedElement` (for the "자세히 보기 →" deep link).
 */
export interface DesignDraft {
  title: string;
  overview: string;
  items: Array<{
    selector: string;
    location: string;
    issue: string;
    suggestion: string;
    severityHint: 'minor' | 'major' | 'critical';
  }>;
  envBullets: string[];
}

/**
 * Minimal SelectedElement shape the ADF builder needs — full type lives in
 * `@bugzar/shared` (extension package). Duplicated narrowly here so the
 * backend stays standalone (no extension dep).
 */
export interface SelectedElementLite {
  id: string;
  selector: string;
}

const heading = (level: 1 | 2 | 3, text: string): AdfNode => ({
  type: 'heading',
  attrs: { level },
  content: [{ type: 'text', text }],
});

const paragraph = (text: string): AdfNode => ({
  type: 'paragraph',
  content: text ? [{ type: 'text', text }] : [],
});

const listItem = (text: string): AdfNode => ({
  type: 'listItem',
  content: [paragraph(text)],
});

const orderedList = (items: string[]): AdfNode => ({
  type: 'orderedList',
  content: items.map(listItem),
});

const bulletList = (items: AdfNode[]): AdfNode => ({
  type: 'bulletList',
  content: items,
});

const link = (label: string, href: string): AdfNode => ({
  type: 'text',
  text: label,
  marks: [{ type: 'link', attrs: { href } }],
});

const linkListItem = (label: string, prefix: string, href: string): AdfNode => ({
  type: 'listItem',
  content: [
    {
      type: 'paragraph',
      content: [{ type: 'text', text: prefix }, link(label, href)],
    },
  ],
});

const codeBlock = (text: string): AdfNode => ({
  type: 'codeBlock',
  content: [{ type: 'text', text }],
});

// Viewport / Browser / User-Agent env bullets are dropped from the published
// ticket: the report-less flow doesn't capture this, so they were always
// "(unknown)" noise. Falls back to the placeholder if nothing else remains.
const ENV_HIDE = /^\s*(?:viewport|browser|user[-\s]?agent|ua)\s*[:：]/i;
const envBulletItems = (bullets: string[]): AdfNode[] => {
  const visible = bullets.filter((b) => !ENV_HIDE.test(b));
  return (visible.length ? visible : ['(환경 정보 없음)']).map(listItem);
};

/**
 * Build an ADF document for the Bug form. `replayUrl` is rendered as the
 * first 첨부 list item; consoleError / failedRequest fall through if null.
 */
export const jsonToBugAdf = (draft: BugDraft, replayUrl: string): AdfDoc => {
  // `replayUrl` is the consumer's R2/S3 URL; empty (no `onExport`) → no link node.
  const attachmentItems: AdfNode[] = replayUrl
    ? [linkListItem(replayUrl, 'Replay: ', replayUrl)]
    : [];
  if (draft.attachments.consoleError) {
    attachmentItems.push({
      type: 'listItem',
      content: [paragraph('첫 console error:'), codeBlock(draft.attachments.consoleError)],
    });
  }
  if (draft.attachments.failedRequest) {
    attachmentItems.push({
      type: 'listItem',
      content: [paragraph('실패한 요청:'), codeBlock(draft.attachments.failedRequest)],
    });
  }

  const content: AdfNode[] = [
    heading(2, '개요'),
    paragraph(draft.overview),
    heading(2, '재현 과정'),
    orderedList(draft.reproSteps.length ? draft.reproSteps : ['(재현 과정이 비어 있음)']),
    heading(2, '발생 환경'),
    bulletList(envBulletItems(draft.envBullets)),
  ];
  if (attachmentItems.length) {
    content.push(heading(2, '첨부'), bulletList(attachmentItems));
  }
  return { type: 'doc', version: 1, content };
};

/**
 * Build an ADF document for the Design (디자인 모드) form. Each item becomes
 * an h3 sub-section (`1. 헤더의 검색 버튼`) with three lines (이슈 / 제안 /
 * Severity) plus, when the source element is known, a "자세히 보기 →" link
 * that jumps to the matching anchor in the design viewer (`#el-<id>`).
 */
export const jsonToDesignAdf = (
  draft: DesignDraft,
  replayUrl: string,
  elements: SelectedElementLite[] = [],
): AdfDoc => {
  const content: AdfNode[] = [heading(2, '개요'), paragraph(draft.overview)];

  const items = draft.items.length
    ? draft.items
    : [
        {
          selector: '',
          location: '(선택된 요소 없음)',
          issue: '(이슈 설명 없음)',
          suggestion: '(제안 없음)',
          severityHint: 'minor' as const,
        },
      ];

  items.forEach((item, idx) => {
    content.push(heading(3, `${idx + 1}. ${item.location || '(위치 미상)'}`));
    content.push(paragraph(`이슈: ${item.issue}`));
    content.push(paragraph(`제안: ${item.suggestion}`));
    content.push(paragraph(`Severity: ${item.severityHint}`));
    const el = item.selector ? elements.find((e) => e.selector === item.selector) : undefined;
    if (el && replayUrl) {
      content.push({
        type: 'paragraph',
        content: [link('자세히 보기 →', `${replayUrl}#el-${el.id}`)],
      });
    }
  });

  content.push(heading(2, '발생 환경'));
  content.push(bulletList(envBulletItems(draft.envBullets)));
  if (replayUrl) {
    content.push(heading(2, '첨부'));
    content.push(bulletList([linkListItem(replayUrl, 'Replay: ', replayUrl)]));
  }

  return { type: 'doc', version: 1, content };
};
