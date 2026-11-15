import { useEffect, useRef, useState } from 'react';
import { formatUsd } from '../../../shared/generation';
import { isBlockCard, isPageCard, type PageCard } from '../../../shared/project';
import { pageBlocks, type DocState } from '../document/operations';
import type { AssistantMessage, AssistantSession } from '../project/AssistantSession';
import { activeTheme } from '../project/GenerationTracker';
import { renderSimpleMarkdown } from './simpleMarkdown';

interface AssistantPanelProps {
  assistant: AssistantSession;
  state: DocState;
  selectedIds: ReadonlySet<string>;
  projectName: string;
  providerLabel: string;
  onSelectCards(ids: string[]): void;
}

interface Suggestion {
  id: string;
  label: string;
  disabled?: boolean;
  title?: string;
  run(): void;
}

/** 选中了恰好一个页面框，或者选中的区块都属于同一个页面框 */
function selectedPageOf(state: DocState, selectedIds: ReadonlySet<string>): PageCard | null {
  const pageIds = new Set<string>();
  for (const card of state.cards) {
    if (!selectedIds.has(card.id)) continue;
    if (isPageCard(card)) pageIds.add(card.id);
    else if (isBlockCard(card)) pageIds.add(card.pageId);
  }
  if (pageIds.size !== 1) return null;
  const [id] = pageIds;
  return state.cards.find((card): card is PageCard => card.id === id && isPageCard(card)) ?? null;
}

const STICK_THRESHOLD_PX = 48;

export function AssistantPanel({ assistant, state, selectedIds, projectName, providerLabel, onSelectCards }: AssistantPanelProps) {
  const [messages, setMessages] = useState<AssistantMessage[]>(() => assistant.list());
  const [busy, setBusy] = useState(() => assistant.isBusy());
  const [draft, setDraft] = useState('');
  const [stuckToBottom, setStuckToBottom] = useState(true);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const sync = (): void => {
      setMessages(assistant.list());
      setBusy(assistant.isBusy());
    };
    sync();
    return assistant.subscribe(sync);
  }, [assistant]);

  useEffect(() => {
    if (!stuckToBottom) return;
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy, stuckToBottom]);

  const images = assistant.contextImages();
  const theme = activeTheme(state);
  const selectedPrompts = state.cards.filter((card) => card.kind === 'prompt' && selectedIds.has(card.id)).length;
  const selectedPage = selectedPageOf(state, selectedIds);
  const selectedImages = assistant.selectedImageCards();

  const send = (text: string): void => {
    if (!text.trim() || busy) return;
    setDraft('');
    setStuckToBottom(true);
    void assistant.send(text);
  };
  const prefill = (text: string, caretFromEnd = 0): void => {
    setDraft(text);
    requestAnimationFrame(() => {
      const element = inputRef.current;
      if (!element) return;
      element.focus();
      const position = text.length - caretFromEnd;
      element.setSelectionRange(position, position);
    });
  };

  const suggestions: Suggestion[] = [
    {
      id: 'theme',
      label: selectedImages.length === 1 ? '从选中的参考图提炼主题卡' : '生成主题卡',
      disabled: busy,
      run: () => {
        if (selectedImages.length >= 2) {
          setStuckToBottom(true);
          void assistant.send('从选中的参考图提炼主题卡');
          return;
        }
        if (selectedImages.length === 1) {
          send('从选中的参考图提炼主题卡');
          return;
        }
        prefill(`为「${projectName}」生成一套视觉主题`, '」生成一套视觉主题'.length);
      },
    },
    {
      id: 'reverse',
      label: '反推选中的图',
      disabled: !images.length || busy,
      run: () => send('反推选中的图，写成能复用这种风格的提示词'),
    },
    {
      id: 'prompts',
      label: '给选中的图各写一条提示词',
      disabled: !images.length || busy,
      run: () => prefill('给选中的图各写一条提示词：'),
    },
    {
      id: 'elements',
      label: '从主题卡列出素材清单',
      disabled: !theme || busy,
      title: '输入框里的文字会当作范围说明，比如「个人页要用的」',
      run: () => {
        const scope = draft;
        setDraft('');
        setStuckToBottom(true);
        void assistant.listElements(scope);
      },
    },
  ];
  if (selectedPage) {
    suggestions.push(
      {
        id: 'decompose',
        label: '拆解选中的页面',
        disabled: busy || !selectedPage.base,
        run: () => {
          setStuckToBottom(true);
          void assistant.decomposePage(selectedPage.id);
        },
      },
      {
        id: 'block-prompts',
        label: '为区块写提示词',
        disabled: busy || pageBlocks(state, selectedPage.id).length === 0,
        run: () => {
          setStuckToBottom(true);
          void assistant.writeBlockPrompts(selectedPage.id);
        },
      },
    );
  }

  const onListScroll = (): void => {
    const el = listRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    setStuckToBottom(distance <= STICK_THRESHOLD_PX);
  };

  const jumpToLatest = (): void => {
    setStuckToBottom(true);
    const el = listRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'smooth' });
  };

  const chips = (
    <div className="assistant-suggestions">
      {suggestions.map((item) => (
        <button key={item.id} type="button" className="suggestion-chip" disabled={item.disabled} title={item.title} onClick={item.run}>
          {item.label}
        </button>
      ))}
    </div>
  );

  return (
    <div className="assistant">
      <div className="assistant-context">
        <span className="chip">{images.length ? `${images.length} 张图` : '没有选中图'}</span>
        {selectedPrompts > 0 && <span className="chip">{selectedPrompts} 张提示词卡</span>}
        <span className="chip">{theme ? `主题「${theme.name}」` : '无生效主题'}</span>
        <span className="chip dim">{providerLabel}</span>
      </div>

      <div className="assistant-messages" ref={listRef} onScroll={onListScroll}>
        {messages.length === 0 && !busy && (
          <div className="assistant-empty">
            <p className="assistant-empty-title">问助手</p>
            <p className="assistant-empty-body">
              助手只往画布上放主题卡和提示词卡，不会自己发起生成。选中几张图再提问，它会把这些图当作上下文；写好的提示词卡会自动绑定对应的图。
            </p>
            {chips}
          </div>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`bubble ${message.role} ${message.error ? 'error' : ''}`}>
            <div className="bubble-text">
              {message.role === 'assistant' && !message.error ? renderSimpleMarkdown(message.text) : message.text}
            </div>
            {message.created && (message.created.themeId || message.created.promptIds.length > 0) && (
              <button
                className="link"
                onClick={() => onSelectCards([...(message.created!.themeId ? [message.created!.themeId] : []), ...message.created!.promptIds])}
              >
                选中新建的 {message.created.themeId ? '主题卡' : ''}
                {message.created.themeId && message.created.promptIds.length ? '和 ' : ''}
                {message.created.promptIds.length ? `${message.created.promptIds.length} 张提示词卡` : ''}
              </button>
            )}
            {message.costUsd !== undefined && message.provider === 'openai' && <div className="bubble-meta">{formatUsd(message.costUsd)}</div>}
          </div>
        ))}
        {busy && <div className="bubble assistant pending">思考中…</div>}
      </div>

      {!stuckToBottom && (
        <button type="button" className="assistant-jump" onClick={jumpToLatest}>
          ↓ 最新
        </button>
      )}

      <div className="assistant-composer">
        {messages.length > 0 && chips}
        <textarea
          ref={inputRef}
          className="assistant-input"
          value={draft}
          placeholder="问助手…（Enter 发送，Shift+Enter 换行）"
          rows={3}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              send(draft);
            }
          }}
          aria-label="问助手"
        />
      </div>
    </div>
  );
}
