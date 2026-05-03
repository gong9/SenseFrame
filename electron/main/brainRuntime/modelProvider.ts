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

export async function callChatCompletions(config: ModelConfig, body: Record<string, unknown>): Promise<any> {
  const response = await fetch(`${config.baseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model: config.model,
      temperature: 0,
      ...body
    })
  });

  if (!response.ok) {
    const text = await response.text().catch(() => '');
    throw new Error(`小宫大脑模型请求失败：${response.status} ${text.slice(0, 1200)}`);
  }

  return response.json();
}
