import { Fragment, type ReactNode } from 'react';

/** 极简 Markdown → React；不执行 HTML，只覆盖规格里的基础语法 */
export function renderSimpleMarkdown(source: string): ReactNode {
  const blocks = splitBlocks(source.replace(/\r\n/g, '\n'));
  return blocks.map((block, index) => {
    if (block.type === 'code') {
      return (
        <pre key={index} className="md-code">
          <code>{block.text}</code>
        </pre>
      );
    }
    if (block.type === 'ul' || block.type === 'ol') {
      const Tag = block.type === 'ul' ? 'ul' : 'ol';
      return (
        <Tag key={index} className="md-list">
          {block.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </Tag>
      );
    }
    return (
      <p key={index} className="md-p">
        {renderInline(block.text)}
      </p>
    );
  });
}

type Block =
  | { type: 'p'; text: string }
  | { type: 'code'; text: string }
  | { type: 'ul'; items: string[] }
  | { type: 'ol'; items: string[] };

function splitBlocks(source: string): Block[] {
  const lines = source.split('\n');
  const blocks: Block[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith('```')) {
      i += 1;
      const body: string[] = [];
      while (i < lines.length && !lines[i].startsWith('```')) {
        body.push(lines[i]);
        i += 1;
      }
      if (i < lines.length) i += 1;
      blocks.push({ type: 'code', text: body.join('\n') });
      continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ul', items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ''));
        i += 1;
      }
      blocks.push({ type: 'ol', items });
      continue;
    }
    if (line.trim() === '') {
      i += 1;
      continue;
    }
    const para: string[] = [line];
    i += 1;
    while (i < lines.length && lines[i].trim() !== '' && !lines[i].startsWith('```') && !/^\s*[-*]\s+/.test(lines[i]) && !/^\s*\d+\.\s+/.test(lines[i])) {
      para.push(lines[i]);
      i += 1;
    }
    blocks.push({ type: 'p', text: para.join('\n') });
  }
  return blocks.length ? blocks : [{ type: 'p', text: '' }];
}

function renderInline(text: string): ReactNode {
  const nodes: ReactNode[] = [];
  const pattern = /(\*\*[^*]+\*\*|`[^`]+`)/g;
  let last = 0;
  let match: RegExpExecArray | null;
  let key = 0;
  while ((match = pattern.exec(text))) {
    if (match.index > last) nodes.push(<Fragment key={key++}>{text.slice(last, match.index)}</Fragment>);
    const token = match[0];
    if (token.startsWith('**')) {
      nodes.push(<strong key={key++}>{token.slice(2, -2)}</strong>);
    } else {
      nodes.push(
        <code key={key++} className="md-inline-code">
          {token.slice(1, -1)}
        </code>,
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(<Fragment key={key++}>{text.slice(last)}</Fragment>);
  return nodes;
}
