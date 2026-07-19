import { getAIFetch } from '@/services/ai/utils/httpFetch';

/**
 * DeepSeek-powered word lookup, ported from the user's DeepLex browser
 * extension (background.js). It sends the selected word + its sentence to
 * DeepSeek and gets back a compact JSON analysis: pronunciation (by
 * language-appropriate system), etymology, meaning, and morphology/role.
 *
 * The call is made through `getAIFetch()` so on the Tauri desktop/Android
 * app it goes out from the Rust side (reqwest) — no CORS preflight, no
 * Origin header, no Android cleartext block — exactly like the other AI
 * providers in the app. On the web build it falls back to window.fetch.
 */

const API_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
const MODEL = 'deepseek-chat';
const API_TIMEOUT_MS = 20000;
const API_KEY_STORAGE_KEY = 'deeplex.deepseek.apiKey';

export interface DeepLexResult {
  word: string;
  lang: string;
  translit: string;
  etymology: string;
  meaning: string;
  form: string;
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>;
  error?: { message?: string };
}

export const getDeepSeekApiKey = (): string => {
  try {
    return (localStorage.getItem(API_KEY_STORAGE_KEY) || '').trim();
  } catch {
    return '';
  }
};

export const setDeepSeekApiKey = (key: string): void => {
  try {
    localStorage.setItem(API_KEY_STORAGE_KEY, key.trim());
  } catch {
    // ignore write failures (private mode etc.)
  }
};

const SYSTEM_PROMPT = `你是一个多语言查词助手。用户会给你一个外语单词和它所在的句子。请分析这个词，返回严格的JSON格式，不要任何额外说明文字，不要markdown代码块标记。

返回格式：
{
  "word": "原词",
  "lang": "语言名称（中文，如：波斯语、俄语）",
  "translit": "发音注音，按语言选体系：汉语(中文)用带声调的汉语拼音(如 nǐhǎo)；日语用黑本式罗马音、可附假名(如 yama（やま）)；韩语用罗马字；印地语/梵语用IAST；其余语言(俄语、波斯语、阿拉伯语、土耳其语等)用IPA国际音标(方括号包裹、标重音 ˈ)",
  "etymology": "词源词根（一句话简述，可追溯到的最早语言层次）",
  "meaning": "核心词义（中文，1-2个最常用的义项）",
  "form": "形态与句法作用。如果该词是变体形式（变格、变位、复数等），先给出原形和形态信息，再说明在句中的语法成分。格式参考：'原形 形态信息，作XX'。如果该词本身就是原形，直接说明形态特征和句中作用。"
}

要求：
- 输出必须是合法的JSON
- 每个字段尽量简洁，不要展开成段落
- 先根据上下文准确判断语言，translit 的注音体系必须与判定的语言一致（中文用拼音、日语用罗马音、韩语用罗马字、印地/梵语用IAST，其余用IPA）
- 共用文字务必据上下文区分：汉字可能是中文或日语——句中含假名(かな)判为日语、纯汉字且符合中文语法判为中文；阿拉伯字母可能是阿拉伯语/波斯语/突厥语(奥斯曼语、维吾尔语等)，按词汇与上下文区分
- 使用 IPA 的语言（俄语、波斯语、阿拉伯语等）：不标短元音的文字要按标准读音补全短元音（波斯语用标准德黑兰音，短 æ/e/o、长 ɒː/iː/uː）并标重音 ˈ；结合上下文判断读法，歧义时选与句意相符、最常见的读法

示例：
- 俄语 решил：translit 为 IPA '[rʲɪˈʂɨl]'，form 为 'решить 完成体过去时阳性单数，作谓语'
- 波斯语 کتاب：translit 为 IPA '[keˈtɒːb]'，form 为 '名词单数，作主语'
- 汉语 山：translit 为拼音 'shān'（不用IPA）
- 日语 山：translit 为罗马音 'yama（やま）'（据假名/上下文判为日语，别当成中文）`;

const toShortString = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
};

const parseModelJson = (content: string): Record<string, unknown> => {
  const cleaned = content
    .trim()
    .replace(/^```(?:json)?/i, '')
    .replace(/```$/i, '')
    .trim();

  const tryParse = (text: string): Record<string, unknown> | null => {
    try {
      const parsed = JSON.parse(text) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch {
      // fall through
    }
    return null;
  };

  const direct = tryParse(cleaned);
  if (direct) return direct;

  const start = cleaned.indexOf('{');
  const end = cleaned.lastIndexOf('}');
  if (start !== -1 && end > start) {
    const sliced = tryParse(cleaned.slice(start, end + 1));
    if (sliced) return sliced;
  }

  throw new Error('解析失败');
};

const normalize = (data: Record<string, unknown>, fallbackWord: string): DeepLexResult => ({
  word: toShortString(data['word']) || fallbackWord,
  lang: toShortString(data['lang']) || '未知语言',
  translit: toShortString(data['translit']),
  etymology: toShortString(data['etymology']),
  meaning: toShortString(data['meaning']),
  form: toShortString(data['form'] ?? data['role']),
});

export async function lookupWithDeepSeek(
  word: string,
  sentence: string,
  apiKey: string,
): Promise<DeepLexResult> {
  const fetchFn = getAIFetch();
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), API_TIMEOUT_MS);

  try {
    const response = await fetchFn(API_ENDPOINT, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify({
        model: MODEL,
        temperature: 0.2,
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: `单词：${word}\n句子：${sentence}` },
        ],
      }),
    });

    const responseText = await response.text();
    let payload: ChatCompletionResponse | null = null;
    try {
      payload = JSON.parse(responseText) as ChatCompletionResponse;
    } catch {
      payload = null;
    }

    if (!response.ok) {
      const apiMessage = payload?.error?.message || responseText || 'API 调用失败';
      if (response.status === 401) throw new Error('API Key 无效');
      if (
        response.status === 402 ||
        /insufficient|balance|quota|余额|欠费/i.test(apiMessage)
      ) {
        throw new Error('DeepSeek 账户余额不足');
      }
      throw new Error(apiMessage);
    }

    const content = payload?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      throw new Error('解析失败');
    }

    return normalize(parseModelJson(content), word);
  } catch (err) {
    if (err instanceof DOMException && err.name === 'AbortError') {
      throw new Error('请求超时，请重试');
    }
    if (err instanceof Error) throw err;
    throw new Error('网络错误，请重试');
  } finally {
    clearTimeout(timeoutId);
  }
}
