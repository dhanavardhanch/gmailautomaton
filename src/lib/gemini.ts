import { GoogleGenAI } from '@google/genai';
import { getAppConfig, updateGeminiQuotaStatus } from './config';

// Initialize the Gemini client
const getGeminiClient = () => {
  const config = getAppConfig();
  const apiKey = config.geminiApiKey;
  if (!apiKey) {
    throw new Error('GEMINI_API_KEY is not defined in environment variables.');
  }
  return new GoogleGenAI({ apiKey });
};

class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: (() => void)[] = [];
  private lastRequestTime = 0;
  
  constructor(private maxConcurrency: number, private minIntervalMs = 4200) {}
  
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.activeCount >= this.maxConcurrency) {
      await new Promise<void>((resolve) => this.queue.push(resolve));
    }
    
    const now = Date.now();
    const timeSinceLast = now - this.lastRequestTime;
    if (timeSinceLast < this.minIntervalMs) {
      const waitTime = this.minIntervalMs - timeSinceLast;
      await new Promise<void>((resolve) => setTimeout(resolve, waitTime));
    }
    this.lastRequestTime = Date.now();
    
    this.activeCount++;
    try {
      return await fn();
    } finally {
      this.activeCount--;
      const next = this.queue.shift();
      if (next) next();
    }
  }
}

export function isGeminiQuotaExhausted(): boolean {
  const config = getAppConfig();
  return !!(config.geminiQuotaExhausted && config.geminiApiKey === config.geminiQuotaExhaustedKey);
}

function checkQuotaStatus() {
  if (isGeminiQuotaExhausted()) {
    throw new Error('GEMINI_QUOTA_EXHAUSTED');
  }
}

// Limit active Gemini requests to a maximum of 2 concurrently and pace them to prevent 429s
const geminiLimiter = new ConcurrencyLimiter(2, 4200);

/**
 * Internal retry helper that runs inside the concurrency limiter slot.
 * Does NOT re-queue into the limiter — it retries in-place.
 */
async function _retryWithBackoff<T>(
  operation: () => Promise<T>,
  retries: number,
  delay: number
): Promise<T> {
  try {
    return await operation();
  } catch (error: any) {
    const status = error.status || error.code || (error.response && error.response.status);
    const errStr = (String(error) + ' ' + (error.message || '')).toLowerCase();
    
    // Check for daily quota exhaustion or billing limit errors (non-retryable)
    const isDailyQuotaExceeded =
      errStr.includes('exceeded your current quota') ||
      errStr.includes('quota exceeded') ||
      errStr.includes('perday') ||
      errStr.includes('free_tier_requests') ||
      errStr.includes('billing details');

    if (isDailyQuotaExceeded) {
      console.error('Gemini API Daily Quota Exceeded (non-retryable). Disabling Gemini calls for this key.');
      updateGeminiQuotaStatus(true, getAppConfig().geminiApiKey);
      throw new Error('GEMINI_QUOTA_EXHAUSTED');
    }


    const isRetryable =
      status === 429 ||
      status === 503 ||
      errStr.includes('429') ||
      errStr.includes('503') ||
      errStr.includes('unavailable') ||
      errStr.includes('high demand') ||
      errStr.includes('resource_exhausted');

    if (isRetryable && retries > 0) {
      console.warn(`Gemini API Transient Error (Status ${status}). Retrying in ${delay}ms... (${retries} retries left)`);
      await new Promise((resolve) => setTimeout(resolve, delay));
      return _retryWithBackoff(operation, retries - 1, Math.min(delay * 1.5, 60000));
    }
    throw error;
  }
}

/**
 * Helper to run Gemini API operations with Exponential Backoff for 429/503 rate limit handling.
 * Operations are queued through the ConcurrencyLimiter to cap simultaneous Gemini calls.
 */
export async function geminiRetry<T>(
  operation: () => Promise<T>,
  retries = 3,
  delay = 3000
): Promise<T> {
  checkQuotaStatus();
  return geminiLimiter.run(() => _retryWithBackoff(operation, retries, delay));
}


/**
 * Clean email body text for AI consumption (limits size and strips excessive whitespace)
 */
export function cleanText(text: string, maxLength = 3000): string {
  if (!text) return '';
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength);
}

/**
 * Generate a 1-2 sentence concise summary of an individual email.
 */
export async function generateEmailSummary(
  subject: string,
  from: string,
  body: string
): Promise<string> {
  try {
    const ai = getGeminiClient();
    const cleanedBody = cleanText(body, 2500);

    const prompt = `You are an expert email assistant. Summarize the following email in 1 or 2 concise sentences. Focus on the main topic, the sender's intent, and any key call-to-actions or questions.

Subject: ${subject}
From: ${from}
Content: ${cleanedBody}

Concise Summary:`;

    const response = await geminiRetry(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      })
    );

    return response.text?.trim() || 'No summary generated.';
  } catch (error: any) {
    console.error('Error in generateEmailSummary:', error);
    return 'Summary generation failed due to an error.';
  }
}

/**
 * Generate a concise summary of the conversation arc in an entire email thread.
 */
export async function generateThreadSummary(
  messages: Array<{ from: string; subject: string; body: string; date: string }>
): Promise<string> {
  try {
    const ai = getGeminiClient();
    if (messages.length === 0) return 'Empty thread.';

    const formattedMessages = messages
      .map((msg, index) => {
        return `[Message #${index + 1}]
Date: ${msg.date}
From: ${msg.from}
Subject: ${msg.subject}
Content: ${cleanText(msg.body, 1200)}`;
      })
      .join('\n\n');

    const prompt = `You are an expert email assistant. Analyze the following email thread and generate a concise summary (under 4-5 sentences) of the overall conversation arc. Detail what was discussed, what agreements or decisions were reached, and what follow-up actions are pending.

Thread Messages (in chronological order):
${formattedMessages}

Concise Thread Summary:`;

    const response = await geminiRetry(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: prompt,
      })
    );

    return response.text?.trim() || 'No thread summary generated.';
  } catch (error: any) {
    console.error('Error in generateThreadSummary:', error);
    return 'Thread summary generation failed.';
  }
}

/**
 * Generate a 768-dimensional text embedding using Gemini text-embedding-004.
 */
export async function generateEmbedding(text: string): Promise<number[]> {
  try {
    const ai = getGeminiClient();
    const cleaned = cleanText(text, 1000);
    if (!cleaned) {
      return new Array(768).fill(0);
    }

    const response = await geminiRetry(() =>
      ai.models.embedContent({
        model: 'gemini-embedding-2',
        contents: cleaned,
        config: {
          outputDimensionality: 768,
        },
      }),
      3, // Only retry 3 times for embeddings to fail fast on rate limits
      3000 // Start retry delay at 3s
    );

    const res = response as any;
    if (res?.embedding?.values) {
      return res.embedding.values;
    }
    
    // In some SDK responses, it might be an array of embeddings
    if (Array.isArray(res?.embeddings) && res.embeddings[0]?.values) {
      return res.embeddings[0].values;
    }
    
    throw new Error('Invalid embedding response format');
  } catch (error: any) {
    console.error('Error in generateEmbedding:', error);
    throw error;
  }
}

/**
 * Generates an email draft (new or reply) based on a prompt and context.
 */
export async function generateDraft(
  userPrompt: string,
  context?: string
): Promise<string> {
  try {
    const ai = getGeminiClient();

    const systemPrompt = `You are a professional email composer. Write a complete, polished, and professional email based on the user's prompt. 
${context ? `Use the provided context (previous email threads) to tailor the email appropriately, preserving context and alignment.` : ''}
Do NOT include the subject line or placeholders like "[Insert Date]". Just output the complete body of the email. Keep it professional, clear, and direct.`;

    const contents = context
      ? `Context (Previous emails):
${context}

User Prompt for response: "${userPrompt}"
Complete Draft:`
      : `User Prompt for new email: "${userPrompt}"
Complete Draft:`;

    const response = await geminiRetry(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          { role: 'user', parts: [{ text: systemPrompt + '\n\n' + contents }] }
        ],
      })
    );

    return response.text?.trim() || '';
  } catch (error: any) {
    console.error('Error in generateDraft:', error);
    throw error;
  }
}

/**
 * Chat agent response generator utilizing retrieved email context.
 */
export async function chatAgentResponse(
  query: string,
  context: Array<{
    emailId: string;
    threadId: string;
    subject: string;
    fromName: string;
    fromEmail: string;
    receivedAt: string;
    chunkText: string;
  }>,
  chatHistory: Array<{ role: 'user' | 'model'; text: string }>
): Promise<string> {
  try {
    const ai = getGeminiClient();

    // Format retrieved contexts as a clean string for the LLM
    const contextStr = context.length > 0
      ? context
          .map((item, idx) => {
            return `[Document #${idx + 1}]
Thread ID: ${item.threadId}
Message ID: ${item.emailId}
From: ${item.fromName || ''} <${item.fromEmail}>
Subject: ${item.subject}
Date: ${item.receivedAt}
Snippet: ${item.chunkText}`;
          })
          .join('\n\n')
      : 'No matching emails found in context database.';

    const systemInstruction = `You are an expert AI Gmail assistant. You help the user manage, summarize, and retrieve information from their emails.
You have access to a semantic search engine that retrieves relevant snippets of the user's emails.

Strict Rules:
1. Ground your answers ONLY in the provided Document context.
2. If the user's query asks about emails and the information is not present in the provided Document context, state clearly that you cannot find any information about that in their emails. Do NOT make up details or assume facts not in the context.
3. Maintain SOURCE CLARITY. For every fact, assertion, or summary, you MUST attribute it to its source document.
   - Use a specific Markdown citation format: "[Source: Subject by Sender on Date](thread:threadId)".
   - For example: "...as discussed in the launch plans [Source: Q3 Launch Delay by Product Team on 2026-06-15](thread:18f3a3f01c2)".
   - Replace "threadId" with the actual Thread ID provided in the document metadata (e.g. "thread:18f3a3f01c2"). This allows the user to open the thread.
4. When performing cross-email reasoning (synthesizing information from different senders or threads), write a unified explanation and cite each source separately.
5. If the user asks a general question not related to their emails (e.g. "What is the capital of France?"), you may answer it normally without citations, but warn them that this is general knowledge and not from their emails.

Here is the retrieved context:
${contextStr}`;

    const formattedHistory = chatHistory.map(h => ({
      role: h.role,
      parts: [{ text: h.text }]
    }));

    const response = await geminiRetry(() =>
      ai.models.generateContent({
        model: 'gemini-2.5-flash',
        contents: [
          ...formattedHistory,
          { role: 'user', parts: [{ text: query }] }
        ],
        config: {
          systemInstruction: systemInstruction
        }
      })
    );

    return response.text || 'No response generated.';
  } catch (error: any) {
    console.error('Error in chatAgentResponse:', error);
    return 'Failed to generate a chat response due to an internal error.';
  }
}
