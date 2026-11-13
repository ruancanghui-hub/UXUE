import { useEffect, useState } from 'react';
import type { DocumentStore } from '../document/DocumentStore';
import type { DocState } from '../document/operations';
import type { Selection } from '../document/Selection';

/** 只在改动提交（不含拖动中的中间状态）时更新，拖动时面板不会跟着每帧重渲染 */
export function useCommittedDoc(doc: DocumentStore): DocState {
  const [state, setState] = useState(() => doc.get());
  useEffect(() => {
    setState(doc.get());
    return doc.subscribe((next, change) => {
      if (change !== 'transient') setState(next);
    });
  }, [doc]);
  return state;
}

export function useSelectionIds(selection: Selection): ReadonlySet<string> {
  const [ids, setIds] = useState(() => selection.get());
  useEffect(() => {
    setIds(selection.get());
    return selection.subscribe(setIds);
  }, [selection]);
  return ids;
}
