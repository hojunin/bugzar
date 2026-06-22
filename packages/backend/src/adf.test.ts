import { describe, expect, it } from 'vitest';
import {
  type AdfNode,
  type BugDraft,
  type DesignDraft,
  jsonToBugAdf,
  jsonToDesignAdf,
  type SelectedElementLite,
} from './adf';

const sampleDraft = (overrides: Partial<BugDraft> = {}): BugDraft => ({
  title: '로그인 버튼 클릭 시 무한 로딩',
  overview: '로그인 버튼을 누르면 spinner 만 돌고 페이지가 전환되지 않음.',
  reproSteps: ['/login 진입', '이메일 / 비밀번호 입력', '로그인 버튼 클릭'],
  envBullets: ['URL: https://admin.example.com/login', '지속: 12s'],
  attachments: { consoleError: null, failedRequest: null },
  ...overrides,
});

describe('jsonToBugAdf', () => {
  it('builds a top-level ADF doc with version 1', () => {
    const adf = jsonToBugAdf(sampleDraft(), 'https://example.com/r/abc');
    expect(adf.type).toBe('doc');
    expect(adf.version).toBe(1);
    expect(Array.isArray(adf.content)).toBe(true);
  });

  it('emits four h2 headings in canonical order', () => {
    const adf = jsonToBugAdf(sampleDraft(), 'https://example.com/r/abc');
    const headings = adf.content
      .filter((n) => n.type === 'heading')
      .map((n) => n.content?.[0]?.text);
    expect(headings).toEqual(['개요', '재현 과정', '발생 환경', '첨부']);
  });

  it('renders reproSteps as an orderedList', () => {
    const adf = jsonToBugAdf(sampleDraft(), 'https://example.com/r/abc');
    const ordered = adf.content.find((n) => n.type === 'orderedList');
    expect(ordered).toBeDefined();
    expect(ordered?.content).toHaveLength(3);
    expect(ordered?.content?.[0]?.content?.[0]?.content?.[0]?.text).toBe('/login 진입');
  });

  it('renders envBullets as a bulletList', () => {
    const adf = jsonToBugAdf(sampleDraft(), 'https://example.com/r/abc');
    // Two bulletLists in the doc: env + attachments. Pick the env one (3rd block under headings).
    const bullets = adf.content.filter((n) => n.type === 'bulletList');
    expect(bullets).toHaveLength(2);
    expect(bullets[0]?.content).toHaveLength(2);
  });

  it('renders replay URL as a link in the 첨부 bulletList', () => {
    const url = 'https://example.com/r/xyz';
    const adf = jsonToBugAdf(sampleDraft(), url);
    const attachments = adf.content.filter((n) => n.type === 'bulletList')[1];
    const firstItemPara = attachments?.content?.[0]?.content?.[0];
    const linkNode = firstItemPara?.content?.find((c) => c.marks?.some((m) => m.type === 'link'));
    expect(linkNode?.marks?.[0]?.attrs?.href).toBe(url);
    expect(linkNode?.text).toBe(url);
  });

  it('omits consoleError / failedRequest attachments when null', () => {
    const adf = jsonToBugAdf(sampleDraft(), 'https://example.com/r/abc');
    const attachments = adf.content.filter((n) => n.type === 'bulletList')[1];
    expect(attachments?.content).toHaveLength(1); // just the replay link
  });

  it('appends consoleError as a codeBlock under its own listItem', () => {
    const adf = jsonToBugAdf(
      sampleDraft({
        attachments: {
          consoleError: 'TypeError: Cannot read property "x" of undefined',
          failedRequest: null,
        },
      }),
      'https://example.com/r/abc',
    );
    const attachments = adf.content.filter((n) => n.type === 'bulletList')[1];
    expect(attachments?.content).toHaveLength(2);
    const codeBlock = attachments?.content?.[1]?.content?.find((c) => c.type === 'codeBlock');
    expect(codeBlock?.content?.[0]?.text).toContain('TypeError');
  });

  it('appends failedRequest after consoleError when both present', () => {
    const adf = jsonToBugAdf(
      sampleDraft({
        attachments: {
          consoleError: 'oops',
          failedRequest: 'GET /api/me → 500',
        },
      }),
      'https://example.com/r/abc',
    );
    const attachments = adf.content.filter((n) => n.type === 'bulletList')[1];
    expect(attachments?.content).toHaveLength(3);
    const lastCode = attachments?.content?.[2]?.content?.find((c) => c.type === 'codeBlock');
    expect(lastCode?.content?.[0]?.text).toContain('500');
  });

  it('falls back to placeholder text when reproSteps is empty', () => {
    const adf = jsonToBugAdf(sampleDraft({ reproSteps: [] }), 'https://example.com/r/abc');
    const ordered = adf.content.find((n) => n.type === 'orderedList');
    expect(ordered?.content).toHaveLength(1);
    expect(ordered?.content?.[0]?.content?.[0]?.content?.[0]?.text).toContain('재현 과정');
  });

  it('falls back to placeholder text when envBullets is empty', () => {
    const adf = jsonToBugAdf(sampleDraft({ envBullets: [] }), 'https://example.com/r/abc');
    const envBullets = adf.content.filter((n) => n.type === 'bulletList')[0];
    expect(envBullets?.content).toHaveLength(1);
    expect(envBullets?.content?.[0]?.content?.[0]?.content?.[0]?.text).toContain('환경 정보 없음');
  });
});

// ────────────────────────────────────────────────────────────────────────
// jsonToDesignAdf (Phase 2 Task 19)
// ────────────────────────────────────────────────────────────────────────

const sampleDesignDraft = (overrides: Partial<DesignDraft> = {}): DesignDraft => ({
  title: '[디자인] 검색 헤더 정돈',
  overview: '헤더 영역의 검색 영역 간격과 폰트가 본문과 어울리지 않습니다.',
  items: [
    {
      selector: '.header > .search',
      location: '헤더의 검색 버튼',
      issue: '검색 아이콘과 입력창의 간격이 좁아 답답해 보입니다.',
      suggestion: 'padding 을 8px → 12px 로 늘리거나 아이콘 크기를 줄여 보세요.',
      severityHint: 'minor',
    },
    {
      selector: 'main h1',
      location: '본문 페이지 타이틀',
      issue: '폰트 크기가 다른 페이지 대비 작습니다.',
      suggestion: 'font-size 28px → 32px 로 통일 권장.',
      severityHint: 'major',
    },
  ],
  envBullets: ['URL: https://admin.example.com', '지속: 8s'],
  ...overrides,
});

const sampleElements: SelectedElementLite[] = [
  { id: 'abc123', selector: '.header > .search' },
  { id: 'def456', selector: 'main h1' },
];

const findHeadings = (content: AdfNode[], level: number): string[] =>
  content
    .filter((n) => n.type === 'heading' && (n.attrs?.level as number | undefined) === level)
    .map((n) => n.content?.[0]?.text ?? '');

describe('jsonToDesignAdf', () => {
  it('builds a top-level ADF doc with version 1', () => {
    const adf = jsonToDesignAdf(sampleDesignDraft(), 'https://example.com/r/abc', sampleElements);
    expect(adf.type).toBe('doc');
    expect(adf.version).toBe(1);
    expect(Array.isArray(adf.content)).toBe(true);
  });

  it('emits three h2 headings in canonical order', () => {
    const adf = jsonToDesignAdf(sampleDesignDraft(), 'https://example.com/r/abc', sampleElements);
    expect(findHeadings(adf.content, 2)).toEqual(['개요', '발생 환경', '첨부']);
  });

  it('emits one h3 sub-heading per item, numbered with location', () => {
    const adf = jsonToDesignAdf(sampleDesignDraft(), 'https://example.com/r/abc', sampleElements);
    expect(findHeadings(adf.content, 3)).toEqual(['1. 헤더의 검색 버튼', '2. 본문 페이지 타이틀']);
  });

  it('renders 자세히 보기 → link for each item with matching SelectedElement', () => {
    const adf = jsonToDesignAdf(sampleDesignDraft(), 'https://example.com/r/xyz', sampleElements);
    const links = adf.content
      .filter((n) => n.type === 'paragraph')
      .flatMap((n) => (n.content ?? []).filter((c) => c.marks?.some((m) => m.type === 'link')));
    const detailLinks = links.filter((c) => c.text === '자세히 보기 →');
    expect(detailLinks).toHaveLength(2);
    expect(detailLinks[0]?.marks?.[0]?.attrs?.href).toBe('https://example.com/r/xyz#el-abc123');
    expect(detailLinks[1]?.marks?.[0]?.attrs?.href).toBe('https://example.com/r/xyz#el-def456');
  });

  it('omits 자세히 보기 link when no element matches the item selector', () => {
    const adf = jsonToDesignAdf(sampleDesignDraft(), 'https://example.com/r/abc', []);
    const links = adf.content
      .filter((n) => n.type === 'paragraph')
      .flatMap((n) => (n.content ?? []).filter((c) => c.text === '자세히 보기 →'));
    expect(links).toHaveLength(0);
  });

  it('renders envBullets as a bulletList under 발생 환경', () => {
    const adf = jsonToDesignAdf(sampleDesignDraft(), 'https://example.com/r/abc', sampleElements);
    // First bulletList is env, second is attachments.
    const bullets = adf.content.filter((n) => n.type === 'bulletList');
    expect(bullets).toHaveLength(2);
    expect(bullets[0]?.content).toHaveLength(2);
  });

  it('drops Viewport / Browser / User-Agent env bullets (always-unknown noise)', () => {
    const draft = sampleDesignDraft({
      envBullets: [
        'URL: https://x.test',
        'Viewport: 1440×900',
        'Browser: Chrome',
        'User-Agent: Mozilla/5.0',
      ],
    });
    const env = jsonToDesignAdf(draft, '', sampleElements).content.filter(
      (n) => n.type === 'bulletList',
    )[0];
    const texts = env?.content?.map((li) => li.content?.[0]?.content?.[0]?.text);
    expect(texts).toEqual(['URL: https://x.test']);
  });

  it('renders replay URL as a link in the 첨부 bulletList', () => {
    const url = 'https://example.com/r/xyz';
    const adf = jsonToDesignAdf(sampleDesignDraft(), url, sampleElements);
    const bullets = adf.content.filter((n) => n.type === 'bulletList');
    const replayPara = bullets[1]?.content?.[0]?.content?.[0];
    const linkNode = replayPara?.content?.find((c) => c.marks?.some((m) => m.type === 'link'));
    expect(linkNode?.marks?.[0]?.attrs?.href).toBe(url);
  });

  it('falls back to a single placeholder item when items array is empty', () => {
    const adf = jsonToDesignAdf(sampleDesignDraft({ items: [] }), 'https://example.com/r/abc', []);
    const h3 = findHeadings(adf.content, 3);
    expect(h3).toHaveLength(1);
    expect(h3[0]).toContain('선택된 요소 없음');
  });
});
