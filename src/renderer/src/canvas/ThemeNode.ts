import { Container, Graphics, Text } from 'pixi.js';
import { RULE_LABELS, type ThemeCard, type ThemeRules } from '../../../shared/project';

const PADDING = 16;
const FONT = 'PingFang SC, -apple-system, sans-serif';
const BG = 0x1d1b23;
const BORDER = 0x3a3448;
const ACTIVE = 0xf5c46b;
const TEXT = 0xe8e8ee;
const DIM = 0x8d8d99;
const SWATCH = 46;
const SWATCH_GAP = 10;

/** 主题卡节点：标题与"生效中"标记、产品主题、关键词与线索、色板色块、统一规则 */
export class ThemeNode {
  readonly container = new Container();
  private readonly bg = new Graphics();
  private readonly swatches = new Graphics();
  private readonly clip = new Graphics();
  private readonly title: Text;
  private readonly badge: Text;
  private readonly body: Text;
  private readonly rules: Text;
  private readonly hexLabels: Text[] = [];
  private signature = '';

  constructor() {
    this.title = new Text({ text: '', style: { fontFamily: FONT, fontSize: 15, fontWeight: '700', fill: TEXT } });
    this.badge = new Text({ text: '生效中', style: { fontFamily: FONT, fontSize: 11, fontWeight: '700', fill: 0x1d1b23 } });
    this.body = new Text({ text: '', style: { fontFamily: FONT, fontSize: 13, fill: TEXT, wordWrap: true, breakWords: true, lineHeight: 20 } });
    this.rules = new Text({ text: '', style: { fontFamily: FONT, fontSize: 12, fill: DIM, wordWrap: true, breakWords: true, lineHeight: 18 } });
    this.rules.mask = this.clip;
    this.container.addChild(this.bg, this.swatches, this.clip, this.title, this.badge, this.body, this.rules);
  }

  update(card: ThemeCard, active: boolean): void {
    const signature = JSON.stringify([card, active]);
    if (signature === this.signature) return;
    this.signature = signature;
    const { width, height } = card;
    const inner = Math.max(40, width - PADDING * 2);

    this.bg.clear();
    this.bg.roundRect(0, 0, width, height, 14).fill({ color: BG }).stroke({ color: active ? ACTIVE : BORDER, width: active ? 2.5 : 1.5, alignment: 1 });

    this.title.text = `◆ ${card.name}`;
    this.title.position.set(PADDING, PADDING);
    this.badge.visible = active;
    if (active) {
      const badgeX = width - PADDING - this.badge.width - 12;
      this.bg.roundRect(badgeX, PADDING - 1, this.badge.width + 12, this.badge.height + 4, 6).fill({ color: ACTIVE });
      this.badge.position.set(badgeX + 6, PADDING + 1);
    }

    const lines = [
      card.topic ? `产品主题　${card.topic}` : '',
      card.keywords.length ? `关键词　${card.keywords.join(' · ')}` : '',
      card.cues.length ? `视觉线索　${card.cues.join(' · ')}` : '',
    ].filter(Boolean);
    this.body.text = lines.join('\n') || '在右侧填写产品主题、关键词和配色';
    this.body.style.fill = lines.length ? TEXT : DIM;
    this.body.style.wordWrapWidth = inner;
    let y = PADDING + 30;
    this.body.position.set(PADDING, y);
    y += this.body.height + 14;

    this.swatches.clear();
    const perRow = Math.max(1, Math.floor((inner + SWATCH_GAP) / (SWATCH + SWATCH_GAP)));
    card.palette.forEach((color, index) => {
      const sx = PADDING + (index % perRow) * (SWATCH + SWATCH_GAP);
      const sy = y + Math.floor(index / perRow) * (SWATCH + 34);
      this.swatches.roundRect(sx, sy, SWATCH, SWATCH, 8).fill({ color: color.hex }).stroke({ color: 0xffffff, width: 1, alpha: 0.12 });
      const label = this.hexLabel(index);
      label.text = `${color.role || color.name}\n${color.hex}`;
      label.position.set(sx, sy + SWATCH + 4);
      label.visible = true;
    });
    for (let i = card.palette.length; i < this.hexLabels.length; i++) this.hexLabels[i].visible = false;
    if (card.palette.length) y += Math.ceil(card.palette.length / perRow) * (SWATCH + 34) + 6;

    const ruleKeys = Object.keys(RULE_LABELS) as (keyof ThemeRules)[];
    this.rules.text = ruleKeys
      .filter((key) => card.rules[key].trim())
      .map((key) => `${RULE_LABELS[key]}：${card.rules[key].trim()}`)
      .join('\n');
    this.rules.style.wordWrapWidth = inner;
    this.rules.position.set(PADDING, y);
    this.clip.clear();
    this.clip.rect(PADDING, y, inner, Math.max(0, height - y - PADDING)).fill({ color: 0xffffff });
  }

  setTextResolution(resolution: number): void {
    for (const text of [this.title, this.badge, this.body, this.rules, ...this.hexLabels]) {
      if (Math.abs(text.resolution - resolution) > 0.01) text.resolution = resolution;
    }
  }

  destroy(): void {
    this.container.destroy({ children: true });
  }

  private hexLabel(index: number): Text {
    let label = this.hexLabels[index];
    if (!label) {
      label = new Text({ text: '', style: { fontFamily: FONT, fontSize: 10, fill: DIM, lineHeight: 13 } });
      this.container.addChild(label);
      this.hexLabels[index] = label;
    }
    return label;
  }
}
