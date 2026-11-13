import { useEffect, useRef } from 'react';
import { CanvasEngine } from '../canvas/CanvasEngine';

interface CanvasViewProps {
  onEngine(engine: CanvasEngine | null): void;
}

/** 只负责挂载和销毁画布引擎；画布内部的每一帧都不经过 React。 */
export function CanvasView({ onEngine }: CanvasViewProps) {
  const hostRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let engine: CanvasEngine | null = null;
    let cancelled = false;
    void CanvasEngine.create(host).then((created) => {
      if (cancelled) {
        created.destroy();
        return;
      }
      engine = created;
      onEngine(created);
    });
    return () => {
      cancelled = true;
      engine?.destroy();
      onEngine(null);
    };
  }, [onEngine]);

  return <div ref={hostRef} className="canvas-host" />;
}
