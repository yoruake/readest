import { getAIFetch } from '@/services/ai/utils/httpFetch';

/**
 * DeepSeek-powered word lookup, ported from the user's DeepLex / Nama
 * dictionary tool (background.js). It sends the selected word + its
 * surrounding context to DeepSeek and gets back a compact analysis:
 * pronunciation (given in the *context* language, with the source-language
 * reading annotated in parens for loanwords/foreign names), source language,
 * meaning, etymology, and morphology/role.
 *
 * The call is made through `getAIFetch()` so on the Tauri desktop/Android
 * app it goes out from the Rust side (reqwest) — no CORS preflight, no
 * Origin header, no Android cleartext block — exactly like the other AI
 * providers in the app. On the web build it falls back to window.fetch.
 */

const API_ENDPOINT = 'https://api.deepseek.com/v1/chat/completions';
// deepseek-chat is deprecated; v4-flash is fast, v4-pro is slower/more accurate.
const MODEL = 'deepseek-v4-flash';
// v4 defaults to thinking mode which is slow enough to time out; allow 60s.
const API_TIMEOUT_MS = 60000;
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

const SYSTEM_PROMPT = `你是一个多语言查词助手。用户会给你一个词（或词组、句子）和它所在的上下文。请分析它，严格按下面的纯文本格式输出，每个字段独占一行、以对应英文标签开头，不要使用markdown、不要加多余说明：

WORD: 原词
PRON: 读音注音。主读音按「正文语言」给（正文语言＝选区周围上下文所用的语言，即读者正在读的语言）；若该词是外来专名或借词、本族语言与正文语言不同，则在主读音后用括号补「原语读音＋语言名」，如 Zhītián Xìnzhǎng（日 Oda Nobunaga）、púsà（梵 bodhisattva）。注音体系随读音语言：中文用带声调拼音(shān)；日语用黑本式罗马音、可附假名(yama（やま）)；韩语用罗马字；印地/梵语/巴利语用IAST；俄/波斯/阿拉伯/土耳其等用IPA(方括号包裹并标重音 ˈ，如 [keˈtɒːb])
LANG: 该词本身所属或来源的语言（中文名，如：日语、梵语、波斯语）；被正文语言吸收的借词可写「X语（源自Y语）」。它与正文语言不同，就是要在 PRON 补原语读音的信号。
MEANING: 核心词义（中文，1-2个最常用义项）
ETYMOLOGY: 词源词根（一句话简述；借词可给原语拼写）
FORM: 形态与句法作用。变体形式（变格、变位、复数等）先给原形和形态信息再说明语法成分；本身是原形则直接说明形态特征

判定要点：
- 先据上下文定「正文语言」，PRON 主读音必须用正文语言；再判该词本族语言，二者不同就补原语读音。
- 共享文字与借词按「圈」区分本族语言和读音：
  · 汉字圈（中/日/韩/越）：含假名→日语，含谚文→韩语，纯汉字且合中文语境→中文；中文正文里的日本/韩国人名地名，主读音给拼音、括注日语罗马音或韩语罗马字。
  · 梵语/巴利语借词（佛教等）：中/日文里的佛教术语（菩萨、涅槃、般若）主读音按正文（拼音/罗马音），并给梵或巴利原形(IAST)。
  · 阿拉伯字母圈（阿拉伯/波斯/乌尔都/奥斯曼/维吾尔/库尔德）：据上下文与词汇定正文语言；正文里的阿拉伯语借词，主读音给正文语言读音、括注阿拉伯语读音。
  · 西里尔字母圈（俄/乌克兰/保加利亚/塞尔维亚/哈萨克/蒙古）：同形字母不同读音，一律按正文语言定读音。
  · 拉丁字母圈（英/法/德/意/西/土耳其/越南等）：同拼写跨语言，按正文语言与上下文定读音与语言。
  · 专有名词通则：人名地名跨语言保持字形或拼写，主读音按正文语言（读者怎么读）、括注来源语言的原读音与拼写。
- 用IPA的语言（俄/波斯/阿拉伯等）：不标短元音的文字按标准读音补全短元音（波斯语用德黑兰音，短 æ/e/o、长 ɒː/iː/uː）并标重音 ˈ，结合上下文判读。
- 每个字段独占一行、值不换行、尽量简洁；选中内容可长可短都尽力分析。`;

const toShortString = (value: unknown): string => {
  if (value === null || value === undefined) return '';
  return String(value).trim().replace(/\s+/g, ' ');
};

const extractJson = (text: string): Record<string, unknown> => {
  const start = text.indexOf('{');
  const end = text.lastIndexOf('}');
  if (start === -1 || end <= start) return {};
  const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
  return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
};

// Parse the line-tagged format (WORD/PRON/LANG/MEANING/ETYMOLOGY/FORM);
// falls back to the legacy JSON shape. Mirrors DeepLex's parseAnalysis.
const parseAnalysis = (text: string, fallbackWord: string): DeepLexResult => {
  const field = (key: string): string => {
    const match = text.match(new RegExp('^[\\s>*\\-]*' + key + '\\s*[:：]\\s*(.+)$', 'im'));
    return match ? toShortString(match[1]) : '';
  };

  let word = field('WORD');
  let translit = field('PRON') || field('IPA');
  let lang = field('LANG');
  let meaning = field('MEANING');
  let etymology = field('ETYMOLOGY');
  let form = field('FORM');

  if (!word && !meaning && text.indexOf('{') !== -1) {
    try {
      const obj = extractJson(text);
      word = toShortString(obj['word']) || word;
      translit = toShortString(obj['translit']) || translit;
      lang = toShortString(obj['lang']) || lang;
      meaning = toShortString(obj['meaning']) || meaning;
      etymology = toShortString(obj['etymology']) || etymology;
      form = toShortString(obj['form'] ?? obj['role']) || form;
    } catch {
      // ignore a half-baked JSON blob
    }
  }

  return {
    word: word || fallbackWord,
    lang,
    translit,
    meaning,
    etymology,
    form,
  };
};

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
        // Disable thinking mode (v4 enables it by default → slow / timeouts).
        thinking: { type: 'disabled' },
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

    return parseAnalysis(content, word);
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
