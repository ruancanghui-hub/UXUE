import { useEffect, useState } from 'react';
import { formatCost } from '../../../shared/generation';
import type { TrackedJob } from '../project/GenerationTracker';

interface QueuePanelProps {
  jobs: TrackedJob[];
  onCancel(jobId: string): void;
  onDismiss(jobId: string): void;
  onSelectPrompt(promptCardId: string): void;
}

const STATUS_LABEL: Record<TrackedJob['update']['status'], string> = {
  queued: '排队中',
  running: '生成中',
  succeeded: '完成',
  failed: '失败',
  canceled: '已取消',
};

/** 生成队列：有任务时出现在画布左下角，可以折叠 */
export function QueuePanel({ jobs, onCancel, onDismiss, onSelectPrompt }: QueuePanelProps) {
  const [open, setOpen] = useState(true);
  const [now, setNow] = useState(Date.now());
  const active = jobs.filter((job) => job.update.status === 'queued' || job.update.status === 'running');
  useEffect(() => {
    if (active.length === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active.length]);

  if (jobs.length === 0) return null;
  const spentOf = (currency: 'USD' | 'CNY'): number =>
    jobs.filter((job) => job.update.currency === currency).reduce((sum, job) => sum + (job.update.costUsd ?? 0), 0);
  const spent = [spentOf('USD') > 0 ? formatCost(spentOf('USD'), 'USD') : '', spentOf('CNY') > 0 ? formatCost(spentOf('CNY'), 'CNY') : '']
    .filter(Boolean)
    .join(' + ') || '0';

  return (
    <div className={`queue-panel ${open ? 'open' : ''}`}>
      <button className="queue-header" onClick={() => setOpen((value) => !value)}>
        <span>
          生成队列 {active.length > 0 ? `· 进行中 ${active.length}` : '· 空闲'}
        </span>
        <span className="dim">本次 {spent} {open ? '▾' : '▸'}</span>
      </button>
      {open && (
        <div className="queue-list">
          {jobs.map((job) => {
            const { status } = job.update;
            const running = status === 'queued' || status === 'running';
            const started = job.update.startedAt ?? job.submittedAt;
            const elapsed = Math.max(0, Math.round(((job.update.finishedAt ?? now) - started) / 1000));
            const cost = job.update.costUsd ?? job.update.estimateUsd;
            return (
              <div key={job.update.jobId} className={`queue-row ${status}`}>
                <button className="queue-name link" onClick={() => onSelectPrompt(job.promptCardId)} title={job.prompt}>
                  {job.promptName} ×{job.settings.count}
                </button>
                <span className="queue-status">
                  {STATUS_LABEL[status]}
                  {status !== 'canceled' && ` ${elapsed}s`}
                </span>
                <span className="queue-cost" title={job.update.costUsd === undefined ? '估算' : '实际'}>
                  {job.update.provider === 'mock' ? '模拟' : `${job.update.costUsd === undefined ? '≈' : ''}${formatCost(cost, job.update.currency)}`}
                </span>
                {running ? (
                  <button className="icon" onClick={() => onCancel(job.update.jobId)} title="取消">
                    ✕
                  </button>
                ) : (
                  <button className="icon" onClick={() => onDismiss(job.update.jobId)} title="移出列表">
                    ✕
                  </button>
                )}
                {status === 'failed' && <div className="queue-error">{job.update.error}</div>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
