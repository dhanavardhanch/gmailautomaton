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
export async function syncUserInbox(userId: string, maxThreads = 10): Promise<{
  success: boolean;
  count: number;
  error?: string;
  newMessageIdsForAI?: Array<{
    messageId: string;
    threadId: string;
    subject: string;
    fromHeader: string;
    bodyText: string;
  }>;
}> {
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

    console.log(`Phase 1: Fetching thread details for ${threadsList.length} threads in parallel...`);
    const threadsData = await Promise.all(
      threadsList.map(async (threadListItem) => {
        const threadId = threadListItem.id;
        if (!threadId) return null;
        try {
          const gmailThread = await getGmailThread(authClient, threadId);
          return { threadId, gmailThread };
        } catch (err) {
          console.error(`Phase 1: Error getting thread ${threadId}:`, err);
          return null;
        }
      })
    );

    // Collect all message IDs to check existing emails in database in one single query
    const allMessageIds: string[] = [];
    for (const item of threadsData) {
      if (!item) continue;
      const messages = item.gmailThread.messages || [];
      for (const m of messages) {
        if (m.id) allMessageIds.push(m.id);
      }
    }

    let existingMessageIds = new Set<string>();
    if (allMessageIds.length > 0) {
      const { data: existingEmails, error: existingEmailsError } = await supabaseAdmin
        .from('emails')
        .select('id')
        .in('id', allMessageIds);
      if (existingEmailsError) {
        console.error('Phase 1: Error checking existing emails:', existingEmailsError);
      } else if (existingEmails) {
        existingMessageIds = new Set(existingEmails.map((e: any) => e.id));
      }
    }

    const threadsToUpsert: any[] = [];
    const emailsToInsert: any[] = [];

    for (const item of threadsData) {
      if (!item) continue;
      const { threadId, gmailThread } = item;
      const gmailMessages = gmailThread.messages || [];
      if (gmailMessages.length === 0) continue;

      const newMessages = gmailMessages.filter((m) => m.id && !existingMessageIds.has(m.id));
      
      const threadSubject = getHeader(gmailMessages[0].payload?.headers || [], 'Subject') || 'No Subject';
      const threadLastMsgAt = new Date(
        getHeader(gmailMessages[gmailMessages.length - 1].payload?.headers || [], 'Date') || Date.now()
      ).toISOString();

      // Collect all thread metadata
      threadsToUpsert.push({
        id: threadId,
        user_id: userId,
        subject: threadSubject,
        summary: 'Syncing summary...',
        last_message_at: threadLastMsgAt,
        updated_at: new Date().toISOString(),
      });

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

        emailsToInsert.push({
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
          category: 'Uncategorized',
          summary: 'Syncing summary...',
          raw_headers: rawHeaders,
        });

        newMessageIdsForAI.push({
          messageId,
          threadId,
          subject: subject || '',
          fromHeader,
          bodyText: bodyText || '',
        });
      }
    }

    // --- SYNCHRONOUS AI ENRICHMENT FOR FIRST 5 EMAILS AND THREADS ---
    const syncEnrichLimit = 5;
    let syncEnrichCount = 0;
    const enrichPromises: Promise<void>[] = [];

    for (const email of emailsToInsert) {
      if (syncEnrichCount < syncEnrichLimit) {
        syncEnrichCount++;
        const aiItem = newMessageIdsForAI.find(item => item.messageId === email.id);
        if (aiItem) {
          enrichPromises.push((async () => {
            try {
              const [emailSummary, category] = await Promise.all([
                generateEmailSummary(aiItem.subject, aiItem.fromHeader, aiItem.bodyText),
                categorizeEmail(aiItem.subject, aiItem.fromHeader, aiItem.bodyText),
              ]);
              email.summary = emailSummary;
              email.category = category;
            } catch (err) {
              console.error(`Phase 1: Sync AI enrichment failed for message ${email.id}:`, err);
            }
          })());
        }
      }
    }

    const threadEnrichPromises: Promise<void>[] = [];
    const first5ThreadIds = Array.from(new Set(emailsToInsert.slice(0, 5).map(e => e.thread_id)));
    for (const thread of threadsToUpsert) {
      if (first5ThreadIds.includes(thread.id)) {
        const item = threadsData.find(d => d && d.threadId === thread.id);
        if (item) {
          const messages = item.gmailThread.messages || [];
          threadEnrichPromises.push((async () => {
            try {
              const threadMsgs = messages.map((e: any) => {
                const headers = e.payload?.headers || [];
                const fromHeader = getHeader(headers, 'From');
                const subject = getHeader(headers, 'Subject');
                const dateStr = getHeader(headers, 'Date');
                const bodyText = parseMessageBody(e.payload);
                return {
                  from: fromHeader,
                  subject: subject || '',
                  body: bodyText || '',
                  date: dateStr ? new Date(dateStr).toLocaleString() : '',
                };
              });
              const threadSummary = await generateThreadSummary(threadMsgs);
              thread.summary = threadSummary;
            } catch (err) {
              console.error(`Phase 1: Sync AI thread summary failed for ${thread.id}:`, err);
            }
          })());
        }
      }
    }

    if (enrichPromises.length > 0 || threadEnrichPromises.length > 0) {
      console.log(`Phase 1: Synchronously generating AI summaries for ${enrichPromises.length} emails and ${threadEnrichPromises.length} threads...`);
      await Promise.all([...enrichPromises, ...threadEnrichPromises]);
    }

    // 1. Bulk Upsert Threads
    if (threadsToUpsert.length > 0) {
      console.log(`Phase 1: Bulk upserting ${threadsToUpsert.length} threads in database...`);
      const { error: upsertErr } = await supabaseAdmin
        .from('email_threads')
        .upsert(threadsToUpsert);
      if (upsertErr) {
        console.error('Phase 1: Bulk upsert threads failed, falling back to sequential:', upsertErr);
        for (const thread of threadsToUpsert) {
          try {
            await supabaseAdmin.from('email_threads').upsert(thread);
          } catch (err) {
            console.error(`Phase 1: Failed to upsert thread ${thread.id}:`, err);
          }
        }
      }
    }

    // 2. Bulk Insert Emails
    if (emailsToInsert.length > 0) {
      console.log(`Phase 1: Bulk inserting ${emailsToInsert.length} emails in database...`);
      let { error: insertErr } = await supabaseAdmin
        .from('emails')
        .insert(emailsToInsert);

      if (insertErr?.code === '42703') {
        const withoutHtml = emailsToInsert.map(({ html_body, ...rest }) => rest);
        const { error: retryErr } = await supabaseAdmin.from('emails').insert(withoutHtml);
        insertErr = retryErr;
      }

      if (insertErr) {
        console.error('Phase 1: Bulk insert emails failed, falling back to sequential:', insertErr);
        for (const email of emailsToInsert) {
          try {
            let { error: err } = await supabaseAdmin.from('emails').insert(email);
            if (err?.code === '42703') {
              const { html_body, ...withoutHtml } = email;
              await supabaseAdmin.from('emails').insert(withoutHtml);
            }
          } catch (err) {
            console.error(`Phase 1: Failed to insert email ${email.id}:`, err);
          }
        }
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

    return { success: true, count: newMessageIdsForAI.length, newMessageIdsForAI };

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

export async function enrichEmails(userId: string, newMessageIdsForAI: Array<{
  messageId: string;
  threadId: string;
  subject: string;
  fromHeader: string;
  bodyText: string;
}>): Promise<void> {
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
}
