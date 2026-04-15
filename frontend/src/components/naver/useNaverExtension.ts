import { useState, useEffect, useCallback, useRef } from 'react';

interface ExtensionStatus {
  connected: boolean;
  version?: string;
  mode?: string | null;
  isPaused?: boolean;
  isProcessing?: boolean;
  queueLength?: number;
  completed?: number;
  pending?: number;
  errors?: number;
}

interface ProgressEvent {
  type: string;
  keyword?: string;
  current?: number;
  total?: number;
  terms?: string[];
  productCount?: number;
  tabType?: string;
  tab?: string;
  tabLabel?: string;
  tabProgress?: string;
  nextTab?: string;
  nextTabLabel?: string;
  completedTabs?: string[];
  captchaType?: string;
  message?: string;
  resolved?: boolean;
  error?: string;
  status?: string;
  mode?: string;
}

export function useNaverExtension() {
  const [extStatus, setExtStatus] = useState<ExtensionStatus>({ connected: false });
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  const [captcha, setCaptcha] = useState<{ active: boolean; type?: string; message?: string }>({ active: false });
  const listenersRef = useRef<((e: ProgressEvent) => void)[]>([]);

  // 확장프로그램 연결 확인 (ping)
  const checkConnection = useCallback(() => {
    window.postMessage({ type: 'NAVER_PING' }, '*');
  }, []);

  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== window) return;
      const msg = event.data;
      if (!msg?.type) return;

      switch (msg.type) {
        case 'NAVER_PONG':
          setExtStatus(prev => ({ ...prev, connected: true, version: msg.data?.version }));
          break;

        case 'NAVER_TRACKING_PROGRESS':
          setProgress(msg);
          listenersRef.current.forEach(fn => fn(msg));
          break;

        case 'NAVER_TAB_COMPLETE':
          setProgress(msg);
          listenersRef.current.forEach(fn => fn(msg));
          break;

        case 'NAVER_SEARCH_COMPLETE':
        case 'NAVER_RANK_COMPLETE':
          setProgress(msg);
          listenersRef.current.forEach(fn => fn(msg));
          break;

        case 'NAVER_CAPTCHA_ALERT':
          if (msg.resolved) {
            setCaptcha({ active: false });
          } else {
            setCaptcha({ active: true, type: msg.captchaType, message: msg.message });
          }
          listenersRef.current.forEach(fn => fn(msg));
          break;

        case 'NAVER_ERROR':
          setProgress(msg);
          listenersRef.current.forEach(fn => fn(msg));
          break;

        case 'NAVER_QUEUE_STATUS':
          if (msg.status === 'complete') {
            setProgress(null);
          }
          listenersRef.current.forEach(fn => fn(msg));
          break;

        case 'NAVER_GET_STATUS_RESPONSE':
          if (msg.data) {
            setExtStatus(prev => ({ ...prev, ...msg.data }));
          }
          break;
      }
    };

    window.addEventListener('message', handler);
    // 초기 ping
    checkConnection();
    const interval = setInterval(checkConnection, 5000);

    return () => {
      window.removeEventListener('message', handler);
      clearInterval(interval);
    };
  }, [checkConnection]);

  const startTermSearch = useCallback((keywords: string[]) => {
    window.postMessage({ type: 'NAVER_START_TERM_SEARCH', keywords }, '*');
  }, []);

  const startRankTracking = useCallback((targets: any[]) => {
    window.postMessage({ type: 'NAVER_START_RANK_TRACKING', targets }, '*');
  }, []);

  const cancel = useCallback(() => {
    window.postMessage({ type: 'NAVER_CANCEL' }, '*');
    setProgress(null);
  }, []);

  const setSchedule = useCallback((schedule: any) => {
    window.postMessage({ type: 'NAVER_SET_SCHEDULE', schedule }, '*');
  }, []);

  const onProgress = useCallback((fn: (e: ProgressEvent) => void) => {
    listenersRef.current.push(fn);
    return () => {
      listenersRef.current = listenersRef.current.filter(f => f !== fn);
    };
  }, []);

  return {
    extStatus,
    progress,
    captcha,
    startTermSearch,
    startRankTracking,
    cancel,
    setSchedule,
    onProgress,
  };
}
