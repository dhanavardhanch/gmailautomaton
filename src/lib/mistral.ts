import OpenAI from 'openai';
import { getAppConfig } from './config';

// Helper to initialize the NVIDIA client
const getNvidiaClient = () => {
  const config = getAppConfig();
  const apiKey = config.nvidiaNimApiKey;
  if (!apiKey) {
    throw new Error('NVIDIA_NIM_API_KEY is not defined in environment variables or configurations.');
  }
  return new OpenAI({
    apiKey,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });
};

// Helper to get the configured Mistral model name
const getModelName = () => {
  const config = getAppConfig();
  return config.nvidiaNimModel || 'mistralai/mistral-medium-3.5-128b';
};

class ConcurrencyLimiter {
  private activeCount = 0;
  private queue: (() => void)[] = [];
  private lastRequestTime = 0;
  
  constructor(private maxConcurrency: number, private minIntervalMs = 1000) {}
  
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

// Concurrency limiter for background requests on NVIDIA NIM API
// Paced to 1 concurrent request and 2-second delay to safely avoid 60 RPM developer limits
const nimLimiter = new ConcurrencyLimiter(1, 2000);

/**
 * Retry wrapper with backoff for NVIDIA NIM API calls.
 */
export async function nimRetry<T>(
  operation: () => Promise<T>,
  retries = 5,
  delay = 2000,
  isBackground = false
): Promise<T> {
  const runOp = async () => {
    let currentDelay = delay;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await operation();
      } catch (error: any) {
        console.error(`NVIDIA NIM Attempt ${attempt + 1} failed:`, error);
        const status = error.status || error.code || (error.response && error.response.status);
        
        const isRetryable =
          status === 429 ||
          status === 503 ||
          status === 502 ||
          status === 504 ||
          String(error).includes('429') ||
          String(error).includes('503') ||
          String(error).toLowerCase().includes('rate limit') ||
          String(error).toLowerCase().includes('unavailable') ||
          String(error).toLowerCase().includes('timeout');

        if (isRetryable && attempt < retries) {
          console.warn(`NVIDIA NIM Transient Error (Status ${status}). Retrying in ${currentDelay}ms...`);
          await new Promise((resolve) => setTimeout(resolve, currentDelay));
          currentDelay = Math.min(currentDelay * 1.5, 30000);
        } else {
          throw error;
        }
      }
    }
    throw new Error('NVIDIA NIM Retries Exhausted');
  };

  if (isBackground) {
    return nimLimiter.run(runOp);
  } else {
    return runOp();
  }
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
 * L2 Normalization helper for truncated vectors.
 */
function l2Normalize(vector: number[]): number[] {
  const sqSum = vector.reduce((sum, val) => sum + val * val, 0);
  const magnitude = Math.sqrt(sqSum);
  if (magnitude === 0) return vector;
  return vector.map(val => val / magnitude);
}

/**
 * Generate a 1-2 sentence concise summary of an individual email.
 */
export async function generateEmailSummary(
  subject: string,
  from: string,
  body: string,
  isBackground = false
): Promise<string> {
  try {
    const client = getNvidiaClient();
    const model = getModelName();
    const cleanedBody = cleanText(body, 2500);

    const systemPrompt = `You are an expert email assistant. Summarize the following email in 1 or 2 concise sentences. Focus on the main topic, the sender's intent, and any key call-to-actions or questions.`;
    const userContent = `Subject: ${subject}\nFrom: ${from}\nContent: ${cleanedBody}\n\nConcise Summary:`;

    const response = await nimRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.3,
        max_tokens: 150,
      }),
      5,
      2000,
      isBackground
    );

    return response.choices[0]?.message?.content?.trim() || 'No summary generated.';
  } catch (error: any) {
    console.error('Error in generateEmailSummary:', error);
    return 'Summary generation failed due to an error.';
  }
}

/**
 * Generate a concise summary of the conversation arc in an entire email thread.
 */
export async function generateThreadSummary(
  messages: Array<{ from: string; subject: string; body: string; date: string }>,
  isBackground = false
): Promise<string> {
  try {
    const client = getNvidiaClient();
    const model = getModelName();
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

    const systemPrompt = `You are an expert email assistant. Analyze the following email thread and generate a concise summary (under 4-5 sentences) of the overall conversation arc. Detail what was discussed, what agreements or decisions were reached, and what follow-up actions are pending.`;
    const userContent = `Thread Messages (in chronological order):\n${formattedMessages}\n\nConcise Thread Summary:`;

    const response = await nimRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.3,
        max_tokens: 350,
      }),
      5,
      2000,
      isBackground
    );

    return response.choices[0]?.message?.content?.trim() || 'No thread summary generated.';
  } catch (error: any) {
    console.error('Error in generateThreadSummary:', error);
    return 'Thread summary generation failed.';
  }
}

/**
 * Generate a 768-dimensional text embedding using E5-v5 from NVIDIA NIM.
 * Truncates 1024-dimensional outputs to 768 dimensions and L2-normalizes the result.
 */
export async function generateEmbedding(
  text: string,
  inputType: 'query' | 'passage' = 'passage',
  isBackground = false
): Promise<number[]> {
  const runEmbeddingCall = async (inputText: string) => {
    const client = getNvidiaClient();
    const cleaned = cleanText(inputText, 800);
    if (!cleaned) {
      return new Array(768).fill(0);
    }

    const response = await nimRetry(() =>
      client.embeddings.create({
        model: 'nvidia/nv-embedqa-e5-v5',
        input: cleaned,
        encoding_format: 'float',
        input_type: inputType
      } as any), // cast to avoid ts limits with extra properties in openAI client definition
      5,
      2000,
      isBackground
    );

    if (response?.data?.[0]?.embedding) {
      const fullVector = response.data[0].embedding;
      if (fullVector.length >= 768) {
        // Truncate to 768 dimensions and L2 normalize
        return l2Normalize(fullVector.slice(0, 768));
      }
      // If smaller, pad with zeros and normalize
      const paddedVector = [...fullVector, ...new Array(768 - fullVector.length).fill(0)];
      return l2Normalize(paddedVector);
    }
    throw new Error('Invalid embedding response format');
  };

  try {
    return await runEmbeddingCall(text);
  } catch (error: any) {
    const errMsg = String(error.message || error).toLowerCase();
    const isTokenLimitError =
      errMsg.includes('exceeds maximum') ||
      errMsg.includes('token size') ||
      errMsg.includes('too long') ||
      error.status === 400;

    if (isTokenLimitError) {
      console.warn('Embedding input exceeded token limits. Retrying with half-sized text...');
      try {
        const shorterText = text.slice(0, Math.floor(text.length / 2));
        return await runEmbeddingCall(shorterText);
      } catch (retryError) {
        console.error('Retry embedding failed:', retryError);
        return new Array(768).fill(0);
      }
    }

    console.error('Error in generateEmbedding:', error);
    return new Array(768).fill(0);
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
    const client = getNvidiaClient();
    const model = getModelName();

    const systemPrompt = `You are a professional email composer. Write a complete, polished, and professional email based on the user's prompt. 
${context ? `Use the provided context (previous email threads) to tailor the email appropriately, preserving context and alignment.` : ''}
Do NOT include the subject line or placeholders like "[Insert Date]". Just output the complete body of the email. Keep it professional, clear, and direct.`;

    const userContent = context
      ? `Context (Previous emails):
${context}

User Prompt for response: "${userPrompt}"
Complete Draft:`
      : `User Prompt for new email: "${userPrompt}"
Complete Draft:`;

    const response = await nimRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userContent }
        ],
        temperature: 0.5,
      })
    );

    return response.choices[0]?.message?.content?.trim() || '';
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
    const client = getNvidiaClient();
    const model = getModelName();

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

    const messages = [
      { role: 'system', content: systemInstruction },
      ...chatHistory.map((h) => ({
        role: h.role === 'model' ? 'assistant' as const : 'user' as const,
        content: h.text,
      })),
      { role: 'user' as const, content: query },
    ];

    const response = await nimRetry(() =>
      client.chat.completions.create({
        model,
        messages: messages as any,
        temperature: 0.3,
      })
    );

    return response.choices[0]?.message?.content || 'No response generated.';
  } catch (error: any) {
    console.error('Error in chatAgentResponse:', error);
    return 'Failed to generate a chat response due to an internal error.';
  }
}
