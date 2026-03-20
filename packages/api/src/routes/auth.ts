import { FastifyPluginAsync } from 'fastify';
import { 
  getAuthUrl, 
  handleOAuthCallback, 
  isAuthenticated, 
  getAuthType,
  initServiceAccount,
  setOAuthTokens
} from '../services/drive.js';
import { config } from '../config.js';

export const authRoutes: FastifyPluginAsync = async (fastify) => {
  // Get auth status
  fastify.get('/status', async () => {
    return {
      authenticated: isAuthenticated(),
      authType: getAuthType(),
      hasServiceAccountConfig: !!(config.GOOGLE_SERVICE_ACCOUNT_EMAIL && config.GOOGLE_PRIVATE_KEY),
      hasOAuthConfig: !!(config.GOOGLE_CLIENT_ID && config.GOOGLE_CLIENT_SECRET),
      hasGeminiConfig: !!config.GEMINI_API_KEY,
    };
  });

  // Get OAuth URL for browser-based auth
  fastify.get('/oauth/url', async () => {
    if (!config.GOOGLE_CLIENT_ID || !config.GOOGLE_CLIENT_SECRET) {
      throw { statusCode: 400, message: 'OAuth not configured' };
    }
    return { url: getAuthUrl() };
  });

  // OAuth callback
  fastify.get('/callback', async (request, reply) => {
    const { code, error } = request.query as { code?: string; error?: string };
    const dashboardAuthUrl = new URL('/auth', config.DASHBOARD_URL);

    if (error) {
      dashboardAuthUrl.searchParams.set('error', error);
      return reply.redirect(dashboardAuthUrl.toString());
    }

    if (!code) {
      dashboardAuthUrl.searchParams.set('error', 'No code provided');
      return reply.redirect(dashboardAuthUrl.toString());
    }

    try {
      await handleOAuthCallback(code);
      dashboardAuthUrl.searchParams.set('success', 'true');
      return reply.redirect(dashboardAuthUrl.toString());
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      dashboardAuthUrl.searchParams.set('error', message);
      return reply.redirect(dashboardAuthUrl.toString());
    }
  });

  // Initialize service account auth
  fastify.post('/service-account', {
    config: {
      rawBody: true,
    },
  }, async (request) => {
    try {
      await initServiceAccount();
      return { success: true, message: 'Service account authenticated' };
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      throw { statusCode: 400, message };
    }
  });

  // Set OAuth tokens directly (for restoring session)
  fastify.post('/oauth/tokens', async (request) => {
    const { access_token, refresh_token, expiry_date } = request.body as {
      access_token: string;
      refresh_token: string;
      expiry_date: number;
    };

    if (!access_token || !refresh_token) {
      throw { statusCode: 400, message: 'Missing tokens' };
    }

    setOAuthTokens({ access_token, refresh_token, expiry_date });
    return { success: true };
  });
};
