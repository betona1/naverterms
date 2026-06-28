import { useState, useEffect } from 'react';
import axios from 'axios';

const api = axios.create({ baseURL: '/api/settings' });

interface ApiKeys {
  NAVER_CLIENT_ID: string;
  NAVER_CLIENT_SECRET: string;
  NAVER_AD_API_KEY: string;
  NAVER_AD_SECRET_KEY: string;
  NAVER_AD_CUSTOMER_ID: string;
}

const FIELDS: { key: keyof ApiKeys; label: string; placeholder: string; group: string }[] = [
  { key: 'NAVER_CLIENT_ID',     label: '클라이언트 ID',    placeholder: '네이버 데이터랩 Client ID',     group: 'datalab' },
  { key: 'NAVER_CLIENT_SECRET', label: '클라이언트 시크릿', placeholder: '네이버 데이터랩 Client Secret',  group: 'datalab' },
  { key: 'NAVER_AD_API_KEY',    label: 'API 액세스 키',    placeholder: '검색광고 Access License',       group: 'ad' },
  { key: 'NAVER_AD_SECRET_KEY', label: 'API 시크릿 키',    placeholder: '검색광고 Secret Key',           group: 'ad' },
  { key: 'NAVER_AD_CUSTOMER_ID','label': '고객 ID',        placeholder: '검색광고 Customer ID',          group: 'ad' },
];

export default function ApiSettingsPage() {
  const [keys, setKeys] = useState<ApiKeys>({
    NAVER_CLIENT_ID: '', NAVER_CLIENT_SECRET: '',
    NAVER_AD_API_KEY: '', NAVER_AD_SECRET_KEY: '', NAVER_AD_CUSTOMER_ID: '',
  });
  const [saved, setSaved] = useState(false);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [showSecrets, setShowSecrets] = useState<Record<string, boolean>>({});

  useEffect(() => {
    api.get('/api-keys/').then(r => { setKeys(r.data); setLoading(false); }).catch(() => setLoading(false));
  }, []);

  const handleSave = async () => {
    setSaving(true); setError('');
    try {
      await api.post('/api-keys/', keys);
      setSaved(true);
      setTimeout(() => setSaved(false), 3000);
    } catch {
      setError('저장 실패. 서버 연결을 확인해 주세요.');
    } finally {
      setSaving(false);
    }
  };

  const toggle = (key: string) => setShowSecrets(p => ({ ...p, [key]: !p[key] }));

  const datalabFields = FIELDS.filter(f => f.group === 'datalab');
  const adFields = FIELDS.filter(f => f.group === 'ad');

  const card = 'rounded-xl border p-6 space-y-4';
  const darkCard = 'bg-[#12122a] border-[#1e1e3a]';
  const lightCard = 'bg-white border-gray-200 shadow-sm';

  if (loading) return (
    <div className="flex items-center justify-center h-64">
      <div className="text-gray-400 text-sm">불러오는 중...</div>
    </div>
  );

  return (
    <div className="p-6 max-w-2xl mx-auto space-y-6">
      <div>
        <h1 className="text-xl font-bold dark:text-white text-gray-900">API 키 설정</h1>
        <p className="text-sm text-gray-500 mt-1">네이버 데이터랩 및 검색광고 API 인증 정보를 입력합니다.</p>
      </div>

      {/* 데이터랩 */}
      <div className={`${card} dark:${darkCard} ${lightCard}`}>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 rounded-full bg-green-500"/>
          <span className="font-semibold text-sm dark:text-white text-gray-800">네이버 데이터랩 API</span>
          <a href="https://developers.naver.com/apps/#/register" target="_blank" rel="noopener noreferrer"
             className="ml-auto text-xs text-blue-400 hover:underline">앱 등록 →</a>
        </div>
        {datalabFields.map(f => (
          <FieldRow key={f.key} field={f} value={keys[f.key]} show={!!showSecrets[f.key]}
            onChange={v => setKeys(p => ({ ...p, [f.key]: v }))}
            onToggleShow={() => toggle(f.key)} />
        ))}
      </div>

      {/* 검색광고 */}
      <div className={`${card} dark:${darkCard} ${lightCard}`}>
        <div className="flex items-center gap-2 mb-2">
          <div className="w-2 h-2 rounded-full bg-blue-500"/>
          <span className="font-semibold text-sm dark:text-white text-gray-800">네이버 검색광고 API</span>
          <a href="https://api.naver.com" target="_blank" rel="noopener noreferrer"
             className="ml-auto text-xs text-blue-400 hover:underline">API 센터 →</a>
        </div>
        {adFields.map(f => (
          <FieldRow key={f.key} field={f} value={keys[f.key]} show={!!showSecrets[f.key]}
            onChange={v => setKeys(p => ({ ...p, [f.key]: v }))}
            onToggleShow={() => toggle(f.key)} />
        ))}
      </div>

      {error && <p className="text-red-500 text-sm">{error}</p>}

      <button onClick={handleSave} disabled={saving}
              className={`w-full py-2.5 rounded-lg text-sm font-semibold text-white transition-colors
                ${saving ? 'bg-gray-400 cursor-not-allowed' : saved
                  ? 'bg-green-600' : 'bg-[#03c75a] hover:bg-[#02b34f]'}`}>
        {saving ? '저장 중...' : saved ? '✓ 저장 완료' : '저장'}
      </button>

      <p className="text-xs text-gray-400 text-center">
        API 키는 서버의 .env 파일에 안전하게 저장됩니다. 변경 후 서버 재시작이 필요할 수 있습니다.
      </p>
    </div>
  );
}

function FieldRow({ field, value, show, onChange, onToggleShow }:
  { field: typeof FIELDS[0]; value: string; show: boolean; onChange: (v: string) => void; onToggleShow: () => void }) {
  const isSecret = field.key.toLowerCase().includes('secret') || field.key.toLowerCase().includes('key');

  return (
    <div>
      <label className="block text-xs font-medium text-gray-500 dark:text-gray-400 mb-1">{field.label}</label>
      <div className="relative">
        <input
          type={isSecret && !show ? 'password' : 'text'}
          value={value}
          onChange={e => onChange(e.target.value)}
          placeholder={field.placeholder}
          className="w-full px-3 py-2 pr-10 rounded-lg border text-sm
            dark:bg-[#0f0f1a] dark:border-[#2a2a4a] dark:text-white dark:placeholder-gray-600
            bg-gray-50 border-gray-200 text-gray-900 placeholder-gray-400
            focus:outline-none focus:ring-2 focus:ring-[#03c75a]/40"
        />
        {isSecret && (
          <button onClick={onToggleShow} type="button"
                  className="absolute right-2.5 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600">
            {show ? (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M13.875 18.825A10.05 10.05 0 0112 19c-4.478 0-8.268-2.943-9.543-7a9.97 9.97 0 011.563-3.029m5.858.908a3 3 0 114.243 4.243M9.878 9.878l4.242 4.242M9.88 9.88l-3.29-3.29m7.532 7.532l3.29 3.29M3 3l3.59 3.59m0 0A9.953 9.953 0 0112 5c4.478 0 8.268 2.943 9.543 7a10.025 10.025 0 01-4.132 5.411m0 0L21 21"/>
              </svg>
            ) : (
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M15 12a3 3 0 11-6 0 3 3 0 016 0z"/>
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2}
                      d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z"/>
              </svg>
            )}
          </button>
        )}
      </div>
    </div>
  );
}
