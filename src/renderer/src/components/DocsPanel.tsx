import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProjectDocRole, ProjectDocSnapshot } from '../../../shared/api';
import { renderSimpleMarkdown } from './simpleMarkdown';

interface DocsPanelProps {
  onGenerateDesignSpec(markdown: string): Promise<void>;
  generating: boolean;
}

type Mode = 'edit' | 'preview';

/** 左侧文稿：四类固定槽位 + 编辑/预览 + 复制 / Finder / 规范生图 */
export function DocsPanel({ onGenerateDesignSpec, generating }: DocsPanelProps) {
  const [docs, setDocs] = useState<ProjectDocSnapshot[]>([]);
  const [active, setActive] = useState<ProjectDocRole>('prd');
  const [mode, setMode] = useState<Mode>('edit');
  const [draft, setDraft] = useState('');
  const [status, setStatus] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const dirty = useRef(false);
  const activeRef = useRef(active);
  activeRef.current = active;

  const loadAll = useCallback(async () => {
    const list = await window.anye.listProjectDocs();
    setDocs(list);
    const current = list.find((doc) => doc.role === activeRef.current) ?? list[0];
    if (current && !dirty.current) {
      setActive(current.role);
      setDraft(current.content);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void loadAll();
    return window.anye.onProjectFsChange((change) => {
      if (change.kind !== 'docs') return;
      if (dirty.current) return;
      void loadAll();
    });
  }, [loadAll]);

  useEffect(() => {
    return () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
    };
  }, []);

  const selectDoc = async (role: ProjectDocRole) => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    if (dirty.current) {
      await window.anye.writeProjectDoc(active, draft);
      dirty.current = false;
    }
    const snap = await window.anye.readProjectDoc(role);
    setDocs((prev) => prev.map((doc) => (doc.role === role ? snap : doc)));
    setActive(role);
    setDraft(snap.content);
    setStatus(null);
  };

  const scheduleSave = (next: string) => {
    setDraft(next);
    dirty.current = true;
    setStatus('未保存…');
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      void window.anye.writeProjectDoc(active, next).then((snap) => {
        dirty.current = false;
        setDocs((prev) => prev.map((doc) => (doc.role === active ? snap : doc)));
        setStatus('已保存');
      });
    }, 400);
  };

  const current = docs.find((doc) => doc.role === active);

  return (
    <div className="docs-panel">
      <div className="docs-slots">
        {docs.map((doc) => (
          <button
            key={doc.role}
            type="button"
            className={`docs-slot ${doc.role === active ? 'active' : ''}`}
            onClick={() => void selectDoc(doc.role)}
            title={doc.relativePath}
          >
            <span className="docs-slot-label">{doc.label}</span>
            <span className="docs-slot-path dim">{doc.relativePath}</span>
          </button>
        ))}
      </div>

      {loading && <div className="docs-empty">加载文稿…</div>}
      {!loading && current && (
        <>
          <p className="docs-desc dim">{current.description}</p>
          <div className="docs-toolbar">
            <div className="segmented small">
              <button type="button" className={mode === 'edit' ? 'active' : ''} onClick={() => setMode('edit')}>
                编辑
              </button>
              <button type="button" className={mode === 'preview' ? 'active' : ''} onClick={() => setMode('preview')}>
                预览
              </button>
            </div>
            <button
              type="button"
              className="small"
              onClick={() => void window.anye.copyText(draft).then(() => setStatus('已复制全文'))}
            >
              复制全文
            </button>
            <button type="button" className="small" onClick={() => window.anye.revealInFinder(current.absolutePath)}>
              Finder
            </button>
            {active === 'designSpec' && (
              <button
                type="button"
                className="primary small"
                disabled={generating || !draft.trim()}
                onClick={() => void onGenerateDesignSpec(draft)}
              >
                {generating ? '生成中…' : '生成规范图'}
              </button>
            )}
          </div>
          {mode === 'edit' ? (
            <textarea
              className="docs-editor"
              value={draft}
              onChange={(event) => scheduleSave(event.target.value)}
              spellCheck={false}
            />
          ) : (
            <div className="docs-preview md-body">{renderSimpleMarkdown(draft)}</div>
          )}
          {status && <div className="docs-status dim">{status}</div>}
        </>
      )}
    </div>
  );
}
