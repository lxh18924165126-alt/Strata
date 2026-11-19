import { hasReading } from './monitor-hardware';
import { nativeMonitorData } from './native-monitor';
import type { GpuInfo, Hardware } from './types';

interface BridgeMetrics {
  time: number;
  engine: { model: string; max_context?: number };
  live: { state: string };
  hardware: {
    gpus?: { index: number; name?: string; mem_total?: number }[];
    gpu_mem_total?: number;
    gpu_util?: number;
  };
  hardware_static: { cpu_name?: string; cores?: number; threads?: number; gpu_name?: string; gpu_vram_total_mib?: number };
  totals: { since: number };
  conversation_cache?: Record<string, unknown>;
}

export type MonitorInventory = Pick<Hardware, 'gpus' | 'processors'> & {
  cpu?: Pick<Hardware['cpu'], 'model' | 'cores' | 'threads' | 'topologyKnown'>;
};

export function bridgeMonitorData(metrics: BridgeMetrics) {
  const { hardware, hardware_static: specs, engine, live, totals, conversation_cache: cache } = metrics;
  const text = (value: unknown) => typeof value === 'string' && value.trim() ? value : undefined;
  const reading = (value: unknown) => hasReading(value) ? value : undefined;
  const name = text(specs.gpu_name);
  const singleGpu = name || hasReading(hardware.gpu_util) || hasReading(hardware.gpu_mem_total) || hasReading(specs.gpu_vram_total_mib);
  const devices = hardware.gpus?.length ? hardware.gpus : singleGpu ? [{
    index: 0, name, mem_total: reading(hardware.gpu_mem_total) ?? (reading(specs.gpu_vram_total_mib) ?? 0) * 1024 ** 2,
  }] : [];
  const gpus: GpuInfo[] = devices.map(gpu => ({
    index: gpu.index, name: text(gpu.name) ?? `GPU ${gpu.index}`, vramGb: (reading(gpu.mem_total) ?? 0) / 1024 ** 3,
    unified: false, vendor: 'unknown', backend: 'cpu',
  }));
  const cpuName = text(specs.cpu_name), cores = reading(specs.cores), threads = reading(specs.threads);
  const inventory: MonitorInventory = { gpus, cpu: cpuName || cores || threads ? {
    model: cpuName ?? 'CPU', cores: cores ?? NaN, threads: threads ?? NaN, topologyKnown: cores !== undefined,
  } : undefined };
  const instance = {
    id: engine.model, model: engine.model, label: engine.model, phase: live.state === 'unloaded' ? 'idle' : live.state,
    metrics, gpus: gpus.map(gpu => gpu.index), error: null, loadedAt: new Date(totals.since * 1000).toISOString(),
  };
  const data = nativeMonitorData({ instances: [instance] }, inventory);
  if (live.state === 'unloaded') data.phaseLabel = 'No model loaded';
  if (cache) {
    data.conversationCache = {
      source: 'reported', enabled: cache.enabled === true, slots: reading(cache.slots), parked: reading(cache.parked),
      memoryGb: hasReading(cache.bytes) ? cache.bytes / 1024 ** 3 : undefined,
      budgetGb: hasReading(cache.budget_mib) ? cache.budget_mib / 1024 : undefined,
      evictions: reading(cache.evictions), parks: reading(cache.parks), restores: reading(cache.restores),
      lastEvent: text(cache.last_event), lastAt: reading(cache.last_at), lastTokens: reading(cache.last_tokens),
      requests: reading(cache.requests), requestsReused: reading(cache.requests_reused),
      lastPrompt: reading(cache.last_prompt), lastReused: reading(cache.last_reused),
    };
  }
  return { data, inventory, modelLabel: engine.model };
}
