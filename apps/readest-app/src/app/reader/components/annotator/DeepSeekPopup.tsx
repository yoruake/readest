import React, { useEffect, useRef, useState } from 'react';
import { FiSettings } from 'react-icons/fi';
import Popup from '@/components/Popup';
import { Position } from '@/utils/sel';
import {
  DeepLexResult,
  getDeepSeekApiKey,
  lookupWithDeepSeek,
  setDeepSeekApiKey,
} from '@/services/deeplex';

interface DeepSeekPopupProps {
  word: string;
  sentence: string;
  position: Position;
  trianglePosition: Position;
  popupWidth: number;
  popupHeight: number;
  onDismiss?: () => void;
}

const Field: React.FC<{ label: string; value: string; mono?: boolean }> = ({
  label,
  value,
  mono,
}) => {
  if (!value) return null;
  return (
    <div className='mb-3'>
      <div className='mb-0.5 text-xs opacity-60'>{label}</div>
      <div className={mono ? 'text-base font-medium tracking-wide' : 'text-base'}>{value}</div>
    </div>
  );
};

const DeepSeekPopup: React.FC<DeepSeekPopupProps> = ({
  word,
  sentence,
  position,
  trianglePosition,
  popupWidth,
  popupHeight,
  onDismiss,
}) => {
  const [apiKey, setApiKey] = useState(getDeepSeekApiKey());
  const [keyInput, setKeyInput] = useState('');
  const [result, setResult] = useState<DeepLexResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [editingKey, setEditingKey] = useState(false);
  const reqIdRef = useRef(0);

  useEffect(() => {
    if (!apiKey || !word) return;
    const reqId = ++reqIdRef.current;
    setLoading(true);
    setError(null);
    setResult(null);
    lookupWithDeepSeek(word, sentence || word, apiKey)
      .then((data) => {
        if (reqId !== reqIdRef.current) return;
        setResult(data);
      })
      .catch((err: unknown) => {
        if (reqId !== reqIdRef.current) return;
        setError(err instanceof Error ? err.message : '查询失败，请重试');
      })
      .finally(() => {
        if (reqId !== reqIdRef.current) return;
        setLoading(false);
      });
  }, [word, sentence, apiKey]);

  const handleSaveKey = () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setDeepSeekApiKey(trimmed);
    setApiKey(trimmed);
    setKeyInput('');
    setEditingKey(false);
  };

  const showKeyForm = !apiKey || editingKey;

  return (
    <div>
      <Popup
        trianglePosition={trianglePosition}
        width={popupWidth}
        minHeight={popupHeight}
        maxHeight={720}
        position={position}
        className='not-eink:text-white flex h-full select-text flex-col bg-gray-600'
        triangleClassName='text-gray-600'
        onDismiss={onDismiss}
      >
        <div className='flex items-center justify-between px-4 pt-3'>
          <h1 className='truncate text-lg font-medium'>{word}</h1>
          <div className='flex items-center gap-2'>
            {result?.lang && (
              <span className='rounded bg-white/15 px-1.5 py-0.5 text-xs'>{result.lang}</span>
            )}
            {apiKey && (
              <button
                className='opacity-60 hover:opacity-100'
                title='修改 DeepSeek API Key'
                onClick={() => {
                  setEditingKey(true);
                  setKeyInput('');
                }}
              >
                <FiSettings size={14} />
              </button>
            )}
          </div>
        </div>

        <div className='min-h-0 flex-1 overflow-y-auto px-4 py-3 font-sans'>
          {showKeyForm ? (
            <div className='flex flex-col gap-2'>
              <p className='text-sm opacity-80'>
                首次使用请填入 DeepSeek API Key（保存在本地，仅用于查词）。
              </p>
              <input
                type='password'
                className='w-full rounded bg-white/10 px-2 py-1.5 text-sm outline-none placeholder:opacity-40'
                placeholder='sk-...'
                value={keyInput}
                autoFocus
                onChange={(e) => setKeyInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') handleSaveKey();
                }}
              />
              <div className='flex items-center gap-2'>
                <button
                  className='rounded bg-white/20 px-3 py-1 text-sm hover:bg-white/30 disabled:opacity-40'
                  disabled={!keyInput.trim()}
                  onClick={handleSaveKey}
                >
                  保存并查询
                </button>
                {editingKey && apiKey && (
                  <button
                    className='px-2 py-1 text-sm opacity-60 hover:opacity-100'
                    onClick={() => setEditingKey(false)}
                  >
                    取消
                  </button>
                )}
              </div>
              <a
                className='text-xs underline opacity-50 hover:opacity-80'
                href='https://platform.deepseek.com/api_keys'
                target='_blank'
                rel='noreferrer'
              >
                获取 DeepSeek API Key
              </a>
            </div>
          ) : loading ? (
            <p className='text-base italic opacity-60'>查询中…</p>
          ) : error ? (
            <p className='text-base text-red-400'>{error}</p>
          ) : result ? (
            <div>
              <Field label='发音' value={result.translit} mono />
              <Field label='词义' value={result.meaning} />
              <Field label='词源' value={result.etymology} />
              <Field label='形态 / 句法' value={result.form} />
            </div>
          ) : (
            <p className='text-base italic opacity-60'>暂无结果</p>
          )}
        </div>

        <div className='flex-shrink-0 px-4 pb-2 text-right text-xs opacity-40'>
          由 DeepSeek 提供
        </div>
      </Popup>
    </div>
  );
};

export default DeepSeekPopup;
