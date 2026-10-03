import { Router } from 'express';
import { config } from '../config.ts';
import { HttpError, badRequest } from '../middleware/errors.ts';
import { rateLimit } from '../middleware/rate-limit.ts';
import { UpstreamError } from '../providers/errors.ts';
import { headerReader } from '../providers/index.ts';
import { generateImage, type ImageBackend } from '../providers/image.ts';

export const imageRouter = Router();

const MAX_PROMPT_LENGTH = 32_000;

const RATE_LIMITED = {
  code: 'rate_limited',
  message: 'You are generating images too quickly. Please wait a moment.',
};

const ownerLimiter = rateLimit({
  ...RATE_LIMITED,
  windowMs: config.chatRateLimit.windowMs,
  max: config.chatRateLimit.perOwner,
  key: (req) => `owner:${req.ownerId}`,
});
const ipLimiter = rateLimit({
  ...RATE_LIMITED,
  windowMs: config.chatRateLimit.windowMs,
  max: config.chatRateLimit.perIp,
  key: (req) => `ip:${req.ip ?? 'unknown'}`,
});

/**
 * POST /api/image
 *
 * Body: { prompt: string, provider: "openai" | "gemini", model?: string }
 * Responds with JSON: { image: { dataUrl, mimeType }, provider, model }
 *
 * BYOK headers mirror /api/chat: X-Provider-Key is required, and
 * X-Provider-Base-Url / X-Provider-Model override the vendor defaults.
 */
imageRouter.post('/', ownerLimiter, ipLimiter, async (req, res, next) => {
  try {
    const { prompt, provider, model } = req.body ?? {};

    if (typeof prompt !== 'string' || prompt.trim() === '') {
      throw badRequest('"prompt" is required and must be a non-empty string');
    }
    if (prompt.length > MAX_PROMPT_LENGTH) {
      throw badRequest(`"prompt" must be at most ${MAX_PROMPT_LENGTH} characters`);
    }
    if (provider !== 'openai' && provider !== 'gemini') {
      throw badRequest('"provider" must be "openai" or "gemini"');
    }
    if (model != null && typeof model !== 'string') {
      throw badRequest('"model" must be a string when provided');
    }

    const headers = headerReader(req.headers);
    const apiKey = (headers.get('X-Provider-Key') ?? '').trim();
    if (apiKey === '') {
      throw badRequest('Add an API key for Image in Settings', {
        code: 'missing_api_key',
        extra: { model: 'Image' },
      });
    }

    const baseUrl = headers.get('X-Provider-Base-Url');
    const overrideModel = headers.get('X-Provider-Model');

    let result;
    try {
      result = await generateImage({
        prompt: prompt.trim(),
        provider: provider as ImageBackend,
        apiKey,
        ...(baseUrl !== undefined && baseUrl.trim() !== '' ? { baseUrl } : {}),
        ...(overrideModel !== undefined && overrideModel.trim() !== ''
          ? { model: overrideModel }
          : {}),
      });
    } catch (error) {
      if (error instanceof UpstreamError) {
        const status = error.status >= 400 && error.status <= 599 ? error.status : 502;
        throw new HttpError(status, error.message, {
          code: 'upstream_error',
          extra: {
            model: 'Image',
            ...(error.code !== undefined ? { upstreamCode: error.code } : {}),
          },
        });
      }
      throw error;
    }

    res.json({
      image: { dataUrl: result.dataUrl, mimeType: result.mimeType },
      provider: result.provider,
      model: result.model,
    });
  } catch (error) {
    next(error);
  }
});
