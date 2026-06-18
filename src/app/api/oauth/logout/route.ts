import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    const { userId } = await request.json();

    if (!userId) {
      return NextResponse.json(
        { error: 'userId parameter is required.' },
        { status: 400 }
      );
    }

    // 1. Delete user threads (which cascades to emails and embeddings)
    const { error: threadsError } = await supabaseAdmin
      .from('email_threads')
      .delete()
      .eq('user_id', userId);

    if (threadsError) {
      console.error('Error deleting threads on logout:', threadsError);
      throw new Error(`Failed to delete email threads: ${threadsError.message}`);
    }

    // 2. Delete Gmail credentials
    const { error: credentialsError } = await supabaseAdmin
      .from('gmail_credentials')
      .delete()
      .eq('id', userId);

    if (credentialsError) {
      console.error('Error deleting credentials on logout:', credentialsError);
      throw new Error(`Failed to delete Gmail credentials: ${credentialsError.message}`);
    }

    return NextResponse.json({
      success: true,
      message: 'Logged out successfully. All synced user data has been purged.',
    });
  } catch (error: any) {
    console.error('Logout error:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
