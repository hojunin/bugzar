import { type ReactNode, useEffect, useRef } from 'react';
import { getStrings } from '../i18n';
import type { AuthState } from '../oauth/use-atlassian-auth';
import type { DesignAnnotation } from '../public-types';
import { DesignCards } from './DesignCards';
import { DrawerHeader } from './DrawerHeader';
import { EpicCombobox } from './EpicCombobox';
import type { AiPolish } from './useAiPolish';
import type { EpicSearch } from './useEpicSearch';
import type { Publish } from './usePublish';

type Mode = 'bug' | 'design';

interface DrawerFormProps {
  mode: Mode;
  oauth: boolean;
  authState: AuthState;
  disconnect: () => void;
  uploadedLink: ReactNode;
  annotations: DesignAnnotation[] | undefined;
  title: string;
  description: string;
  setTitle: (value: string) => void;
  setDescription: (value: string) => void;
  ai: AiPolish;
  epic: EpicSearch;
  pub: Publish;
  onClose: () => void;
}

/** The edit form: header, uploaded link, design cards, fields, epic combobox, actions. */
export function DrawerForm({
  mode,
  oauth,
  authState,
  disconnect,
  uploadedLink,
  annotations,
  title,
  description,
  setTitle,
  setDescription,
  ai,
  epic,
  pub,
  onClose,
}: DrawerFormProps) {
  const t = getStrings();
  const titleRef = useRef<HTMLInputElement>(null);

  // Focus the Title field once the form is shown — this component mounts then.
  useEffect(() => {
    titleRef.current?.focus();
  }, []);

  // An epic is required — the project is derived from it (`BUGZAR-123` → `BUGZAR`).
  const canPublish = title.trim().length > 0 && !!epic.key && pub.phase !== 'publishing';

  return (
    <>
      <DrawerHeader
        title={mode === 'design' ? t.drawerTitleDesign : t.drawerTitleBug}
        oauth={oauth}
        authState={authState}
        disconnect={disconnect}
      />

      {uploadedLink}

      {mode === 'design' ? <DesignCards annotations={annotations} /> : null}

      <label className="bugzar-field">
        <span className="bugzar-field-label">{t.jiraTitle}</span>
        <input
          ref={titleRef}
          className="bugzar-input"
          aria-label={t.jiraTitle}
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          disabled={ai.busy}
          placeholder={t.titlePlaceholder}
        />
      </label>

      <label className="bugzar-field">
        <span className="bugzar-field-label">{t.jiraDescription}</span>
        <textarea
          className="bugzar-textarea"
          aria-label={t.jiraDescription}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
          disabled={ai.busy}
          rows={5}
          placeholder={t.descriptionPlaceholder}
        />
      </label>

      <EpicCombobox epic={epic} />

      {ai.error && <output className="bugzar-ai-error">{t.aiUnavailable}</output>}
      {ai.stubbed && !ai.error && <output className="bugzar-ai-note">{t.aiStubbed}</output>}

      <div className="bugzar-drawer-actions">
        <button
          type="button"
          className="bugzar-btn"
          aria-label={t.aiPolishAria}
          onClick={ai.polish}
          disabled={ai.busy}
        >
          <span aria-hidden="true">{ai.busy ? t.aiPolishing : t.aiPolish}</span>
        </button>
        <span className="bugzar-spacer" />
        <button type="button" className="bugzar-btn bugzar-btn-ghost" onClick={onClose}>
          {t.cancel}
        </button>
        <button
          type="button"
          className="bugzar-btn bugzar-btn-primary"
          onClick={pub.publish}
          disabled={!canPublish}
        >
          {oauth ? t.jiraPublish : t.publish}
        </button>
      </div>
      {pub.error && (
        <div className="bugzar-ai-error" role="alert">
          {t.publishFailed}
        </div>
      )}
    </>
  );
}
