type Title = { id: string; title: string };
type Job = { started: boolean };
interface Transport {
  generate: (id: string, content: string) => Promise<{ title: string | null; generation: string }>;
  save: (id: string, title: string, generation?: string) => Promise<Title>;
  changed: (value: Title) => void;
}

/** Bounded, process-local coordination; Corax alone persists titles. */
export class SessionTitles {
  private jobs = new Map<string, Job>();
  private writes = new Map<string, Promise<void>>();
  private epoch = 0;
  constructor(private readonly transport: Transport) {}

  prepare(id: string) {
    this.jobs.set(id, { started: false });
    while (this.jobs.size > 32) this.jobs.delete(this.jobs.keys().next().value!);
  }

  clear() {
    this.epoch++;
    this.jobs.clear();
    this.writes.clear();
  }

  async accepted(id: string, content: string) {
    const job = this.jobs.get(id);
    if (!job || job.started) return;
    job.started = true;
    try {
      const result = await this.transport.generate(id, Array.from(content).slice(0, 2000).join(''));
      if (result.title && result.generation && this.jobs.get(id) === job)
        await this.write(id, result.title, result.generation, job);
    } catch {
      // Keep Corax's derived title on failure; never retry an ambiguous write.
    } finally {
      if (this.jobs.get(id) === job) this.jobs.delete(id);
    }
  }

  rename(id: string, title: string) {
    // Cancel pending generation immediately, even before the manual save finishes.
    this.jobs.delete(id);
    return this.write(id, title);
  }

  private async write(id: string, title: string, generation?: string, job?: Job) {
    const epoch = this.epoch;
    const current = () => {
      if (epoch !== this.epoch) throw new Error('后端连接已经变化，请刷新会话名称后重试。');
    };
    const operation = (this.writes.get(id) ?? Promise.resolve())
      .catch(() => {})
      .then(async () => {
        current();
        if (job && this.jobs.get(id) !== job) return;
        const value = await this.transport.save(id, title, generation);
        current();
        if (value.id !== id || typeof value.title !== 'string' || !value.title.trim())
          throw new Error('重命名响应无效，请刷新会话列表核对结果。');
        if (job && this.jobs.get(id) !== job) return;
        this.transport.changed(value);
      });
    this.writes.set(id, operation);
    try {
      await operation;
    } finally {
      if (this.writes.get(id) === operation) this.writes.delete(id);
    }
  }
}
