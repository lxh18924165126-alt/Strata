import { useEffect, useState } from 'react';
import { ApiError } from '../lib/client';
import { tr } from '../lib/i18n';
import { pushToast } from '../lib/store';
import { Btn, Dialog, ErrorNotice } from './ui';

type ModelControl = { enabled: boolean; loaded: boolean; supported: boolean };

async function modelControl(options: RequestInit) {
    // This is the API server that served the page. HOST_BASE may point at the desktop Host.
    const response = await fetch('/api/model', { ...options, cache: 'no-store', redirect: 'error' });
    const data = await response.json();
    if (!response.ok) throw new ApiError(data.error?.message ?? `HTTP ${response.status}`, response.status);
    if (typeof data?.enabled !== 'boolean' || typeof data.loaded !== 'boolean' || typeof data.supported !== 'boolean') {
        throw new Error('Local model status unavailable');
    }
    return data as ModelControl;
}

function savedApiKey() {
    try {
        const key: unknown = sessionStorage.getItem('strata.keys.admin') || JSON.parse(localStorage.getItem('strata.apikey') ?? 'null');
        return typeof key === 'string' ? key : '';
    } catch {
        return ''; // The operator can enter the key if browser storage is unavailable.
    }
}

export function LocalModelSwitch() {
    const [status, setStatus] = useState<ModelControl | null>(null);
    const [pending, setPending] = useState(false);
    const [requested, setRequested] = useState<boolean | null>(null);
    const [key, setKey] = useState('');
    const [acceptedKey, setAcceptedKey] = useState('');
    const [error, setError] = useState('');

    useEffect(() => {
        if (pending) return;
        const controller = new AbortController();
        let timer: ReturnType<typeof setTimeout>;
        async function refresh() {
            try {
                const state = await modelControl({ signal: controller.signal });
                if (!controller.signal.aborted) setStatus(state);
            } catch {
                if (!controller.signal.aborted) setStatus(null);
            }
            if (!controller.signal.aborted) timer = setTimeout(refresh, 3000);
        }
        void refresh();
        return () => { controller.abort(); clearTimeout(timer); };
    }, [pending]);

    async function change(enabled: boolean, credential?: string) {
        setPending(true);
        setError('');
        try {
            const authorization = credential ?? (acceptedKey || savedApiKey());
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (authorization) headers.Authorization = `Bearer ${authorization}`;
            setStatus(await modelControl({ method: 'POST', headers, body: JSON.stringify({ enabled }) }));
            setAcceptedKey(authorization);
            setRequested(null);
            setKey('');
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            if (err instanceof ApiError && (err.status === 401 || err.status === 403)) {
                setRequested(enabled);
                if (credential !== undefined) setError(message);
            } else if (credential !== undefined) {
                setError(message);
            } else {
                pushToast('error', 'Could not switch local model', message);
            }
        } finally {
            setPending(false);
        }
    }

    const action = status?.enabled ? 'Turn off local model' : 'Turn on local model';
    const label = pending ? 'Switching local model…' : !status ? 'Local model status unavailable' : !status.supported ? 'Local model switch unavailable' : action;
    function close() {
        if (pending) return;
        setRequested(null);
        setKey('');
    }

    return <>
        <Btn size="sm" disabled={pending || !status?.supported}
            onClick={() => { if (status) void change(!status.enabled); }}>{tr(label)}</Btn>
        <Dialog open={requested !== null} title={requested ? 'Turn on local model' : 'Turn off local model'} onClose={close} compact>
            <form className="stack" onSubmit={event => {
                event.preventDefault();
                if (!pending && requested !== null && key.trim()) void change(requested, key.trim());
            }}>
                <p className="small muted">{tr('Enter the API key for this server. If API key management is enabled, use the administrator key.')}</p>
                <label className="input-field"><span>{tr('API key')}</span>
                    <input type="password" autoComplete="off" value={key} onChange={event => setKey(event.target.value)} disabled={pending}/>
                </label>
                {error ? <ErrorNotice message={error}/> : null}
                <div className="row">
                    <Btn onClick={close} disabled={pending}>{tr('Cancel')}</Btn>
                    <Btn type="submit" variant="primary" disabled={pending || !key.trim()}>{tr(pending ? 'Switching local model…' : 'Continue')}</Btn>
                </div>
            </form>
        </Dialog>
    </>;
}
