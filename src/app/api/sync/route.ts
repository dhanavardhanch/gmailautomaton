import { NextResponse } from 'next/server';
import { syncUserInbox, enrichEmails } from '@/lib/sync';
import { supabaseAdmin } from '@/lib/supabase';
import { after } from 'next/server';

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

    // Perform Phase 1 sync synchronously so it blocks Vercel just long enough to save raw emails
    const syncResult = await syncUserInbox(userId, maxThreads);
    const newMessageIdsForAI = syncResult.newMessageIdsForAI;

    if (syncResult.success && newMessageIdsForAI && newMessageIdsForAI.length > 0) {
      after(async () => {
        try {
          await enrichEmails(userId, newMessageIdsForAI);
        } catch (err) {
          console.error(`Background Phase 2 AI enrichment error for user ${userId}:`, err);
        }
      });
    }

    return NextResponse.json({
      success: syncResult.success,
      message: syncResult.success 
        ? 'Inbox synchronization completed.' 
        : `Inbox synchronization failed: ${syncResult.error}`,
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

    // Perform Phase 1 sync
    const syncResult = await syncUserInbox(userId, 20);
    const newMessageIdsForAI = syncResult.newMessageIdsForAI;

    if (syncResult.success && newMessageIdsForAI && newMessageIdsForAI.length > 0) {
      after(async () => {
        try {
          await enrichEmails(userId, newMessageIdsForAI);
        } catch (err) {
          console.error(`Background Phase 2 AI enrichment error for user ${userId}:`, err);
        }
      });
    }

    return NextResponse.json({
      success: syncResult.success,
      message: syncResult.success 
        ? 'Inbox synchronization completed.' 
        : `Inbox synchronization failed: ${syncResult.error}`,
    });
  } catch (error: any) {
    console.error('Error in GET /api/sync:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
