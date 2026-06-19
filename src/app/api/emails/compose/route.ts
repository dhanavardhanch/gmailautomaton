import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { generateDraft } from '@/lib/mistral';
import { getOAuthClient, refreshAccessToken, sendGmailEmail } from '@/lib/gmail';

export async function POST(request: Request) {
  try {
    const body = await request.json();
    const { action, userId, prompt, to, subject, body: emailBody, threadId } = body;

    if (!userId) {
      return NextResponse.json({ error: 'userId is required.' }, { status: 400 });
    }

    // --- Action A: Generate AI email draft from prompt ---
    if (action === 'draft') {
      if (!prompt) {
        return NextResponse.json({ error: 'prompt is required to generate a draft.' }, { status: 400 });
      }

      let contextStr = '';
      if (threadId) {
        // Fetch previous emails in the thread to provide full conversation context to Gemini
        const { data: previousEmails } = await supabaseAdmin
          .from('emails')
          .select('from_name, from_email, subject, body, received_at')
          .eq('thread_id', threadId)
          .eq('user_id', userId)
          .order('received_at', { ascending: true });

        if (previousEmails && previousEmails.length > 0) {
          contextStr = previousEmails
            .map((email: any, idx: number) => {
              const sender = email.from_name ? `${email.from_name} <${email.from_email}>` : email.from_email;
              return `[Email #${idx + 1}]
From: ${sender}
Date: ${new Date(email.received_at).toLocaleString()}
Subject: ${email.subject}
Content:
${email.body}`;
            })
            .join('\n\n---\n\n');
        }
      }

      const generatedText = await generateDraft(prompt, contextStr || undefined);
      return NextResponse.json({ draft: generatedText });
    }

    // --- Action B: Send complete email (New thread or Reply) ---
    if (action === 'send') {
      if (!to || !subject || !emailBody) {
        return NextResponse.json(
          { error: 'Recipient ("to"), "subject", and "body" are required to send an email.' },
          { status: 400 }
        );
      }

      // 1. Get credentials and refresh tokens if expired
      const { data: creds, error: credsError } = await supabaseAdmin
        .from('gmail_credentials')
        .select('*')
        .eq('id', userId)
        .single();

      if (credsError || !creds) {
        return NextResponse.json({ error: 'Gmail credentials not found.' }, { status: 404 });
      }

      const authClient = getOAuthClient();
      let accessToken = creds.access_token;

      const expiryTime = new Date(creds.token_expiry).getTime();
      if (Date.now() >= expiryTime - 5 * 60 * 1000) {
        const refreshed = await refreshAccessToken(creds.refresh_token);
        accessToken = refreshed.access_token;

        await supabaseAdmin
          .from('gmail_credentials')
          .update({
            access_token: accessToken,
            token_expiry: new Date(refreshed.expiry_date).toISOString(),
            updated_at: new Date().toISOString(),
          })
          .eq('id', userId);
      }

      authClient.setCredentials({ access_token: accessToken });

      // 2. Setup reply headers if replying inside a thread
      let messageId: string | undefined;
      let references: string | undefined;

      if (threadId) {
        // Find the latest message in the thread to get its Message-ID and cumulative References
        const { data: latestMsg } = await supabaseAdmin
          .from('emails')
          .select('raw_headers')
          .eq('thread_id', threadId)
          .eq('user_id', userId)
          .order('received_at', { ascending: false })
          .limit(1)
          .single();

        if (latestMsg && latestMsg.raw_headers) {
          const headersObj = latestMsg.raw_headers as Record<string, string>;
          // Parent message ID becomes our In-Reply-To header
          messageId = headersObj.messageId || undefined;
          
          // Combine original references + parent message ID to construct new References header
          const origRefs = headersObj.references || '';
          const parentMsgId = headersObj.messageId || '';
          
          references = [origRefs, parentMsgId].filter(Boolean).join(' ');
        }
      }

      // 3. Dispatch email
      const newGmailMsgId = await sendGmailEmail(authClient, {
        to,
        subject,
        body: emailBody,
        threadId: threadId || undefined,
        messageId,
        references,
      });

      return NextResponse.json({
        success: true,
        messageId: newGmailMsgId,
      });
    }

    return NextResponse.json({ error: `Invalid action: "${action}"` }, { status: 400 });
  } catch (error: any) {
    console.error('Error in POST /api/emails/compose:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
