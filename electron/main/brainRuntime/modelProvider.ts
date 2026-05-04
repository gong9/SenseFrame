export type ModelConfig = {
  apiKey: string;
  baseUrl: string;
  model: string;
};

export function getModelConfig(): ModelConfig {
  const apiKey = process.env.OPENAI_API_KEY?.trim();
  if (!apiKey) {
    throw new Error('小宫大脑没有模型配置，不能执行需要推理/视觉判断的任务。请配置 OPENAI_API_KEY / OPENAI_BASE_URL / OPENAI_MODEL。');
  }
  return {
    apiKey,
    baseUrl: process.env.OPENAI_BASE_URL?.trim() || 'https://api.openai.com/v1',
    model: process.env.OPENAI_MODEL?.trim() || process.env.OPENAI_VISION_MODEL?.trim() || 'gpt-5.5'
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryableModelError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? (error as Error & { cause?: any }).cause : undefined;
  const code = cause?.code ? String(cause.code) : '';
  if (/413|Payload Too Large|Invalid URL|401|403|404/.test(message)) return false;
  return /fetch failed|ECONNRESET|ETIMEDOUT|EAI_AGAIN|ENOTFOUND|socket|network|timeout|超时/i.test(`${message} ${code}`);
}

async function callChatCompletionsOnce(config: ModelConfig, body: Record<string, unknown>): Promise<any> {
  const timeoutMs = Math.max(10_000, Math.min(180_000, Number(process.env.OPENAI_REQUEST_TIMEOUT_MS) || 65_000));
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  let response: Response;

  try {
    response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${config.apiKey}`,
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: config.model,
        temperature: 0,
        ...body
      }),
      signal: controller.signal
    });
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`小宫大脑模型请求超时：${timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`小宫大脑模型请求失败：${response.status} ${text.slice(0, 1200)}`);
  }

  return response.json();
}

export async function callChatCompletions(config: ModelConfig, body: Record<string, unknown>): Promise<any> {
  const maxAttempts = Math.max(1, Math.min(4, Number(process.env.OPENAI_REQUEST_RETRIES) || 3));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      return await callChatCompletionsOnce(config, body);
    } catch (error) {
      lastError = error;
      if (attempt >= maxAttempts || !retryableModelError(error)) break;
      await sleep(500 * attempt);
    }
  }

  throw lastError;
}
