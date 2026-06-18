import { google } from 'googleapis';
import { OAuth2Client } from 'google-auth-library';

import { getAppConfig } from './config';

/**
 * Creates and returns a Google OAuth2 Client configured with env credentials.
 */
export function getOAuthClient(redirectUri?: string): any {
  const config = getAppConfig();
  const clientId = config.googleClientId;
  const clientSecret = config.googleClientSecret;
  const resolvedRedirectUri = redirectUri || config.googleRedirectUri || 'http://localhost:3000/api/oauth/callback';

  if (!clientId || !clientSecret) {
    throw new Error('Google OAuth credentials (Client ID and Secret) are missing.');
  }

  return new google.auth.OAuth2(clientId, clientSecret, resolvedRedirectUri) as any;
}

/**
 * Generates the Google OAuth authorization URL.
 * Requests offline access and forces consent prompt to ensure we get a refresh token.
 */
export function getAuthUrl(userId: string, baseUrl?: string): string {
  const redirectUri = baseUrl ? `${baseUrl}/api/oauth/callback` : undefined;
  const client = getOAuthClient(redirectUri);
  return client.generateAuthUrl({
    access_type: 'offline',
    prompt: 'consent',
    scope: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
    state: userId, // Pass Supabase user ID as state to link account on callback
  });
}

/**
 * Exchanges OAuth authorization code for tokens.
 */
export async function getTokensFromCode(code: string, baseUrl?: string) {
  const redirectUri = baseUrl ? `${baseUrl}/api/oauth/callback` : undefined;
  const client = getOAuthClient(redirectUri);
  const { tokens } = await client.getToken(code);
  return tokens;
}

/**
 * Refreshes an expired access token using the refresh token.
 */
export async function refreshAccessToken(refreshToken: string): Promise<{
  access_token: string;
  expiry_date: number;
}> {
  const client = getOAuthClient();
  client.setCredentials({ refresh_token: refreshToken });
  const { credentials } = await client.refreshAccessToken();
  return {
    access_token: credentials.access_token || '',
    expiry_date: credentials.expiry_date || Date.now() + 3600 * 1000,
  };
}

/**
 * Helper to run Gmail API operations with Exponential Backoff for 429 / quota limit handling.
 */
export async function executeWithRetry<T>(
  operation: () => Promise<T>,
  retries = 5,
  delay = 1000
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const status = error.status || error.code || (error.response && error.response.status);
    if ((status === 429 || status === 503 || status === 500) && retries > 0) {
      console.warn(`Gmail API Rate Limit (Status ${status}). Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return executeWithRetry(operation, retries - 1, delay * 2);
    }
    throw error;
  }
}

/**
 * Recursively parses Gmail MIME parts to extract the plain text email body.
 */
export function parseMessageBody(payload: any): string {
  if (!payload) return '';

  // 1. Check if direct body has text/plain content
  if (payload.mimeType === 'text/plain' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // 2. Check if direct body has text/html content as fallback
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    const html = Buffer.from(payload.body.data, 'base64').toString('utf-8');
    // Strip style blocks, script blocks, and then HTML tags for clean text body representation
    const cleanHtml = html
      .replace(/<style\b[^>]*>([\s\S]*?)<\/style>/gi, ' ')
      .replace(/<script\b[^>]*>([\s\S]*?)<\/script>/gi, ' ');
    return cleanHtml.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
  }

  // 3. Recursively parse body parts
  if (payload.parts && Array.isArray(payload.parts)) {
    let body = '';
    // Look for text/plain first
    for (const part of payload.parts) {
      if (part.mimeType === 'text/plain') {
        body += parseMessageBody(part);
      }
    }
    // If no plain text was found, check HTML parts
    if (!body) {
      for (const part of payload.parts) {
        if (part.mimeType === 'text/html') {
          body += parseMessageBody(part);
        }
      }
    }
    // If still empty, scan any nested parts
    if (!body) {
      for (const part of payload.parts) {
        body += parseMessageBody(part);
      }
    }
    return body;
  }

  return '';
}

/**
 * Recursively parses Gmail MIME parts to extract the HTML email body.
 */
export function parseMessageHtml(payload: any): string {
  if (!payload) return '';

  // 1. Check if direct body has text/html content
  if (payload.mimeType === 'text/html' && payload.body?.data) {
    return Buffer.from(payload.body.data, 'base64').toString('utf-8');
  }

  // 2. Recursively parse body parts
  if (payload.parts && Array.isArray(payload.parts)) {
    let html = '';
    // Look for text/html first
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html') {
        html += parseMessageHtml(part);
      }
    }
    // If no text/html was found, scan any nested parts
    if (!html) {
      for (const part of payload.parts) {
        html += parseMessageHtml(part);
      }
    }
    return html;
  }

  return '';
}

/**
 * Helper to extract headers from Gmail message resource.
 */
export function getHeader(headers: any[], name: string): string {
  if (!headers) return '';
  const match = headers.find((h) => h.name?.toLowerCase() === name.toLowerCase());
  return match ? match.value || '' : '';
}

/**
 * Formats a clean sender name and email from "Name <email@domain.com>" or just "email@domain.com".
 */
export function parseSender(fromHeader: string): { name: string; email: string } {
  if (!fromHeader) return { name: '', email: '' };
  const match = fromHeader.match(/^(.*?)\s*<([^>]+)>/);
  if (match) {
    return {
      name: match[1].replace(/['"]/g, '').trim(),
      email: match[2].trim(),
    };
  }
  return {
    name: '',
    email: fromHeader.trim(),
  };
}

/**
 * Formats email address strings into array
 */
export function parseEmailList(headerValue: string): string[] {
  if (!headerValue) return [];
  return headerValue
    .split(',')
    .map((e) => {
      const parsed = parseSender(e);
      return parsed.email;
    })
    .filter(Boolean);
}

/**
 * Fetches thread metadata and its messages from the Gmail API.
 */
export async function getGmailThread(authClient: any, threadId: string) {
  const gmail = google.gmail({ version: 'v1', auth: authClient as any });

  return executeWithRetry(async () => {
    const response = await gmail.users.threads.get({
      userId: 'me',
      id: threadId,
      format: 'full',
    });
    return response.data;
  });
}

/**
 * Fetches page of thread IDs from the Gmail API.
 */
export async function listGmailThreads(
  authClient: any,
  options: { maxResults?: number; pageToken?: string; q?: string } = {}
) {
  const gmail = google.gmail({ version: 'v1', auth: authClient as any });

  return executeWithRetry(async () => {
    const response = await gmail.users.threads.list({
      userId: 'me',
      maxResults: options.maxResults || 20,
      pageToken: options.pageToken,
      q: options.q,
    });
    return response.data;
  });
}

interface SendEmailParams {
  to: string;
  subject: string;
  body: string;
  threadId?: string;
  messageId?: string; // Parent message ID for In-Reply-To header
  references?: string; // Cumulative parent message IDs for References header
}

/**
 * Sends a raw email (new message or thread-linked reply) using Gmail API.
 */
export async function sendGmailEmail(
  authClient: any,
  params: SendEmailParams
): Promise<string> {
  const gmail = google.gmail({ version: 'v1', auth: authClient as any });

  const emailLines: string[] = [];

  // 1. Build recipient and subject
  emailLines.push(`To: ${params.to}`);
  emailLines.push(`Subject: ${params.subject}`);

  // 2. Build Thread headers for email linking if replying
  if (params.threadId) {
    emailLines.push(`Thread-Topic: ${params.subject}`);
  }
  if (params.messageId) {
    // Note: messageId header should wrap in angle brackets if not already present
    const cleanMsgId = params.messageId.startsWith('<') && params.messageId.endsWith('>')
      ? params.messageId
      : `<${params.messageId}>`;
    emailLines.push(`In-Reply-To: ${cleanMsgId}`);

    // References header needs to append current parent messageId to existing references
    const cleanRefs = params.references
      ? params.references
          .split(/\s+/)
          .map((ref) => (ref.startsWith('<') && ref.endsWith('>') ? ref : `<${ref}>`))
          .join(' ')
      : '';
    const newRefs = cleanRefs ? `${cleanRefs} ${cleanMsgId}` : cleanMsgId;
    emailLines.push(`References: ${newRefs}`);
  }

  emailLines.push('MIME-Version: 1.0');
  emailLines.push('Content-Type: text/plain; charset=utf-8');
  emailLines.push('Content-Transfer-Encoding: 7bit');
  emailLines.push(''); // Blank line to separate headers from body
  emailLines.push(params.body);

  const rawEmail = emailLines.join('\r\n');
  const encodedEmail = Buffer.from(rawEmail)
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

  return executeWithRetry(async () => {
    const response = await gmail.users.messages.send({
      userId: 'me',
      requestBody: {
        raw: encodedEmail,
        threadId: params.threadId,
      },
    });
    return response.data.id || '';
  });
}
