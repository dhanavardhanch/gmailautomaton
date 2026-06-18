import { NextResponse } from 'next/server';
import { supabaseAdmin } from '@/lib/supabase';
import { GoogleGenAI } from '@google/genai';
import { deduplicateNewsletters, NewsItem } from '@/lib/nvidia';

// Initialize a local Gemini client just for extraction
const getGeminiClient = () => {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error('GEMINI_API_KEY is not defined.');
  return new GoogleGenAI({ apiKey });
};

/**
 * Uses Gemini to parse a newsletter body and extract news items.
 */
async function extractNewsFromNewsletter(
  body: string,
  sourceName: string
): Promise<NewsItem[]> {
  try {
    const ai = getGeminiClient();
    const systemPrompt = `You are a news extraction assistant. Scan the following newsletter email and extract all major news items, articles, or stories.
For each news item, extract:
- The title or headline
- A concise summary (1-2 sentences) of the news

Output the results ONLY as a valid JSON array of objects. Do not include markdown code block styling or any conversational text.
Each object must have exactly these fields:
- "title" (string)
- "summary" (string)`;

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: [
        { role: 'user', parts: [{ text: systemPrompt + '\n\nNewsletter Body:\n' + body.slice(0, 4000) }] }
      ],
      config: {
        temperature: 0.1,
      }
    });

    const rawJson = response.text?.trim() || '[]';
    const cleanedJson = rawJson
      .replace(/^```json/i, '')
      .replace(/^```/m, '')
      .replace(/```$/m, '')
      .trim();

    const extracted = JSON.parse(cleanedJson);
    if (Array.isArray(extracted)) {
      return extracted.map((item: any, idx: number) => ({
        id: `${sourceName.replace(/\s+/g, '_')}_${Date.now()}_${idx}`,
        title: item.title || 'Untitled Story',
        summary: item.summary || '',
        source: sourceName,
      }));
    }
    return [];
  } catch (error) {
    console.error(`Error extracting news from newsletter (${sourceName}):`, error);
    return [];
  }
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const userId = searchParams.get('userId');

    if (!userId) {
      return NextResponse.json(
        { error: 'userId parameter is required in the query string.' },
        { status: 400 }
      );
    }

    // 1. Query newsletter emails received in the last 4 days (baseline June 17, 2026)
    const fourDaysAgo = new Date('2026-06-13T00:00:00.000Z');
    
    const { data: emails, error: emailsError } = await supabaseAdmin
      .from('emails')
      .select('id, subject, from_name, from_email, body, received_at')
      .eq('user_id', userId)
      .eq('category', 'Newsletters')
      .gte('received_at', fourDaysAgo.toISOString())
      .order('received_at', { ascending: false })
      .limit(6);

    if (emailsError) {
      return NextResponse.json({ error: emailsError.message }, { status: 500 });
    }

    let allNewsItems: NewsItem[] = [];

    // 2. Parse database newsletter emails if available
    if (emails && emails.length > 0) {
      console.log(`Extracting news from ${emails.length} newsletter emails...`);
      for (const email of emails) {
        const sourceName = email.from_name || email.from_email || 'Newsletter';
        const items = await extractNewsFromNewsletter(email.body || '', sourceName);
        allNewsItems.push(...items);
      }
    }

    // 3. Fallback: Provide curated mock tech news with duplicates if no newsletter emails are present in the DB.
    // This allows the user to see and evaluate the semantic deduplication engine.
    const usedFallback = allNewsItems.length === 0;
    if (usedFallback) {
      console.log('No recent newsletter emails found. Loading sample duplicate items for demonstration.');
      allNewsItems = [
        {
          id: 'tldr_1',
          title: 'Apple introduces Apple Intelligence at WWDC 2026',
          summary: 'Apple officially announced Apple Intelligence, a suite of deeply integrated generative AI tools across iOS 18, iPadOS 18, and macOS Sequoia.',
          source: 'TLDR Tech',
        },
        {
          id: 'tc_1',
          title: 'Apple WWDC 2026: Apple Intelligence and OpenAI Partnership',
          summary: 'Apple showcased its new AI system "Apple Intelligence" at WWDC, featuring writing assistance, image generation, and an integration with OpenAI\'s ChatGPT.',
          source: 'TechCrunch',
        },
        {
          id: 'sh_1',
          title: 'Apple Partners with OpenAI for iOS Siri Integration',
          summary: 'Apple has signed an agreement with OpenAI to bring ChatGPT to Siri and other system-wide applications, allowing users to query GPT-4o directly.',
          source: 'Superhuman AI',
        },
        {
          id: 'bb_1',
          title: 'NVIDIA Market Cap Hits $3 Trillion, Overtakes Apple',
          summary: 'Driven by massive demand for H100 and Blackwell AI server chips, NVIDIA\'s market valuation has officially crossed the $3 Trillion mark.',
          source: 'ByteByteGo',
        },
        {
          id: 'tldr_2',
          title: 'Nvidia passes Apple as US second most valuable company with $3T valuation',
          summary: 'Nvidia shares surged again, pushing its market capitalization above $3 trillion. It now trails only Microsoft in value.',
          source: 'TLDR Tech',
        },
        {
          id: 'tc_2',
          title: 'Google DeepMind announces Gemini 3.0',
          summary: 'Google has previewed Gemini 3.0, showcasing vastly expanded context sizes and advanced multi-agent planning capabilities.',
          source: 'TechCrunch',
        },
        {
          id: 'bb_2',
          title: 'Google reveals next-gen Gemini 3.0 model at I/O',
          summary: 'Google announced the release of Gemini 3.0, focusing on agentic reasoning and advanced coding capabilities.',
          source: 'ByteByteGo',
        },
      ];
    }

    // 4. Semantically cluster and deduplicate items using Llama 3.1 on NVIDIA NIM
    console.log(`Deduplicating ${allNewsItems.length} news items...`);
    const deduplicatedFeed = await deduplicateNewsletters(allNewsItems);

    return NextResponse.json({
      feed: deduplicatedFeed,
      originalCount: allNewsItems.length,
      deduplicatedCount: deduplicatedFeed.length,
      usedDemoFallback: usedFallback,
    });

  } catch (error: any) {
    console.error('Error in GET /api/news/dedup:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
