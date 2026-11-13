import { Container, Graphics, Text } from 'pixi.js';
import { QUALITIES, SIZE_OPTIONS } from '../../../shared/generation';
import type { PromptCard } from '../../../shared/project';

/** 画布上要显示的生成状态；null 表示空闲 */
export type PromptJobView =
  | { status: 'queued'; startedAt: number; aspect: number }
  | { status: 'running'; startedAt: number; aspect: number }
  | { status: 'failed'; error: string }
  | null;

const PADDING = 14;
const HEADER_HEIGHT = 30;
const FOOTER_HEIGHT = 30;
const FONT = 'PingFang SC, -apple-system, sans-serif';
const BG = 0x1c1e29;
const BORDER = 0x343850;
const TEXT = 0xe8e8ee;
const DIM = 0x8d8d99;
const ACCENT = 0x9aa6ff;
const BAD = 0xff6b7a;
const BODY_CHAR_LIMIT = 600;

/** 一张提示词卡的 Pixi 节点：背景、标题、正文（超出部分裁掉）、底部状态 */
export class PromptNode {
  readonly container = new Container();
  private readonly bg = new Graphics();
  private readonly clip = new Graphics();
  private readonly header: Text;
  private readonly body: Text;
  private readonly footer: Text;
  private signature = '';

  constructor() {
    this.header = new Text({ text: '', style: { fontFamily: FONT, fontSize: 13, fontWeight: '600', fill: ACCENT } });
    this.body = new Text({
      text: '',
      style: { fontFamily: FONT, fontSize: 15, fill: TEXT, wordWrap: true, breakWords: true, lineHeight: 22 },
    });
    this.footer = new Text({ text: '', style: { fontFamily: FONT, fontSize: 12, fill: DIM } });
    this.body.mask = this.clip;
    this.container.addChild(this.bg, this.clip, this.header, this.body, this.footer);
  }

  /** 内容没变时什么也不做；运行中的任务每秒更新一次计时 */
  update(card: PromptCard, inputCount: number, job: PromptJobView, now: number): void {
    const footer = footerText(card, inputCount, job, now);
    const signature = [card.width, card.height, card.name, card.text, footer, job?.status ?? ''].join('\u0000');
    if (signature === this.signature) return;
    this.signature = signature;

    const { width, height } = card;
    this.bg.clear();
    this.bg
      .roundRect(0, 0, width, height, 12)
      .fill({ color: BG })
      .stroke({ color: job?.status === 'failed' ? BAD : BORDER, width: 1.5, alignment: 1 });
    this.bg.moveTo(PADDING, HEADER_HEIGHT).lineTo(width - PADDING, HEADER_HEIGHT).stroke({ color: BORDER, width: 1 });

    this.header.text = `✎ ${card.name}`;
    this.header.position.set(PADDING, 8);

    const bodyHeight = Math.max(0, height - HEADER_HEIGHT - FOOTER_HEIGHT - 8);
    this.body.text = card.text.trim() ? truncate(card.text) : '双击编辑提示词';
    this.body.style.fill = card.text.trim() ? TEXT : DIM;
    this.body.style.wordWrapWidth = Math.max(40, width - PADDING * 2);
    this.body.position.set(PADDING, HEADER_HEIGHT + 8);
    this.clip.clear();
    this.clip.rect(PADDING, HEADER_HEIGHT + 8, width - PADDING * 2, bodyHeight).fill({ color: 0xffffff });

    this.footer.text = footer;
    this.footer.style.fill = job?.status === 'failed' ? BAD : job ? ACCENT : DIM;
    this.footer.position.set(PADDING, height - FOOTER_HEIGHT + 8);
  }

  /** 文字按当前缩放重新栅格化，放大后依然清晰 */
  setTextResolution(resolution: number): void {
    for (const text of [this.header, this.body, this.footer]) {
      if (Math.abs(text.resolution - resolution) > 0.01) text.resolution = resolution;
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }
}

function footerText(card: PromptCard, inputCount: number, job: PromptJobView, now: number): string {
  if (job?.status === 'queued') return '排队中…';
  if (job?.status === 'running') return `生成中 ${Math.floor((now - job.startedAt) / 1000)}s`;
  if (job?.status === 'failed') return `失败：${job.error.slice(0, 40)}`;
  const quality = QUALITIES.find((q) => q.id === card.settings.quality)?.label ?? card.settings.quality;
  const size = SIZE_OPTIONS.find((s) => s.id === card.settings.size)?.label ?? card.settings.size;
  return `${inputCount} 张输入 · ×${card.settings.count} · ${quality} · ${size}`;
}

function truncate(text: string): string {
  return text.length > BODY_CHAR_LIMIT ? `${text.slice(0, BODY_CHAR_LIMIT)}…` : text;
}
