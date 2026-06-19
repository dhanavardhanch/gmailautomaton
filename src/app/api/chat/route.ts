import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { generateEmbedding, chatAgentResponse, nimRetry } from '@/lib/mistral';
import { getAppConfig } from '@/lib/config';

// Initialize a local Gemini client just for filter parsing
import OpenAI from 'openai';

const getNvidiaClient = () => {
  const config = getAppConfig();
  const apiKey = config.nvidiaNimApiKey;
  if (!apiKey) throw new Error('NVIDIA_NIM_API_KEY is not defined.');
  return new OpenAI({
    apiKey,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });
};

const getModelName = () => {
  const config = getAppConfig();
  return config.nvidiaNimModel || 'mistralai/mistral-medium-3.5-128b';
};

interface SearchFilters {
  semanticQuery: string | null;
  sender: string | null;
  category: string | null;
  startDate: string | null;
  endDate: string | null;
}

/**
 * Uses Mistral to parse user query and extract database filters.
 */
async function extractSearchFilters(
  message: string,
  history: Array<{ role: 'user' | 'model'; text: string }>
): Promise<SearchFilters> {
  try {
    const client = getNvidiaClient();
    const model = getModelName();
    const today = new Date('2026-06-17T23:50:00.000Z'); // Hardcode baseline date match user metadata

    const systemPrompt = `You are a search query parser for an email database.
Analyze the user's latest query and the conversation history, and extract search filters for a database.
Note: Today's date is Wednesday, June 17, 2026. Resolve relative dates like "this month" (June 2026), "past 4 days" (June 13 to June 17, 2026), or "yesterday" relative to today.

Output ONLY a valid JSON object. Do not include markdown code formatting (like \`\`\`json) or any explanation.
The JSON object must have these exact fields, set to null if not mentioned or cannot be inferred:
- "semanticQuery": (string) Semantic topic keyword to search (e.g. "Kubernetes", "launch delay").
- "sender": (string) Sender name or email domain (e.g. "Acme Corp", "HR", "github.com").
- "category": (string) Exactly one of: "Newsletters", "Job / Recruitment", "Finance", "Notifications", "Personal", "Work / Professional".
- "startDate": (string) ISO-8601 date string for start date filter.
- "endDate": (string) ISO-8601 date string for end date filter.`;

    const chatContext = history
      .slice(-4)
      .map((h) => `${h.role === 'user' ? 'User' : 'Assistant'}: ${h.text}`)
      .join('\n');

    const prompt = `Conversation History:
${chatContext}

Latest User Query: "${message}"
JSON Response:`;

    const response = await nimRetry(() =>
      client.chat.completions.create({
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: prompt }
        ],
        temperature: 0.1,
      })
    );

    const rawJson = response.choices[0]?.message?.content?.trim() || '{}';
    const cleanedJson = rawJson
      .replace(/^```json/i, '')
      .replace(/^```/m, '')
      .replace(/```$/m, '')
      .trim();

    const filters = JSON.parse(cleanedJson);
    return {
      semanticQuery: filters.semanticQuery || null,
      sender: filters.sender || null,
      category: filters.category || null,
      startDate: filters.startDate || null,
      endDate: filters.endDate || null,
    };
  } catch (error) {
    console.error('Error extracting search filters:', error);
    // Return empty filters fallback
    return {
      semanticQuery: message,
      sender: null,
      category: null,
      startDate: null,
      endDate: null,
    };
  }
}

export async function POST(request: Request) {
  try {
    const { userId, message, chatHistory = [] } = await request.json();

    if (!userId || !message) {
      return NextResponse.json(
        { error: 'userId and message parameters are required.' },
        { status: 400 }
      );
    }

    // 1. Extract search parameters
    const filters = await extractSearchFilters(message, chatHistory);
    console.log('Parsed filters from user query:', filters);

    // Accumulate retrieved email items
    const matchedDocsMap = new Map<string, any>();

    // 2. RAG Route A: Vector Search (if semantic query present)
    if (filters.semanticQuery) {
      try {
        const queryEmbedding = await generateEmbedding(filters.semanticQuery, 'query');

        const { data: vectorResults, error: rpcError } = await supabaseAdmin.rpc(
          'match_email_embeddings',
          {
            query_embedding: queryEmbedding,
            match_threshold: 0.3,
            match_count: 12,
            filter_user_id: userId,
            filter_category: filters.category,
            filter_sender: filters.sender,
            filter_start_date: filters.startDate,
            filter_end_date: filters.endDate,
          }
        );

        if (rpcError) {
          console.error('RPC match_email_embeddings failed:', rpcError);
        } else if (vectorResults) {
          vectorResults.forEach((doc: any) => {
            matchedDocsMap.set(doc.email_id, {
              emailId: doc.email_id,
              threadId: doc.thread_id,
              subject: doc.subject,
              fromName: doc.from_name,
              fromEmail: doc.from_email,
              receivedAt: doc.received_at,
              chunkText: doc.chunk_text,
              score: doc.similarity,
            });
          });
        }
      } catch (err) {
        console.error('Vector search embedding failed, skipping:', err);
      }
    }

    // 3. RAG Route B: Keyword/SQL fallback search
    // If vector search didn't run or returned very few results, or if sender/date filters were supplied,
    // execute a direct PostgreSQL query to retrieve emails matching metadata filters.
    if (matchedDocsMap.size < 5) {
      let sqlQuery = supabaseAdmin
        .from('emails')
        .select('id, thread_id, subject, from_name, from_email, received_at, category, body, summary')
        .eq('user_id', userId)
        .order('received_at', { ascending: false })
        .limit(10);

      if (filters.category) {
        sqlQuery = sqlQuery.eq('category', filters.category);
      }

      if (filters.sender) {
        sqlQuery = sqlQuery.or(
          `from_email.ilike.%${filters.sender}%,from_name.ilike.%${filters.sender}%`
        );
      }

      if (filters.startDate) {
        sqlQuery = sqlQuery.gte('received_at', filters.startDate);
      }

      if (filters.endDate) {
        sqlQuery = sqlQuery.lte('received_at', filters.endDate);
      }

      const { data: sqlResults } = await sqlQuery;

      if (sqlResults) {
        sqlResults.forEach((email: any) => {
          // If we already have the email synced through vector search, skip.
          // Otherwise, insert a snippet. We can use the individual summary or first 800 chars of the body.
          if (!matchedDocsMap.has(email.id)) {
            const chunkText = email.summary 
              ? `[Summary] ${email.summary}\n[Body Preview] ${(email.body || '').slice(0, 500)}`
              : (email.body || '').slice(0, 800);

            matchedDocsMap.set(email.id, {
              emailId: email.id,
              threadId: email.thread_id,
              subject: email.subject,
              fromName: email.from_name,
              fromEmail: email.from_email,
              receivedAt: email.received_at,
              chunkText: chunkText,
              score: 0.5, // neutral score for non-semantic retrieval
            });
          }
        });
      }
    }

    // Convert map to sorted list
    const contextDocs = Array.from(matchedDocsMap.values()).sort((a, b) => b.score - a.score);
    console.log(`RAG: Feeding ${contextDocs.length} snippets into Gemini Context.`);

    // 4. Generate Chat Response
    const responseText = await chatAgentResponse(message, contextDocs, chatHistory);

    return NextResponse.json({
      response: responseText,
      filters: filters,
      documentsCount: contextDocs.length,
    });

  } catch (error: any) {
    console.error('Error in POST /api/chat:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
