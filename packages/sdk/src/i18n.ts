// Tiny i18n for the SDK's in-page UI (FAB, picker, terminal states). Language is
// auto-detected from the browser/system (navigator.languages), Korean when any
// preferred locale starts with "ko", English otherwise. No runtime switching —
// the widget reads the language once when it renders.

export type Lang = 'en' | 'ko';

export interface Strings {
  // FAB
  record: string;
  annotate: string;
  startRecording: string;
  stopRecording: string;
  annotateAria: string;
  // recording / upload terminal states
  stop: string;
  uploading: string;
  sent: string;
  viewReplay: string;
  viewReport: string;
  uploadFailed: string;
  retry: string;
  dismiss: string;
  openingReport: string;
  // offline export (no backend) — share chip
  replayReady: string;
  designReady: string;
  open: string;
  share: string;
  // picker
  pickHint: string;
  notePlaceholder: (tag: string) => string;
  figmaPlaceholder: string;
  add: string;
  save: string;
  edit: string;
  cancel: string;
  done: string;
  selected: (n: number) => string;
  remove: string;
  // jira review drawer
  jiraReportUploaded: string;
  jiraConnect: string;
  jiraConnecting: string;
  jiraConnectHint: string;
  jiraDisconnect: string;
  jiraSkip: string;
  jiraTitle: string;
  jiraDescription: string;
  jiraEpicOptional: string;
  jiraPublish: string;
  jiraPublishing: string;
  jiraIssueCreated: string;
  jiraOpenInJira: string;
  jiraAuthFailed: string;
  // jira review drawer — edit form
  drawerTitleBug: string;
  drawerTitleDesign: string;
  jiraEpic: string;
  titlePlaceholder: string;
  descriptionPlaceholder: string;
  epicSearchPlaceholder: string;
  epicSearching: string;
  epicNoResults: string;
  aiPolish: string;
  aiPolishing: string;
  aiPolishAria: string;
  aiUnavailable: string;
  aiStubbed: string;
  publish: string;
  publishFailed: string;
  close: string;
  draftCreated: string;
  draftNotFiledNote: string;
}

const EN: Strings = {
  record: 'Record',
  annotate: 'Design',
  startRecording: 'Start recording',
  stopRecording: 'Stop recording',
  annotateAria: 'Leave design feedback on elements',
  stop: 'Stop',
  uploading: 'Uploading…',
  sent: 'Sent',
  viewReplay: 'View replay',
  viewReport: 'View report',
  uploadFailed: 'Upload failed',
  retry: 'Retry',
  dismiss: 'Dismiss',
  openingReport: 'Opening report…',
  replayReady: 'Replay ready',
  designReady: 'Design report ready',
  open: 'Open',
  share: 'Share',
  pickHint: 'Click an element to leave design feedback',
  notePlaceholder: (tag) => `Note for <${tag}>…`,
  figmaPlaceholder: 'Figma link (optional)',
  add: 'Add',
  save: 'Save',
  edit: 'Edit',
  cancel: 'Cancel',
  done: 'Done',
  selected: (n) => `${n} selected`,
  remove: 'Remove',
  jiraReportUploaded: 'Report uploaded',
  jiraConnect: 'Connect Atlassian',
  jiraConnecting: 'Opening login…',
  jiraConnectHint: 'Authenticate once to file this as a Jira ticket. Saved in this browser only.',
  jiraDisconnect: 'Disconnect',
  jiraSkip: 'Skip, just keep the report',
  jiraTitle: 'Title',
  jiraDescription: 'Description',
  jiraEpicOptional: 'Epic (optional)',
  jiraPublish: 'File Jira ticket',
  jiraPublishing: 'Filing…',
  jiraIssueCreated: 'Ticket created',
  jiraOpenInJira: 'Open in Jira',
  jiraAuthFailed: 'Connection failed',
  drawerTitleBug: 'Report a bug',
  drawerTitleDesign: 'Design feedback',
  jiraEpic: 'Epic',
  titlePlaceholder: 'Short summary',
  descriptionPlaceholder: 'What happened?',
  epicSearchPlaceholder: 'Search epics…',
  epicSearching: 'Searching…',
  epicNoResults: 'No epics found',
  aiPolish: '✨AI Polish',
  aiPolishing: 'AI is Polishing…',
  aiPolishAria: 'AI polish',
  aiUnavailable: 'AI polish is unavailable right now — edit the fields and publish manually.',
  aiStubbed:
    'AI was skipped — this is a basic draft (daily limit reached or AI error). Review before publishing.',
  publish: 'Publish',
  publishFailed: 'Publish failed — try again.',
  close: 'Close',
  draftCreated: 'Draft created (not filed)',
  draftNotFiledNote:
    'Not a real Jira issue — the Worker is not configured with a service account, so nothing was filed.',
};

const KO: Strings = {
  record: '녹화',
  annotate: '디자인',
  startRecording: '녹화 시작',
  stopRecording: '녹화 중지',
  annotateAria: '요소에 디자인 피드백 남기기',
  stop: '중지',
  uploading: '업로드 중…',
  sent: '전송됨',
  viewReplay: '리플레이 보기',
  viewReport: '리포트 보기',
  uploadFailed: '업로드 실패',
  retry: '다시 시도',
  dismiss: '닫기',
  openingReport: '리포트 여는 중…',
  replayReady: '리플레이 준비됨',
  designReady: '디자인 리포트 준비됨',
  open: '열기',
  share: '공유',
  pickHint: '디자인 피드백을 남길 요소를 클릭하세요',
  notePlaceholder: (tag) => `<${tag}> 메모…`,
  figmaPlaceholder: 'Figma 링크 (선택)',
  add: '추가',
  save: '저장',
  edit: '수정',
  cancel: '취소',
  done: '완성',
  selected: (n) => `${n}개 선택됨`,
  remove: '삭제',
  jiraReportUploaded: '리포트 업로드됨',
  jiraConnect: 'Atlassian 연결',
  jiraConnecting: '로그인 창 여는 중…',
  jiraConnectHint:
    'Jira 티켓으로 발행하려면 한 번 인증하세요. 인증 정보는 이 브라우저에만 저장됩니다.',
  jiraDisconnect: '연결 해제',
  jiraSkip: '건너뛰고 리포트만 보기',
  jiraTitle: '제목',
  jiraDescription: '설명',
  jiraEpicOptional: '에픽 (선택)',
  jiraPublish: 'Jira 발행',
  jiraPublishing: '발행 중…',
  jiraIssueCreated: '티켓이 생성됐어요',
  jiraOpenInJira: 'Jira에서 열기',
  jiraAuthFailed: '연결 실패',
  drawerTitleBug: '버그 신고',
  drawerTitleDesign: '디자인 피드백',
  jiraEpic: '에픽',
  titlePlaceholder: '간단한 요약',
  descriptionPlaceholder: '무슨 일이 있었나요?',
  epicSearchPlaceholder: '에픽 검색…',
  epicSearching: '검색 중…',
  epicNoResults: '에픽을 찾을 수 없어요',
  aiPolish: '✨AI 다듬기',
  aiPolishing: 'AI가 다듬는 중…',
  aiPolishAria: 'AI 다듬기',
  aiUnavailable: 'AI 다듬기를 지금은 쓸 수 없어요 — 직접 입력하고 발행하세요.',
  aiStubbed: 'AI 미적용 — 기본 초안입니다 (한도 소진 또는 AI 오류). 발행 전 검토하세요.',
  publish: '발행',
  publishFailed: '발행 실패 — 다시 시도하세요.',
  close: '닫기',
  draftCreated: '초안 생성됨 (미발행)',
  draftNotFiledNote:
    '실제 Jira 이슈가 아니에요 — Worker에 서비스 계정이 설정되지 않아 아무것도 발행되지 않았어요.',
};

/** Korean when any preferred locale starts with "ko"; English otherwise. */
export function detectLang(): Lang {
  const nav = typeof navigator !== 'undefined' ? navigator : undefined;
  const locales = nav?.languages?.length ? nav.languages : [nav?.language ?? 'en'];
  return locales.some((l) => l.toLowerCase().startsWith('ko')) ? 'ko' : 'en';
}

export function getStrings(lang: Lang = detectLang()): Strings {
  return lang === 'ko' ? KO : EN;
}
