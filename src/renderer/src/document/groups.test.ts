import { describe, expect, it } from 'vitest';
import type { ImageCard } from '../../../shared/project';
import { addCards, displayVersion, groupCards, setCurrentVersion, setRefLockedVersion, ungroupCards, type DocState } from './operations';
import { defaultRegions } from '../../../shared/project';

const img = (id: string, x: number): ImageCard => ({
  kind: 'image',
  id,
  name: id,
  x,
  y: 0,
  width: 100,
  height: 100,
  currentVersionId: `${id}-v1`,
  groupId: null,
  versions: [
    { id: `${id}-v1`, file: `assets/${id}.png`, width: 100, height: 100, createdAt: '2026-01-01T00:00:00.000Z', origin: 'import' },
    { id: `${id}-v2`, file: `assets/${id}-2.png`, width: 200, height: 100, createdAt: '2026-01-02T00:00:00.000Z', origin: 'import' },
  ],
});

function empty(): DocState {
  return { cards: [], regions: defaultRegions(), activeThemeCardId: null };
}

describe('分组框', () => {
  it('编组后子卡带 groupId；解组后脱离', () => {
    let state = addCards(empty(), [img('a', 0), img('b', 120)]);
    const grouped = groupCards(state, new Set(['a', 'b']), () => 'g1');
    expect(grouped).not.toBeNull();
    state = grouped!.state;
    expect(state.cards.find((c) => c.id === 'a')).toMatchObject({ groupId: 'g1' });
    expect(state.cards.some((c) => c.kind === 'group' && c.id === 'g1')).toBe(true);
    state = ungroupCards(state, new Set(['g1']));
    expect(state.cards.find((c) => c.id === 'a')).toMatchObject({ groupId: null });
    expect(state.cards.some((c) => c.kind === 'group')).toBe(false);
  });
});

describe('锁定版本', () => {
  it('锁定后不跟随当前版本；解锁后跟随', () => {
    let state = addCards(empty(), [img('icon', 0)]);
    state = addCards(state, [
      {
        kind: 'ref',
        id: 'r1',
        x: 0,
        y: 200,
        width: 100,
        height: 100,
        imageCardId: 'icon',
        pageId: null,
        lockedVersionId: null,
      },
    ]);
    const byId = () => new Map(state.cards.map((c) => [c.id, c]));
    expect(displayVersion(state.cards.find((c) => c.id === 'r1')!, byId())?.id).toBe('icon-v1');
    state = setRefLockedVersion(state, 'r1', 'icon-v1');
    state = setCurrentVersion(state, 'icon', 'icon-v2');
    expect(displayVersion(state.cards.find((c) => c.id === 'r1')!, byId())?.id).toBe('icon-v1');
    state = setRefLockedVersion(state, 'r1', null);
    expect(displayVersion(state.cards.find((c) => c.id === 'r1')!, byId())?.id).toBe('icon-v2');
  });
});
