import { useState } from 'react';
import type { ReactNode } from 'react';
import { clientId as pageClientId } from './api';

export async function request<T>(url: string, init: RequestInit = {}): Promise<T> {
  const response = await fetch(url, { ...init, headers: { ...(init.body ? { 'Content-Type': 'application/json' } : {}), ...init.headers } });
  const body = await response.text();
  let data: unknown;
  try { data = body ? JSON.parse(body) : undefined; } catch { data = body; }
  if (!response.ok) {
    const error = data as { error?: string | { message?: string }; message?: string; details?: { path?: string; message: string }[] } | undefined;
    const message = typeof error?.error === 'string' ? error.error : error?.error?.message ?? error?.message;
    if (error?.details?.length) {
      const names: Record<string, string> = { hooks: 'Total hooks', epi: 'EPI', ppi: 'PPI', name: 'Name', entries: 'Palette colors', colorIndex: 'Color', defaultProfileId: 'Default machine', sourcePngBase64: 'Source image', master: 'Master file' };
      const details = error.details.slice(0, 3).map(issue => { const key = issue.path?.split('.').pop() ?? ''; return `${names[key] ?? 'Value'}: ${issue.message}`; });
      throw new Error(`Please check these values. ${details.join(' ')}`);
    }
    throw new Error(message || (response.status === 423 ? 'This design is open in another window. Close it there, then try again.' : `Request failed (${response.status}). Please try again.`));
  }
  return data as T;
}

export function clientId(): string {
  return pageClientId;
}

export function Icon({ name, size = 20 }: { name: 'plus' | 'search' | 'arrow' | 'upload' | 'settings' | 'copy' | 'archive' | 'close' | 'check' | 'leaf'; size?: number }) {
  const paths: Record<typeof name, ReactNode> = {
    plus: <path d="M12 5v14M5 12h14" />,
    search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 4 4" /></>,
    arrow: <path d="m10 5-7 7 7 7M3 12h18" />,
    upload: <><path d="M12 16V3m-5 5 5-5 5 5M4 15v5h16v-5" /></>,
    settings: <><path d="M4 7h16M4 17h16" /><circle cx="9" cy="7" r="3" /><circle cx="15" cy="17" r="3" /></>,
    copy: <><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M15 8V4H4v11h4" /></>,
    archive: <><path d="M5 8v12h14V8M9 12h6" /><rect x="3" y="3" width="18" height="5" rx="1" /></>,
    close: <path d="m6 6 12 12M18 6 6 18" />,
    check: <path d="m5 12 4 4L19 6" />,
    leaf: <><path d="M19 3C8 2 2 7 5 15s14 4 14-12Z" /><path d="M4 21 16 8M8 15l-1-5m5 1h5" /></>,
  };
  return <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{paths[name]}</svg>;
}

export function ScreenHeader({ eyebrow, title, description, back, children }: { eyebrow: string; title: string; description?: string; back?: () => void; children?: ReactNode }) {
  return <header className="jdm-screen-header"><div>{back && <button className="jdm-back" onClick={back}><Icon name="arrow" size={17} /> Back to library</button>}<div className="jdm-eyebrow">{eyebrow}</div><h1>{title}</h1>{description && <p>{description}</p>}</div>{children && <div className="jdm-header-actions">{children}</div>}</header>;
}

export function Notice({ children, tone = 'info', onClose }: { children: ReactNode; tone?: 'info' | 'error' | 'success'; onClose?: () => void }) {
  return <div className={`jdm-notice jdm-notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}><div>{children}</div>{onClose && <button className="jdm-icon-button" aria-label="Dismiss message" onClick={onClose}><Icon name="close" size={16} /></button>}</div>;
}

export function Spinner({ label }: { label?: string }) { return <span className="jdm-loading"><span className="jdm-spinner" aria-hidden="true" />{label}</span>; }

export function Thumbnail({ id, name }: { id: string; name: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="jdm-thumbnail">{failed ? <div className="jdm-thumbnail-fallback"><Icon name="leaf" size={52} /><span>Vector master</span></div> : <img src={`/api/designs/${encodeURIComponent(id)}/thumbnail`} alt={`${name} preview`} loading="lazy" onError={() => setFailed(true)} />}</div>;
}

export const rgbToHex = (rgb: number[]): string => `#${rgb.map(value => Math.round(value).toString(16).padStart(2, '0')).join('')}`;
export const hexToRgb = (hex: string): [number, number, number] => [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
