import { useEffect, useMemo, useRef, useState } from 'react';
import type { MenuCommand } from '../../../shared/api';

export interface PaletteCommand {
  id: MenuCommand;
  label: string;
  hint?: string;
}

interface CommandPaletteProps {
  open: boolean;
  commands: PaletteCommand[];
  onRun(command: MenuCommand): void;
  onClose(): void;
}

export function CommandPalette({ open, commands, onRun, onClose }: CommandPaletteProps) {
  const [query, setQuery] = useState('');
  const [index, setIndex] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((command) => fuzzyIncludes(command.label.toLowerCase(), q) || fuzzyIncludes(command.id.toLowerCase(), q));
  }, [commands, query]);

  useEffect(() => {
    if (!open) return;
    setQuery('');
    setIndex(0);
    const timer = requestAnimationFrame(() => inputRef.current?.focus());
    return () => cancelAnimationFrame(timer);
  }, [open]);

  useEffect(() => {
    setIndex(0);
  }, [query]);

  if (!open) return null;

  const active = filtered[Math.min(index, Math.max(filtered.length - 1, 0))];

  const run = (command: MenuCommand): void => {
    onClose();
    onRun(command);
  };

  return (
    <div
      className="command-palette-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command-palette" role="dialog" aria-label="命令面板">
        <input
          ref={inputRef}
          className="command-palette-input"
          value={query}
          placeholder="输入命令…"
          aria-label="过滤命令"
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              onClose();
              return;
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setIndex((value) => Math.min(value + 1, Math.max(filtered.length - 1, 0)));
              return;
            }
            if (event.key === 'ArrowUp') {
              event.preventDefault();
              setIndex((value) => Math.max(value - 1, 0));
              return;
            }
            if (event.key === 'Enter' && active) {
              event.preventDefault();
              run(active.id);
            }
          }}
        />
        <div className="command-palette-list">
          {filtered.length === 0 && <div className="command-palette-empty">没有匹配的命令</div>}
          {filtered.map((command, i) => (
            <button
              key={command.id}
              className={`command-palette-item ${command === active ? 'active' : ''}`}
              onMouseEnter={() => setIndex(i)}
              onClick={() => run(command.id)}
            >
              <span>{command.label}</span>
              {command.hint && <kbd>{command.hint}</kbd>}
            </button>
          ))}
        </div>
      </div>
    </div>
  );
}

/** 子序列匹配：查询字符按顺序出现在目标里即可 */
function fuzzyIncludes(haystack: string, needle: string): boolean {
  if (haystack.includes(needle)) return true;
  let from = 0;
  for (const char of needle) {
    const at = haystack.indexOf(char, from);
    if (at < 0) return false;
    from = at + 1;
  }
  return true;
}
