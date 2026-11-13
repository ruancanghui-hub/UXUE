import { join } from 'node:path';
import { utilityProcess, type UtilityProcess } from 'electron';
import type { BenchProgress } from '../shared/bench';
import type { WorkerMessage, WorkerRequest } from '../shared/workerProtocol';

type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
type RequestBody = DistributiveOmit<WorkerRequest, 'requestId'>;

interface Pending {
  resolve(data: unknown): void;
  reject(error: Error): void;
  onProgress?: (progress: BenchProgress) => void;
}

/** 图片工作进程：解码、缩略图、导出都在这里做，不占用主进程和渲染进程。 */
export class ImageWorkerClient {
  private child: UtilityProcess | null = null;
  private nextRequestId = 1;
  private readonly pending = new Map<number, Pending>();

  request<T>(body: RequestBody, onProgress?: (progress: BenchProgress) => void): Promise<T> {
    const child = this.ensureChild();
    const requestId = this.nextRequestId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(requestId, { resolve: resolve as (data: unknown) => void, reject, onProgress });
      child.postMessage({ ...body, requestId } satisfies WorkerRequest);
    });
  }

  dispose(): void {
    this.child?.kill();
    this.child = null;
  }

  private ensureChild(): UtilityProcess {
    if (this.child) return this.child;
    const child = utilityProcess.fork(join(__dirname, 'imageWorker.js'), [], {
      serviceName: 'anye-image-worker',
      stdio: 'inherit',
    });
    child.on('message', (message: WorkerMessage) => this.onMessage(message));
    child.on('exit', (code) => {
      this.child = null;
      for (const pending of this.pending.values()) {
        pending.reject(new Error(`图片工作进程意外退出（code ${code}）`));
      }
      this.pending.clear();
    });
    this.child = child;
    return child;
  }

  private onMessage(message: WorkerMessage): void {
    const pending = this.pending.get(message.requestId);
    if (!pending) return;
    if (message.type === 'progress') {
      pending.onProgress?.(message.progress);
      return;
    }
    this.pending.delete(message.requestId);
    if (message.ok) pending.resolve(message.data);
    else pending.reject(new Error(message.error));
  }
}
