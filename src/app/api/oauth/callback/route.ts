import { NextResponse } from 'next/server';
import { google } from 'googleapis';
import { getOAuthClient, getTokensFromCode } from '@/lib/gmail';
import { supabaseAdmin } from '@/lib/supabase';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const code = searchParams.get('code');
    const userId = searchParams.get('state'); // The state parameter contains the user's Supabase ID

    if (!code || !userId) {
      return NextResponse.json(
        { error: 'Missing code or state state parameters in OAuth callback.' },
        { status: 400 }
      );
    }

    // 1. Exchange authorization code for tokens
    const tokens = await getTokensFromCode(code);
    const { access_token, refresh_token, expiry_date } = tokens;

    if (!access_token) {
      throw new Error('Failed to retrieve access token from Google.');
    }

    // 2. Fetch the user's Gmail address to verify identity
    const authClient = getOAuthClient();
    authClient.setCredentials(tokens);

    const oauth2 = google.oauth2({ version: 'v2', auth: authClient as any });
    const userInfoResponse = await oauth2.userinfo.get();
    const gmailAddress = userInfoResponse.data.email;

    if (!gmailAddress) {
      throw new Error('Failed to retrieve email address from Google profile.');
    }

    // 3. Save or Update credentials in Supabase using the Admin client (bypasses RLS for sync)
    // Note: If refresh_token is not returned (e.g. user re-authenticated without revoking), 
    // we keep the existing one in the database so we do not lose background access!
    const { data: existingCreds } = await supabaseAdmin
      .from('gmail_credentials')
      .select('refresh_token')
      .eq('id', userId)
      .single();

    const finalRefreshToken = refresh_token || existingCreds?.refresh_token;

    if (!finalRefreshToken) {
      throw new Error('No refresh token obtained. Please revoke app access in Google Settings and reconnect.');
    }

    const { error: upsertError } = await supabaseAdmin
      .from('gmail_credentials')
      .upsert({
        id: userId,
        email: gmailAddress,
        access_token: access_token,
        refresh_token: finalRefreshToken,
        token_expiry: new Date(expiry_date || Date.now() + 3600 * 1000).toISOString(),
        sync_status: 'idle',
        updated_at: new Date().toISOString(),
      });

    if (upsertError) {
      console.error('Database error saving Gmail credentials:', upsertError);
      throw new Error(`Failed to save Gmail credentials: ${upsertError.message}`);
    }

    // 4. Redirect user back to the front-end dashboard
    const baseUrl = new URL(request.url).origin;
    return NextResponse.redirect(`${baseUrl}/dashboard?sync=trigger`);
  } catch (error: any) {
    console.error('Error in OAuth callback:', error);
    const baseUrl = new URL(request.url).origin;
    return NextResponse.redirect(`${baseUrl}/?error=${encodeURIComponent(error.message || String(error))}`);
  }
}
