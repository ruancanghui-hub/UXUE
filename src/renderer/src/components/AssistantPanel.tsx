import { useEffect, useRef, useState } from 'react';
import { formatUsd } from '../../../shared/generation';
import type { DocState } from '../document/operations';
import type { AssistantMessage, AssistantSession } from '../project/AssistantSession';
import { activeTheme } from '../project/GenerationTracker';

interface AssistantPanelProps {
  assistant: AssistantSession;
  state: DocState;
  selectedIds: ReadonlySet<string>;
  projectName: string;
  providerLabel: string;
  onSelectCards(ids: string[]): void;
}

export function AssistantPanel({ assistant, state, selectedIds, projectName, providerLabel, onSelectCards }: AssistantPanelProps) {
  const [messages, setMessages] = useState<AssistantMessage[]>(() => assistant.list());
  const [busy, setBusy] = useState(() => assistant.isBusy());
  const [draft, setDraft] = useState('');
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
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [messages.length, busy]);

  const images = assistant.contextImages();
  const theme = activeTheme(state);
  const selectedPrompts = state.cards.filter((card) => card.kind === 'prompt' && selectedIds.has(card.id)).length;

  const send = (text: string): void => {
    if (!text.trim() || busy) return;
    setDraft('');
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

  return (
    <div className="assistant">
      <div className="assistant-context">
        <span className="field-label">上下文</span>
        <span className="chip">{images.length ? `${images.length} 张图` : '没有选中图'}</span>
        {selectedPrompts > 0 && <span className="chip">{selectedPrompts} 张提示词卡</span>}
        <span className="chip">{theme ? `主题卡「${theme.name}」` : '没有生效主题卡'}</span>
        <span className="chip dim">{providerLabel}</span>
      </div>

      <div className="assistant-actions">
        <button onClick={() => prefill(`为「${projectName}」生成一套视觉主题`, '」生成一套视觉主题'.length)}>生成主题卡</button>
        <button disabled={!images.length || busy} onClick={() => send('反推选中的图，写成能复用这种风格的提示词')}>
          反推选中的图
        </button>
        <button disabled={!images.length || busy} onClick={() => prefill('给选中的图各写一条提示词：')}>
          给选中的图各写一条提示词
        </button>
      </div>

      <div className="assistant-messages" ref={listRef}>
        {messages.length === 0 && (
          <p className="hint">
            助手只往画布上放主题卡和提示词卡，不会自己发起生成。选中几张图再提问，它会把这些图当作上下文；写好的提示词卡会自动绑定对应的图。
          </p>
        )}
        {messages.map((message) => (
          <div key={message.id} className={`bubble ${message.role} ${message.error ? 'error' : ''}`}>
            <div className="bubble-text">{message.text}</div>
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

      <textarea
        ref={inputRef}
        className="assistant-input"
        value={draft}
        placeholder="问助手…（回车发送，Shift + 回车换行）"
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => {
          // 输入法正在组字时的回车是确认候选词，不能发送
          if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) {
            event.preventDefault();
            send(draft);
          }
        }}
        aria-label="问助手"
      />
    </div>
  );
}
