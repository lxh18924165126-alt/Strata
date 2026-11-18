import { useEffect, useState } from 'react';
import { api } from '../lib/client';
import { tr } from '../lib/i18n';
import { go, openSetup, updateBridge, useStore } from '../lib/store';
import type { BridgeModel } from '../lib/types';
import { Btn, Dialog, ErrorNotice, Select } from './ui';

export function BridgeDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
    const bridge = useStore(s => s.bridge);
    const [baseUrl, setBaseUrl] = useState(''), [apiKey, setApiKey] = useState('');
    const [models, setModels] = useState<BridgeModel[]>([]), [modelId, setModelId] = useState('');
    const [testedUrl, setTestedUrl] = useState(''), [pending, setPending] = useState(false), [error, setError] = useState('');
    const canReuseKey = bridge?.apiKeySet && bridge.baseUrl === baseUrl.trim();
    useEffect(() => {
        if (!open) return;
        setBaseUrl(bridge?.baseUrl ?? ''); setApiKey(''); setModels([]); setModelId(''); setTestedUrl(''); setError('');
    }, [open]);
    async function test() {
        setPending(true); setError(''); setModels([]); setTestedUrl('');
        try {
            const result = await api.post<{ baseUrl: string; models: BridgeModel[] }>('/api/bridge/test', { baseUrl: baseUrl.trim(), ...(apiKey ? { apiKey } : {}) });
            setBaseUrl(result.baseUrl); setTestedUrl(result.baseUrl); setModels(result.models);
            setModelId(result.models.find(m => m.id === bridge?.model?.id)?.id ?? (result.models.length === 1 ? result.models[0].id : ''));
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setPending(false); }
    }
    async function save(enabled: boolean) {
        setPending(true); setError('');
        try {
            await updateBridge(enabled ? { enabled: true, baseUrl: testedUrl, modelId, ...(apiKey ? { apiKey } : {}) } : { enabled: false });
            if (enabled) { openSetup(false); go('chat'); }
            onClose();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { setPending(false); }
    }
    return <Dialog open={open} title={tr("Bridge to another Strata server")} onClose={() => { if (!pending) onClose(); }} actions={<>
        {bridge?.enabled ? <Btn disabled={pending} onClick={() => void save(false)}>{tr("Stop bridge")}</Btn> : null}
        <Btn onClick={onClose} disabled={pending}>{tr("Cancel")}</Btn>
        <Btn variant="primary" disabled={pending || !testedUrl || !modelId} onClick={() => void save(true)}>{tr(pending ? 'Working…' : 'Enable bridge')}</Btn>
    </>}><div className="form-stack">
        <p>{tr("Use a model served by another Strata installation. The bridge applies to all chats while enabled.")}</p>
        <p className="small muted">{tr("For an SSH tunnel, start the tunnel separately and enter its local address here, for example http://127.0.0.1:18080.")}</p>
        <label className="input-field"><span>{tr("Server address")}</span><input className="st-input" value={baseUrl} onChange={e => { setBaseUrl(e.target.value); setTestedUrl(''); setModels([]); }} placeholder="http://127.0.0.1:18080" spellCheck={false}/></label>
        <label className="input-field"><span>{tr("API key")}</span><input className="st-input" type="password" value={apiKey} onChange={e => { setApiKey(e.target.value); setTestedUrl(''); setModels([]); }} autoComplete="off" placeholder={tr(canReuseKey ? 'Leave blank to keep the saved key' : 'Enter API key')}/></label>
        <Btn disabled={pending || !baseUrl.trim() || (!apiKey.trim() && !canReuseKey)} onClick={() => void test()}>{tr(pending ? 'Testing…' : 'Test connection')}</Btn>
        {testedUrl && !models.length ? <p role="status">{tr("The server returned no text models.")}</p> : null}
        {models.length ? <label className="input-field"><span>{tr("Model")}</span><Select ariaLabel={tr("Bridge model")} value={modelId} options={[...(!modelId ? [{ value: '', label: tr('Choose a model'), disabled: true }] : []), ...models.map(m => ({ value: m.id, label: m.name || m.id }))]} onChange={setModelId}/></label> : null}
        {bridge?.enabled ? <p className="small muted" role="status">{tr("Current bridge")}: {bridge.model?.name ?? bridge.model?.id} · {tr(bridge.status === 'connected' ? 'Connected' : bridge.status === 'error' ? 'Error' : 'Idle')}{bridge.error ? ` · ${bridge.error}` : ''}</p> : null}
        {error ? <ErrorNotice message={error}/> : null}
    </div></Dialog>;
}
