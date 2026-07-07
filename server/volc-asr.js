'use strict';

const fs = require('fs');
const crypto = require('crypto');

function boolEnv(name, fallback) {
  const value = process.env[name];
  if (value == null || value === '') return fallback;
  return String(value).toLowerCase() === 'true';
}

function resolveVolcAsrConfig() {
  return {
    apiUrl: (process.env.BYTEDANCE_ASR_URL || process.env.VOLCENGINE_ASR_URL || 'https://openspeech.bytedance.com/api/v3/auc/bigmodel/recognize/flash').trim(),
    apiKey: process.env.BYTEDANCE_ASR_API_KEY || process.env.VOLCENGINE_ASR_API_KEY || '',
    appId: process.env.BYTEDANCE_ASR_APP_ID || process.env.VOLCENGINE_ASR_APP_ID || process.env.BYTEDANCE_TTS_APP_ID || '',
    accessKey: process.env.BYTEDANCE_ASR_ACCESS_KEY || process.env.VOLCENGINE_ASR_ACCESS_KEY || process.env.BYTEDANCE_TTS_ACCESS_KEY || '',
    resourceId: process.env.BYTEDANCE_ASR_RESOURCE_ID || process.env.VOLCENGINE_ASR_RESOURCE_ID || 'volc.bigasr.auc_turbo',
    model: process.env.BYTEDANCE_ASR_MODEL || process.env.VOLCENGINE_ASR_MODEL || 'bigmodel',
    language: process.env.BYTEDANCE_ASR_LANGUAGE || process.env.VOLCENGINE_ASR_LANGUAGE || 'zh',
    enablePunc: boolEnv('BYTEDANCE_ASR_ENABLE_PUNC', true),
    enableItn: boolEnv('BYTEDANCE_ASR_ENABLE_ITN', true),
    enableDdc: boolEnv('BYTEDANCE_ASR_ENABLE_DDC', true),
  };
}

async function prepareAsrAudio(file) {
  if (!file || !file.path) throw new Error('没有可供转写的音频文件。');
  return {
    path: file.path,
    name: file.name || 'audio',
    mimeType: file.mimeType || 'audio/mp4',
  };
}

function extractVolcText(data) {
  const result = data && data.result ? data.result : data;
  if (result && typeof result.text === 'string' && result.text.trim()) return result.text.trim();
  const utterances = result && Array.isArray(result.utterances) ? result.utterances : [];
  return utterances
    .map((item) => (item && typeof item.text === 'string' ? item.text.trim() : ''))
    .filter(Boolean)
    .join('\n')
    .trim();
}

async function transcribeVolcengineAudio(file) {
  const config = resolveVolcAsrConfig();
  const hasApiKeyAuth = Boolean(config.apiKey && config.resourceId);
  const hasLegacyAuth = Boolean(config.appId && config.accessKey && config.resourceId);
  if (!hasApiKeyAuth && !hasLegacyAuth) {
    throw new Error('需要配置火山 ASR：BYTEDANCE_ASR_API_KEY / VOLCENGINE_ASR_API_KEY，或 BYTEDANCE_ASR_APP_ID + BYTEDANCE_ASR_ACCESS_KEY。');
  }

  const prepared = await prepareAsrAudio(file);
  const stat = fs.statSync(prepared.path);
  if (stat.size > 100 * 1024 * 1024) {
    throw new Error('火山极速 ASR 当前单文件上限为 100MB，请压缩音频或切分后再转写。');
  }

  const requestId = crypto.randomUUID();
  const headers = hasApiKeyAuth
    ? {
        'X-Api-Key': config.apiKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Request-Id': requestId,
        'X-Api-Sequence': '-1',
        'Content-Type': 'application/json',
      }
    : {
        'X-Api-App-Key': config.appId,
        'X-Api-Access-Key': config.accessKey,
        'X-Api-Resource-Id': config.resourceId,
        'X-Api-Request-Id': requestId,
        'X-Api-Sequence': '-1',
        'Content-Type': 'application/json',
      };

  const response = await fetch(config.apiUrl, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      user: { uid: config.apiKey || config.appId || 'vibego' },
      audio: { data: fs.readFileSync(prepared.path).toString('base64') },
      request: {
        model_name: config.model,
        enable_punc: config.enablePunc,
        enable_itn: config.enableItn,
        enable_ddc: config.enableDdc,
        language: config.language,
      },
    }),
  });

  const raw = await response.text();
  let data = {};
  try {
    data = raw ? JSON.parse(raw) : {};
  } catch {
    data = {};
  }

  const statusCode = response.headers.get('X-Api-Status-Code') || '';
  const statusMessage = response.headers.get('X-Api-Message') || '';
  if (!response.ok || (statusCode && statusCode !== '20000000')) {
    const message = data.message || (data.error && data.error.message) || statusMessage || raw || `HTTP ${response.status}`;
    if (/requested resource not granted/i.test(message)) {
      throw new Error(`火山 ASR 资源未授权：当前 API Key/App 尚未开通 ${config.resourceId}。`);
    }
    throw new Error(`火山 ASR 转写失败：${message}`);
  }

  const text = extractVolcText(data);
  if (!text) throw new Error('火山 ASR 已返回结果，但没有识别到有效文字。');
  return {
    text,
    segments: data && data.result ? data.result.utterances : null,
    provider: 'bytedance',
    model: config.model,
  };
}

module.exports = {
  transcribeVolcengineAudio,
};
