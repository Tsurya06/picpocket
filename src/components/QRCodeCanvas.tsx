import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { Spinner } from './ui/Spinner';

export interface QRCodeCanvasProps {
  readonly url: string;
  readonly expiresAt: number;
}

/**
 * Renders the `tg://login?token=…` URL as a QR code.
 * Telegram refreshes the token periodically; mtcute calls the handler again
 * and this component simply re-renders with the new URL.
 */
export function QRCodeCanvas({ url, expiresAt }: QRCodeCanvasProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [secondsLeft, setSecondsLeft] = useState(() =>
    Math.max(0, Math.round((expiresAt - Date.now()) / 1000)),
  );

  useEffect(() => {
    let cancelled = false;
    setDataUrl(null);
    void QRCode.toDataURL(url, {
      errorCorrectionLevel: 'M',
      margin: 1,
      width: 360,
      color: { dark: '#0f1115', light: '#ffffff' },
    })
      .then((result) => {
        if (!cancelled) setDataUrl(result);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [url]);

  useEffect(() => {
    setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    const timer = window.setInterval(() => {
      setSecondsLeft(Math.max(0, Math.round((expiresAt - Date.now()) / 1000)));
    }, 1000);
    return () => window.clearInterval(timer);
  }, [expiresAt]);

  return (
    <div className="flex flex-col items-center gap-3">
      <div className="relative overflow-hidden rounded-2xl bg-white p-3 shadow-sm">
        {dataUrl ? (
          <img src={dataUrl} alt="Telegram login QR code" width={220} height={220} className="h-[220px] w-[220px]" />
        ) : (
          <div className="flex h-[220px] w-[220px] items-center justify-center text-slate-500">
            <Spinner size={24} />
          </div>
        )}
        {secondsLeft === 0 ? (
          <div className="absolute inset-0 flex items-center justify-center bg-white/85 text-center text-xs font-medium text-slate-700">
            Refreshing code…
          </div>
        ) : null}
      </div>
      <p className="text-center text-xs text-muted">
        Telegram → Settings → Devices → Link Desktop Device.
        <br />
        Code refreshes in {secondsLeft}s.
      </p>
    </div>
  );
}
