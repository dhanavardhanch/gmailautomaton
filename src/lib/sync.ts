import { supabaseAdmin } from './supabase';
import { 
  getOAuthClient, 
  listGmailThreads, 
  getGmailThread, 
  parseMessageBody, 
  parseMessageHtml, 
  parseSender, 
  parseEmailList, 
  getHeader, 
  refreshAccessToken 
} from './gmail';
import { 
  generateEmailSummary, 
  generateThreadSummary, 
  generateEmbedding 
} from './gemini';
import { categorizeEmail } from './nvidia';

/**
 * Split text into overlapping chunks for vector embedding.
 */
export function chunkText(text: string, chunkSize = 1000, overlap = 200): string[] {
  if (!text) return [];
  const chunks: string[] = [];
  let i = 0;
  while (i < text.length) {
    chunks.push(text.slice(i, i + chunkSize));
    i += chunkSize - overlap;
  }
  return chunks;
}

/**
 * Primary synchronization worker. Connects to Gmail and syncs user inbox to Supabase.
 */
export async function syncUserInbox(userId: string, maxThreads = 10): Promise<{ success: boolean; count: number; error?: string }> {
  try {
    // 1. Retrieve user credentials
    const { data: creds, error: credsError } = await supabaseAdmin
      .from('gmail_credentials')
      .select('*')
      .eq('id', userId)
      .single();

    if (credsError || !creds) {
      throw new Error(`Gmail credentials not found for user ${userId}. Make sure to connect first.`);
    }

    // 2. Setup OAuth Client and Refresh token if necessary
    const authClient = getOAuthClient();
    let accessToken = creds.access_token;
    
    const expiryTime = new Date(creds.token_expiry).getTime();
    if (Date.now() >= expiryTime - 5 * 60 * 1000) {
      console.log('Access token near expiry, refreshing token...');
      const refreshed = await refreshAccessToken(creds.refresh_token);
      accessToken = refreshed.access_token;
      await supabaseAdmin
        .from('gmail_credentials')
        .update({
          access_token: accessToken,
          token_expiry: new Date(refreshed.expiry_date).toISOString(),
          sync_status: 'syncing',
          updated_at: new Date().toISOString()
        })
        .eq('id', userId);
    } else {
      await supabaseAdmin
        .from('gmail_credentials')
        .update({ sync_status: 'syncing', updated_at: new Date().toISOString() })
        .eq('id', userId);
    }

    authClient.setCredentials({ access_token: accessToken });

    // 3. Fetch thread list
    const qStr = `label:INBOX`;
    console.log(`Checking first page of up to ${maxThreads} threads...`);
    let threadsResponse = await listGmailThreads(authClient, { maxResults: maxThreads, q: qStr });
    let threadsList = threadsResponse.threads || [];
    let nextPageToken = threadsResponse.nextPageToken;

    // Check if any thread in the first page is new
    const firstPageThreadIds = threadsList.map(t => t.id).filter(Boolean) as string[];
    let hasNewEmailsInFirstPage = false;
    if (firstPageThreadIds.length > 0) {
      const { data: existingThreads } = await supabaseAdmin
        .from('email_threads')
        .select('id')
        .in('id', firstPageThreadIds);
      const existingThreadIds = new Set(existingThreads?.map((t: any) => t.id) || []);
      hasNewEmailsInFirstPage = firstPageThreadIds.some(id => !existingThreadIds.has(id));
    }

    // If no new emails are found on the first page, and we have a stored pageToken,
    // page back to get older threads
    if (!hasNewEmailsInFirstPage && creds.last_history_id) {
      console.log(`No new emails in first page. Paging back to older emails using token: ${creds.last_history_id}`);
      threadsResponse = await listGmailThreads(authClient, { 
        maxResults: maxThreads, 
        q: qStr,
        pageToken: creds.last_history_id
      });
      threadsList = threadsResponse.threads || [];
      nextPageToken = threadsResponse.nextPageToken;
      console.log(`Retrieved ${threadsList.length} older threads.`);
    } else {
      console.log(`Syncing newest threads. New threads found or no stored page token.`);
    }

    // ─── PHASE 1: Save raw emails immediately (no AI) so they appear in UI fast ───
    const newMessageIdsForAI: Array<{
      messageId: string;
      threadId: string;
      subject: string;
      fromHeader: string;
      bodyText: string;
    }> = [];

    for (const threadListItem of threadsList) {
      const threadId = threadListItem.id;
      if (!threadId) continue;

      try {
        const gmailThread = await getGmailThread(authClient, threadId);
        const gmailMessages = gmailThread.messages || [];
        if (gmailMessages.length === 0) continue;

        // Find new messages not already in DB
        const gmailMessageIds = gmailMessages.map((m) => m.id).filter(Boolean) as string[];
        const { data: existingEmails } = await supabaseAdmin
          .from('emails')
          .select('id')
          .in('id', gmailMessageIds);
        const existingMessageIds = new Set(existingEmails?.map((e: any) => e.id) || []);
        const newMessages = gmailMessages.filter((m) => m.id && !existingMessageIds.has(m.id));

        if (newMessages.length === 0) continue;

        // Ensure thread row exists
        const { data: threadExists } = await supabaseAdmin
          .from('email_threads')
          .select('id')
          .eq('id', threadId)
          .single();

        if (!threadExists) {
          const threadSubject = getHeader(gmailMessages[0].payload?.headers || [], 'Subject') || 'No Subject';
          const threadLastMsgAt = new Date(
            getHeader(gmailMessages[gmailMessages.length - 1].payload?.headers || [], 'Date') || Date.now()
          ).toISOString();

          await supabaseAdmin.from('email_threads').insert({
            id: threadId,
            user_id: userId,
            subject: threadSubject,
            summary: 'Syncing summary...',
            last_message_at: threadLastMsgAt,
          });
        }

        // Save each new message immediately with placeholder AI fields
        for (const msg of newMessages) {
          const messageId = msg.id!;
          const headers = msg.payload?.headers || [];
          const fromHeader = getHeader(headers, 'From');
          const { name: fromName, email: fromEmail } = parseSender(fromHeader);
          const subject = getHeader(headers, 'Subject');
          const dateStr = getHeader(headers, 'Date');
          const receivedAt = dateStr ? new Date(dateStr).toISOString() : new Date().toISOString();
          const toEmails = parseEmailList(getHeader(headers, 'To'));
          const ccEmails = parseEmailList(getHeader(headers, 'Cc'));
          const bccEmails = parseEmailList(getHeader(headers, 'Bcc'));
          const bodyText = parseMessageBody(msg.payload);
          const htmlBody = parseMessageHtml(msg.payload);
          const rawHeaders = {
            messageId: getHeader(headers, 'Message-ID'),
            references: getHeader(headers, 'References'),
            inReplyTo: getHeader(headers, 'In-Reply-To'),
          };

          const emailRecord = {
            id: messageId,
            thread_id: threadId,
            user_id: userId,
            subject,
            from_name: fromName,
            from_email: fromEmail,
            to_emails: toEmails,
            cc_emails: ccEmails,
            bcc_emails: bccEmails,
            body: bodyText,
            html_body: htmlBody,
            received_at: receivedAt,
            category: 'Uncategorized',        // placeholder — updated in Phase 2
            summary: 'Syncing summary...',     // placeholder — updated in Phase 2
            raw_headers: rawHeaders,
          };

          let { error: insertErr } = await supabaseAdmin.from('emails').insert(emailRecord);
          if (insertErr?.code === '42703') {
            const { html_body, ...withoutHtml } = emailRecord;
            const { error: retryErr } = await supabaseAdmin.from('emails').insert(withoutHtml);
            insertErr = retryErr;
          }
          if (insertErr) {
            console.error(`Phase 1: Error inserting message ${messageId}:`, insertErr);
            continue;
          }

          // Queue for AI enrichment in Phase 2
          newMessageIdsForAI.push({ messageId, threadId, subject: subject || '', fromHeader, bodyText: bodyText || '' });
        }

        // Update thread metadata (quick, no AI)
        const threadSubject = getHeader(gmailMessages[0].payload?.headers || [], 'Subject') || 'No Subject';
        const threadLastMsgAt = new Date(
          getHeader(gmailMessages[gmailMessages.length - 1].payload?.headers || [], 'Date') || Date.now()
        ).toISOString();
        await supabaseAdmin.from('email_threads').upsert({
          id: threadId,
          user_id: userId,
          subject: threadSubject,
          summary: 'Syncing summary...',
          last_message_at: threadLastMsgAt,
          updated_at: new Date().toISOString(),
        });

      } catch (threadError) {
        console.error(`Phase 1: Error processing thread ${threadId}:`, threadError);
      }
    }

    console.log(`Phase 1 complete: ${newMessageIdsForAI.length} emails saved. Updating sync_status to completed.`);
    
    // Mark sync complete for UI immediately after Phase 1 raw email fetch
    await supabaseAdmin
      .from('gmail_credentials')
      .update({
        sync_status: 'completed',
        last_synced_at: new Date().toISOString(),
        last_history_id: nextPageToken || null,
        updated_at: new Date().toISOString(),
      })
      .eq('id', userId);

    // ─── PHASE 2: AI enrichment — summaries, categories, embeddings (non-blocking) ───
    // Run asynchronously to return success to the caller immediately
    (async () => {
      try {
        console.log(`Starting background Phase 2 AI enrichment for user ${userId}...`);
        
        // Group messages by thread for thread summary generation
        const threadMessageMap: Record<string, typeof newMessageIdsForAI> = {};
        for (const item of newMessageIdsForAI) {
          if (!threadMessageMap[item.threadId]) threadMessageMap[item.threadId] = [];
          threadMessageMap[item.threadId].push(item);
        }

        for (const item of newMessageIdsForAI) {
          try {
            // Run AI summary + categorization in parallel
            const [emailSummary, category] = await Promise.all([
              generateEmailSummary(item.subject, item.fromHeader, item.bodyText),
              categorizeEmail(item.subject, item.fromHeader, item.bodyText),
            ]);

            // Update email record with AI results
            await supabaseAdmin
              .from('emails')
              .update({ summary: emailSummary, category })
              .eq('id', item.messageId);

            // Generate + store vector embeddings
            const chunks = chunkText(item.bodyText, 2500, 300);
            await Promise.all(chunks.map(async (chunk) => {
              try {
                const embeddingVector = await generateEmbedding(chunk);
                await supabaseAdmin.from('email_embeddings').insert({
                  email_id: item.messageId,
                  thread_id: item.threadId,
                  user_id: userId,
                  chunk_text: chunk,
                  embedding: embeddingVector,
                });
              } catch (embedErr) {
                console.error(`Phase 2: Embedding error for ${item.messageId}:`, embedErr);
              }
            }));
          } catch (aiErr) {
            console.error(`Phase 2: AI enrichment error for ${item.messageId}:`, aiErr);
          }
        }

        // Generate thread-level summaries
        for (const [threadId, messages] of Object.entries(threadMessageMap)) {
          try {
            const { data: allEmails } = await supabaseAdmin
              .from('emails')
              .select('from_name, from_email, subject, body, received_at')
              .eq('thread_id', threadId)
              .order('received_at', { ascending: true });

            const threadMsgs = (allEmails || []).map((e: any) => ({
              from: e.from_name ? `${e.from_name} <${e.from_email}>` : e.from_email,
              subject: e.subject || '',
              body: e.body || '',
              date: e.received_at ? new Date(e.received_at).toLocaleString() : '',
            }));

            const threadSummary = await generateThreadSummary(threadMsgs);
            await supabaseAdmin
              .from('email_threads')
              .update({ summary: threadSummary, updated_at: new Date().toISOString() })
              .eq('id', threadId);
          } catch (tsErr) {
            console.error(`Phase 2: Thread summary error for ${threadId}:`, tsErr);
          }
        }
        console.log(`Background Phase 2 AI enrichment complete for user ${userId}.`);
      } catch (backgroundError) {
        console.error('Background AI enrichment crashed:', backgroundError);
      }
    })();

    return { success: true, count: newMessageIdsForAI.length };

  } catch (error: any) {
    console.error('Error in syncUserInbox:', error);
    try {
      await supabaseAdmin
        .from('gmail_credentials')
        .update({ sync_status: 'failed', updated_at: new Date().toISOString() })
        .eq('id', userId);
    } catch (e: any) {
      console.error('Failed to update sync_status to failed:', e);
    }
    return { success: false, count: 0, error: error.message || String(error) };
  }
}
