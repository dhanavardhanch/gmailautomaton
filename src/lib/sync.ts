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
export async function syncUserInbox(userId: string, maxThreads = 30): Promise<{ success: boolean; count: number; error?: string }> {
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
    
    // Check if token is expired or close to expiry (within 5 minutes)
    const expiryTime = new Date(creds.token_expiry).getTime();
    if (Date.now() >= expiryTime - 5 * 60 * 1000) {
      console.log('Access token near expiry, refreshing token...');
      const refreshed = await refreshAccessToken(creds.refresh_token);
      accessToken = refreshed.access_token;
      
      // Update credentials with refreshed token
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
      // Set sync status to syncing
      await supabaseAdmin
        .from('gmail_credentials')
        .update({ sync_status: 'syncing', updated_at: new Date().toISOString() })
        .eq('id', userId);
    }

    authClient.setCredentials({ access_token: accessToken });

    // 3. Retrieve Gmail Threads list
    console.log(`Sync started: Fetching threads for user ${creds.email}...`);
    // Query parameters: Only sync INBOX emails for sync efficiency, and skip drafts/junk
    const qStr = 'label:INBOX';
    const threadsResponse = await listGmailThreads(authClient, { maxResults: maxThreads, q: qStr });
    
    const threadsList = threadsResponse.threads || [];
    console.log(`Retrieved ${threadsList.length} threads from Gmail.`);

    let syncedThreadsCount = 0;
    
    // 4. Process each thread in chunks of 1 at a time (sequential for rate-limiting safety)
    const BATCH_SIZE = 1;
    for (let i = 0; i < threadsList.length; i += BATCH_SIZE) {
      const batch = threadsList.slice(i, i + BATCH_SIZE);
      await Promise.all(batch.map(async (threadListItem) => {
        const threadId = threadListItem.id;
        if (!threadId) return;

        try {
          // Fetch the full thread with messages from Gmail
          const gmailThread = await getGmailThread(authClient, threadId);
          const gmailMessages = gmailThread.messages || [];
          if (gmailMessages.length === 0) return;

          // Check which messages we already have in our database
          const gmailMessageIds = gmailMessages.map((m) => m.id).filter(Boolean) as string[];
          const { data: existingEmails } = await supabaseAdmin
            .from('emails')
            .select('id')
            .in('id', gmailMessageIds);

          const existingMessageIds = new Set(existingEmails?.map((e: any) => e.id) || []);
          const newMessages = gmailMessages.filter((m) => m.id && !existingMessageIds.has(m.id));

          // Backfill: find existing emails that are missing html_body and patch them
          if (existingEmails && existingEmails.length > 0) {
            const { data: missingHtml } = await supabaseAdmin
              .from('emails')
              .select('id')
              .in('id', existingEmails.map((e: any) => e.id))
              .is('html_body', null);

            if (missingHtml && missingHtml.length > 0) {
              const missingHtmlIds = new Set(missingHtml.map((e: any) => e.id));
              // Update each message that has html_body missing
              await Promise.all(
                gmailMessages
                  .filter((m) => m.id && missingHtmlIds.has(m.id))
                  .map(async (m) => {
                    const htmlBody = parseMessageHtml(m.payload);
                    if (htmlBody) {
                      await supabaseAdmin
                        .from('emails')
                        .update({ html_body: htmlBody })
                        .eq('id', m.id!);
                    }
                  })
              );
            }
          }

          if (newMessages.length === 0) {
            // No new messages in this thread, skip message sync but check if thread metadata exists
            const { data: threadExists } = await supabaseAdmin
              .from('email_threads')
              .select('id')
              .eq('id', threadId)
              .single();
            
            if (threadExists) return;
          }

          // We have new messages to index!
          console.log(`Thread ${threadId}: Syncing ${newMessages.length} new messages.`);

          // Ensure the thread object itself exists in Supabase
          let { data: threadRow } = await supabaseAdmin
            .from('email_threads')
            .select('*')
            .eq('id', threadId)
            .single();

          if (!threadRow) {
            // Create a basic thread stub so that foreign key constraints on emails are met
            const threadSubject = getHeader(gmailMessages[0].payload?.headers || [], 'Subject') || 'No Subject';
            const threadLastMsgAt = new Date(
              getHeader(gmailMessages[gmailMessages.length - 1].payload?.headers || [], 'Date') || Date.now()
            ).toISOString();

            const { error: stubError } = await supabaseAdmin
              .from('email_threads')
              .insert({
                id: threadId,
                user_id: userId,
                subject: threadSubject,
                summary: 'Syncing summary...',
                last_message_at: threadLastMsgAt
              });

            if (stubError) {
              console.error(`Error inserting thread stub for ${threadId}:`, stubError);
            } else {
              // Fetch the row we just inserted so the code below behaves correctly
              const { data: newRow } = await supabaseAdmin
                .from('email_threads')
                .select('*')
                .eq('id', threadId)
                .single();
              threadRow = newRow;
            }
          }

          // Track all messages currently stored in Supabase for thread summary calculation
          const allThreadMessagesAccumulator: Array<{
            from: string;
            subject: string;
            body: string;
            date: string;
          }> = [];

          // Load existing emails in database for this thread (to calculate thread summary context)
          if (threadRow) {
            const { data: preExisting } = await supabaseAdmin
              .from('emails')
              .select('from_name, from_email, subject, body, received_at')
              .eq('thread_id', threadId)
              .order('received_at', { ascending: true });

            if (preExisting) {
              preExisting.forEach((pe: any) => {
                allThreadMessagesAccumulator.push({
                  from: pe.from_name ? `${pe.from_name} <${pe.from_email}>` : pe.from_email,
                  subject: pe.subject || '',
                  body: pe.body || '',
                  date: pe.received_at ? new Date(pe.received_at).toLocaleString() : '',
                });
              });
            }
          }

          // Process new messages
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
            
            // Extract body text and html
            const bodyText = parseMessageBody(msg.payload);
            const htmlBody = parseMessageHtml(msg.payload);
            
            // Generate Individual AI Summary and Categorization in parallel
            const [emailSummary, category] = await Promise.all([
              generateEmailSummary(subject, fromHeader, bodyText),
              categorizeEmail(subject, fromHeader, bodyText)
            ]);

            // Store reply headers needed to draft thread-compliant responses later
            const rawHeaders = {
              messageId: getHeader(headers, 'Message-ID'),
              references: getHeader(headers, 'References'),
              inReplyTo: getHeader(headers, 'In-Reply-To'),
            };

            // Save email record to database
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
              category: category,
              summary: emailSummary,
              raw_headers: rawHeaders,
            };

            let { error: insertEmailError } = await supabaseAdmin
              .from('emails')
              .insert(emailRecord);

            // Fallback retry if html_body column doesn't exist in user database schema
            if (insertEmailError && (insertEmailError.message?.includes('html_body') || insertEmailError.code === '42703')) {
              console.warn('html_body column seems missing. Retrying insert without html_body...');
              const { html_body, ...recordWithoutHtml } = emailRecord;
              const { error: retryError } = await supabaseAdmin
                .from('emails')
                .insert(recordWithoutHtml);
              insertEmailError = retryError;
            }

            if (insertEmailError) {
              console.error(`Error saving message ${messageId} to Supabase:`, insertEmailError);
              continue;
            }

            // Add to thread summary context
            allThreadMessagesAccumulator.push({
              from: fromHeader,
              subject,
              body: bodyText,
              date: new Date(receivedAt).toLocaleString(),
            });

            // 5. Generate and store RAG Vector Chunks & Embeddings in parallel (larger chunks = fewer API calls)
            const chunks = chunkText(bodyText, 2500, 300);
            await Promise.all(chunks.map(async (chunk) => {
              try {
                // Generate Gemini 768-dimension vector
                const embeddingVector = await generateEmbedding(chunk);

                await supabaseAdmin
                  .from('email_embeddings')
                  .insert({
                    email_id: messageId,
                    thread_id: threadId,
                    user_id: userId,
                    chunk_text: chunk,
                    embedding: embeddingVector,
                  });
              } catch (embedError) {
                console.error(`Error generating/saving embedding for message ${messageId} chunk:`, embedError);
              }
            }));
          }

          // 6. Generate/Update Thread Summary
          const threadSubject = getHeader(gmailMessages[0].payload?.headers || [], 'Subject') || 'No Subject';
          const threadLastMsgAt = new Date(
            getHeader(gmailMessages[gmailMessages.length - 1].payload?.headers || [], 'Date') || Date.now()
          ).toISOString();

          const newThreadSummary = await generateThreadSummary(allThreadMessagesAccumulator);

          const { error: upsertThreadError } = await supabaseAdmin
            .from('email_threads')
            .upsert({
              id: threadId,
              user_id: userId,
              subject: threadSubject,
              summary: newThreadSummary,
              last_message_at: threadLastMsgAt,
              updated_at: new Date().toISOString()
            });

          if (upsertThreadError) {
            console.error(`Error upserting thread ${threadId} summary:`, upsertThreadError);
          } else {
            syncedThreadsCount++;
          }
        } catch (threadError) {
          console.error(`Error processing thread ${threadId}:`, threadError);
        }
      }));

      // Heartbeat: update updated_at in database to keep sync status alive
      await supabaseAdmin
        .from('gmail_credentials')
        .update({ updated_at: new Date().toISOString() })
        .eq('id', userId)
        .catch((e: any) => console.error('Failed to heartbeat updated_at during sync:', e));
    }


    // 7. Update status to completed
    await supabaseAdmin
      .from('gmail_credentials')
      .update({
        sync_status: 'completed',
        last_synced_at: new Date().toISOString(),
        last_history_id: threadsList[0]?.historyId || creds.last_history_id,
        updated_at: new Date().toISOString()
      })
      .eq('id', userId);

    console.log(`Sync completed. Synced ${syncedThreadsCount} threads.`);
    return { success: true, count: syncedThreadsCount };

  } catch (error: any) {
    console.error('Error in syncUserInbox:', error);

    // Update status to failed
    await supabaseAdmin
      .from('gmail_credentials')
      .update({
        sync_status: 'failed',
        updated_at: new Date().toISOString()
      })
      .eq('id', userId)
      .catch((e: any) => console.error('Failed to update sync_status to failed:', e));

    return { success: false, count: 0, error: error.message || String(error) };
  }
}
