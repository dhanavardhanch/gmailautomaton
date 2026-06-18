import { NextResponse } from 'next/server';
import { getAuthUrl } from '@/lib/gmail';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json(
        { error: 'userId parameter is required to initialize OAuth flow.' },
        { status: 400 }
      );
    }

    const authUrl = getAuthUrl(userId);
    return NextResponse.json({ url: authUrl });
  } catch (error: any) {
    console.error('Error in GET /api/oauth/url:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
