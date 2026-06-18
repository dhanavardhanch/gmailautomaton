import { NextResponse } from 'next/server';
import { syncUserInbox } from '@/lib/sync';
import { supabaseAdmin } from '@/lib/supabase';

export async function POST(request: Request) {
  try {
    let body;
    try {
      body = await request.json();
    } catch {
      body = {};
    }

    const { userId, maxThreads = 20 } = body;

    if (!userId) {
      return NextResponse.json(
        { error: 'userId parameter is required in the request body.' },
        { status: 400 }
      );
    }

    console.log(`Manual sync requested for user: ${userId}, maxThreads: ${maxThreads}`);
    
    // Set sync status to syncing synchronously to prevent frontend race conditions
    await supabaseAdmin
      .from('gmail_credentials')
      .update({ sync_status: 'syncing', updated_at: new Date().toISOString() })
      .eq('id', userId);

    // Perform sync in the background
    syncUserInbox(userId, maxThreads).catch((err) => {
      console.error(`Background sync error for user ${userId}:`, err);
    });

    return NextResponse.json({
      success: true,
      message: 'Inbox synchronization initiated in background.',
    });
  } catch (error: any) {
    console.error('Error in POST /api/sync:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json(
        { error: 'userId is required as a query parameter.' },
        { status: 400 }
      );
    }

    console.log(`Async sync requested via GET for user: ${userId}`);

    // Set sync status to syncing
    await supabaseAdmin
      .from('gmail_credentials')
      .update({ sync_status: 'syncing', updated_at: new Date().toISOString() })
      .eq('id', userId);

    // Perform sync in the background
    syncUserInbox(userId, 20).catch((err) => {
      console.error(`Background sync error for user ${userId}:`, err);
    });

    return NextResponse.json({
      success: true,
      message: 'Inbox synchronization initiated in background.',
    });
  } catch (error: any) {
    console.error('Error in GET /api/sync:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
