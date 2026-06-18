import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { isGeminiQuotaExhausted } from '@/lib/gemini';

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');
    const category = searchParams.get('category'); // optional filter
    const threadId = searchParams.get('threadId'); // optional detail view

    if (!userId) {
      return NextResponse.json(
        { error: 'userId parameter is required in the query string.' },
        { status: 400 }
      );
    }

    // 1. Thread Detail View: Fetch all messages in a specific thread
    if (threadId) {
      const { data: thread, error: threadError } = await supabaseAdmin
        .from('email_threads')
        .select('*')
        .eq('id', threadId)
        .eq('user_id', userId)
        .single();

      if (threadError || !thread) {
        return NextResponse.json(
          { error: `Thread not found or access denied: ${threadError?.message}` },
          { status: 404 }
        );
      }

      const { data: emails, error: emailsError } = await supabaseAdmin
        .from('emails')
        .select('*')
        .eq('thread_id', threadId)
        .eq('user_id', userId)
        .order('received_at', { ascending: true });

      if (emailsError) {
        return NextResponse.json({ error: emailsError.message }, { status: 500 });
      }

      return NextResponse.json({ thread, emails });
    }

    // 2. Thread List View: List all threads for a user
    // We construct a query to retrieve distinct threads that have emails matching the category filter (if any)
    let query = supabaseAdmin
      .from('email_threads')
      .select(`
        id,
        subject,
        summary,
        last_message_at,
        created_at,
        emails!inner (
          category
        )
      `)
      .eq('user_id', userId);

    if (category && category !== 'All') {
      // Filter threads where at least one email belongs to this category
      query = query.eq('emails.category', category);
    }

    const { data: rawThreads, error: threadsError } = await query.order('last_message_at', { ascending: false });

    if (threadsError) {
      console.error('Database error listing threads:', threadsError);
      return NextResponse.json({ error: threadsError.message }, { status: 500 });
    }

    // Post-process threads to determine a representative category for each thread
    // (We take the category of the last synced email in the thread, or the most common one)
    const threads = await Promise.all(
      rawThreads.map(async (t: any) => {
        // Fetch the latest message's category in this thread to represent the thread
        const { data: latestMsg } = await supabaseAdmin
          .from('emails')
          .select('category, from_name, from_email')
          .eq('thread_id', t.id)
          .order('received_at', { ascending: false })
          .limit(1)
          .single();

        return {
          id: t.id,
          subject: t.subject,
          summary: t.summary,
          last_message_at: t.last_message_at,
          representative_category: latestMsg?.category || 'Uncategorized',
          latest_sender: latestMsg ? (latestMsg.from_name || latestMsg.from_email) : 'Unknown',
        };
      })
    );

    // 3. Fetch Category counts for the UI sidebar
    // We aggregate category counts directly from emails for this user
    const { data: categoryData } = await supabaseAdmin
      .from('emails')
      .select('category')
      .eq('user_id', userId);

    const counts: Record<string, number> = {
      All: 0,
      Personal: 0,
      'Work / Professional': 0,
      Finance: 0,
      Notifications: 0,
      'Job / Recruitment': 0,
      Newsletters: 0,
    };

    if (categoryData) {
      categoryData.forEach((item: any) => {
        const cat = item.category;
        counts['All'] = (counts['All'] || 0) + 1;
        if (cat in counts) {
          counts[cat] = (counts[cat] || 0) + 1;
        }
      });
    }

    // Add connection status check
    const { data: credentials } = await supabaseAdmin
      .from('gmail_credentials')
      .select('email, sync_status, last_synced_at, updated_at')
      .eq('id', userId)
      .single();

    let connection = null;
    if (credentials) {
      let syncStatus = credentials.sync_status;
      
      // Self-healing: Reset stuck sync status if it hasn't been updated in 3 minutes
      if (syncStatus === 'syncing' && credentials.updated_at) {
        const lastUpdate = new Date(credentials.updated_at).getTime();
        const threeMinutesAgo = Date.now() - 3 * 60 * 1000;
        if (lastUpdate < threeMinutesAgo) {
          console.log(`Detected stuck sync status for user ${userId} (last update: ${credentials.updated_at}). Resetting to failed.`);
          await supabaseAdmin
            .from('gmail_credentials')
            .update({ sync_status: 'failed', updated_at: new Date().toISOString() })
            .eq('id', userId);
          syncStatus = 'failed';
        }
      }

      connection = {
        email: credentials.email,
        syncStatus: syncStatus,
        lastSyncedAt: credentials.last_synced_at,
        geminiQuotaExhausted: isGeminiQuotaExhausted(),
      };
    }

    return NextResponse.json({
      threads,
      categoryCounts: counts,
      connection,
    });

  } catch (error: any) {
    console.error('Error in GET /api/threads:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
