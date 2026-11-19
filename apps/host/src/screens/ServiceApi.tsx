import { useEffect, useRef, useState, type FormEvent } from 'react';
import { CopyBtn } from '../components/CopyBtn';
import { Screen } from '../components/layout';
import { ManagedApiViews } from '../components/ManagedApiViews';
import { Btn, Seg } from '../components/ui';
import { api, LOCAL_SERVICE, LOCAL_CALL_KEY, localCallKey } from '../lib/client';
import { useNative } from '../lib/native';
import { navigate } from '../lib/router';

type Service = { target: string; base: string; managed: boolean };
type Model = { id: string; architecture?: { output_modalities?: string[] }; alias_of?: string };

export function ServiceApiScreen() {
  const native = useNative();
  const ready = native?.instances.filter(item => item.status === 'ready') ?? [];
  const instance = ready.find(item => item.id === native?.defaultId) ?? ready[0];
  return <ServiceApi key={LOCAL_SERVICE || JSON.stringify([instance?.id, instance?.loadedAt])}/>;
}

function ServiceApi() {
  const [service, setService] = useState<Service | null>();
  const [failure, setFailure] = useState('');
  const [attempt, setAttempt] = useState(0);
  const [view, setView] = useState<'guide' | 'management'>(LOCAL_SERVICE ? 'management' : 'guide');
  useEffect(() => {
    const controller = new AbortController();
    const discovery = LOCAL_SERVICE
      ? fetch('/health', { cache: 'no-store', signal: controller.signal }).then(async response => {
          const info = await response.json();
          if (!response.ok || info?.service !== 'strata') throw new Error('Local service unavailable');
          return { target: 'local', base: LOCAL_SERVICE, managed: info.key_management === true };
        })
      : api.get<Service | { target: null }>('/api/upstream', controller.signal);
    discovery.then(result => {
      if (!controller.signal.aborted) setService(result.target ? result : null);
    }).catch(() => {
      if (!controller.signal.aborted) setFailure('暂时无法读取 Strata 服务状态。');
    });
    return () => controller.abort();
  }, [attempt]);
  const endpoint = LOCAL_SERVICE || (service ? `${window.location.origin}/api/upstream/${service.target}` : '');
  const managed = !!service?.managed && view === 'management';
  const actions = service ? <Seg value={view} onChange={setView} ariaLabel="API 服务页面"
    options={[{ value: 'guide', label: 'API 指南' }, { value: 'management', label: '密钥与用量' }]}/> : undefined;
  return <Screen title="API 管理与用量" back={{ label: 'Serving', onClick: () => navigate('serving') }}
    actions={actions} bare={managed}>
    {managed ? <ManagedApiViews key={service.target} endpoint={endpoint} target={service.target} title="API Key 管理与用量"/>
      : failure ? <div className="stack"><p className="inline-error" role="alert">{failure}</p>
        <Btn onClick={() => { setFailure(''); setAttempt(attempt + 1); }}>重试</Btn></div>
        : service === null ? <p className="muted">请先加载本地模型或连接 Strata 服务器。</p>
          : service ? view === 'management'
            ? <p className="muted">此服务尚未启用 API Key 管理。启用后可在这里管理密钥、限额及持久用量。</p>
            : <ApiGuide key={service.target} service={service} endpoint={endpoint}/>
            : <p role="status">正在读取 Strata 服务状态…</p>}
  </Screen>;
}

function ApiGuide({ service, endpoint }: { service: Service; endpoint: string }) {
  const [models, setModels] = useState<Model[]>([]);
  const [message, setMessage] = useState('');
  const [pending, setPending] = useState(false);
  const credentialSlot = LOCAL_SERVICE ? LOCAL_CALL_KEY : `strata.upstream.call.${service.target}`;
  const active = useRef<AbortController>(null);
  useEffect(() => () => active.current?.abort(), []);
  async function refresh(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const key = String(new FormData(event.currentTarget).get('key')).trim();
    if (key || LOCAL_SERVICE) sessionStorage.setItem(credentialSlot, key);
    else sessionStorage.removeItem(credentialSlot);
    active.current?.abort();
    const request = new AbortController();
    active.current = request;
    setPending(true);
    setMessage('');
    setModels([]);
    try {
      const response = await fetch(`${endpoint}/v1/models`, {
        cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(12000)]),
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      });
      if (response.status === 401 || response.status === 403) throw new Error('请输入有效的调用 Key。');
      if (!response.ok) throw new Error(`读取模型列表失败（HTTP ${response.status}）。`);
      const { data } = await response.json();
      if (!Array.isArray(data) || !data.every(item => typeof item?.id === 'string')) throw new Error('模型列表格式无效。');
      setModels(data);
      if (!data.length) setMessage('当前没有可用模型。');
    } catch (error) {
      if (!request.signal.aborted) setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      if (!request.signal.aborted) setPending(false);
    }
  }
  const base = service.base;
  const id = models.find(model => !Array.isArray(model.architecture?.output_modalities)
    || model.architecture.output_modalities.includes('text'))?.id ?? 'YOUR_MODEL_NAME';
  const ps = (value: string) => `'${value.replaceAll("'", "''")}'`;
  const body = `$body = @{ model = ${ps(id)}; max_tokens = 256; messages = @(@{ role = 'user'; content = 'Hello!' }) } | ConvertTo-Json -Depth 4`;
  const examples = [
    ['Python · OpenAI SDK', `# pip install openai
from openai import OpenAI

client = OpenAI(base_url=${JSON.stringify(base + '/v1')}, api_key="YOUR_API_KEY")
response = client.chat.completions.create(
    model=${JSON.stringify(id)},
    messages=[{"role": "user", "content": "Hello!"}],
    max_tokens=256,
)
print(response.choices[0].message.content)`],
    ['PowerShell · OpenAI Chat Completions', `$headers = @{ Authorization = 'Bearer YOUR_API_KEY' }
${body}
Invoke-RestMethod -Method Post -Uri ${ps(base + '/v1/chat/completions')} -ContentType 'application/json' -Headers $headers -Body $body`],
    ['PowerShell · Anthropic Messages', `$headers = @{ 'x-api-key' = 'YOUR_API_KEY'; 'anthropic-version' = '2023-06-01' }
${body}
Invoke-RestMethod -Method Post -Uri ${ps(base + '/v1/messages')} -ContentType 'application/json' -Headers $headers -Body $body`],
  ];
  return <div className="stack stack--lg">
    <section className="st-card stack"><h2 className="h4">服务连接地址</h2>
      <dl className="summary-list">{[['OpenAI Base URL', `${base}/v1`], ['Anthropic Base URL', base], ['模型列表', `${base}/v1/models`]].map(([label, address]) =>
        <div key={label}><dt>{label}</dt><dd className="row"><code style={{ overflowWrap: 'anywhere' }}>{address}</code><CopyBtn text={address} label={label} title={`复制 ${label}`}/></dd></div>)}</dl>
    </section>
    <section className="st-card stack"><h2 className="h4">按调用 Key 查询模型</h2>
      <form className="stack" onSubmit={refresh}><label className="input-field"><span>调用 Key</span>
        <input className="st-input" name="key" type="password" autoComplete="off" placeholder="未启用认证时留空"
          defaultValue={LOCAL_SERVICE ? localCallKey() : sessionStorage.getItem(credentialSlot) ?? ''}/></label>
        <div><Btn type="submit" disabled={pending}>{pending ? '正在查询…' : '查询模型'}</Btn></div>
      </form>
      <p className="small muted">调用 Key 只保存在当前标签页。清空后再次查询即可移除。</p>
      {message ? <p role="status">{message}</p> : null}
      {models.map(model => <div key={model.id} className="row"><code>{model.id}</code>
        {typeof model.alias_of === 'string' ? <span className="muted">别名 · {model.alias_of}</span> : null}
        <CopyBtn text={model.id} label={model.id} title={`复制 ${model.id}`}/></div>)}
    </section>
    <section className="st-card stack"><h2 className="h4">调用示例</h2>
      <p className="small muted">将 YOUR_API_KEY 替换为调用 Key。查询模型后，示例会使用列表中的首个对话模型。</p>
      {examples.map(([label, code]) => <div className="st-code" key={label}><div className="st-code__head"><span>{label}</span>
        <CopyBtn text={code} label={label} title={`复制 ${label}`}/></div><pre>{code}</pre></div>)}
    </section>
  </div>;
}
