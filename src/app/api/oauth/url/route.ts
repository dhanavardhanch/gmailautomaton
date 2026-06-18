import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/gmail';
import { getAppConfig } from '@/lib/config';

export async function GET(request: Request) {
  try {
    const { searchParams, origin } = new URL(request.url);
    const userId = searchParams.get('userId');

    // Debug mode: return what values are actually being used
    if (searchParams.get('debug') === '1') {
      const config = getAppConfig();
      const redirectUri = `${origin}/api/oauth/callback`;
      return NextResponse.json({
        computedRedirectUri: redirectUri,
        origin,
        clientIdPrefix: config.googleClientId?.slice(0, 20) || 'MISSING',
        clientIdLength: config.googleClientId?.length || 0,
        clientIdHasLeadingSpace: config.googleClientId?.startsWith(' '),
        googleRedirectUriEnvVar: config.googleRedirectUri,
      });
    }

    if (!userId) {
      return NextResponse.json(
        { error: 'userId parameter is required to initialize OAuth flow.' },
        { status: 400 }
      );
    }

    const authUrl = getAuthUrl(userId, origin);
    return NextResponse.json({ url: authUrl });
  } catch (error: any) {
    console.error('Error in GET /api/oauth/url:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
