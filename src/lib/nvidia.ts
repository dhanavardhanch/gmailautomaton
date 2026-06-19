import OpenAI from 'openai';
import { getAppConfig } from './config';
import { cleanText } from './mistral';

const getNvidiaClient = () => {
  const config = getAppConfig();
  const apiKey = config.nvidiaNimApiKey;
  if (!apiKey) {
    // Return a mock/fallback interface if API key is not yet set,
    // so the app remains functional for onboarding
    return null;
  }
  return new OpenAI({
    apiKey,
    baseURL: 'https://integrate.api.nvidia.com/v1',
  });
};

const getModelName = () => {
  const config = getAppConfig();
  return config.nvidiaNimModel || 'meta/llama-3.1-70b-instruct';
};

/**
 * Classifies an email into one of 6 predefined categories.
 */
export async function categorizeEmail(
  subject: string,
  from: string,
  body: string
): Promise<string> {
  const client = getNvidiaClient();
  const model = getModelName();

  if (!client) {
    console.warn('NVIDIA_NIM_API_KEY not configured. Falling back to default category "Personal".');
    return 'Personal';
  }

  const snippet = cleanText(body, 1000);

  const systemPrompt = `You are a precise email classifier. Your task is to classify the given email into exactly one of the following categories:
- Newsletters (Marketing updates, digests, newsletters, periodic subscriptions)
- Job / Recruitment (Job applications, recruiter outreach, interviews, offers, rejections)
- Finance (Invoices, receipts, salary details, banking alerts, billing, payments)
- Notifications (Automated alerts, system OTPs, sign-up confirmations, password resets, platform updates)
- Personal (Direct human-to-human communication of a personal/informal nature)
- Work / Professional (Business-related emails, team discussions, client/vendor interactions, project plans)

You MUST respond with ONLY the category name. Do not write a sentence, introduction, explanation, or any surrounding text. Respond with exactly one of the 6 options above.`;

  const userContent = `Subject: ${subject}
From: ${from}
Email Content Snippet: ${snippet}

Category:`;

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.1,
      max_tokens: 20,
    });

    const category = response.choices[0]?.message?.content?.trim() || 'Work / Professional';
    
    // Normalize and validate category
    const validCategories = [
      'Newsletters',
      'Job / Recruitment',
      'Finance',
      'Notifications',
      'Personal',
      'Work / Professional',
    ];
    
    // Find closest match in case of minor casing/formatting differences
    const matched = validCategories.find(
      (cat) => cat.toLowerCase() === category.toLowerCase() || category.includes(cat)
    );

    return matched || 'Work / Professional';
  } catch (error) {
    console.error('Error in categorizeEmail via NVIDIA NIM:', error);
    return 'Work / Professional'; // Fallback
  }
}

export interface NewsItem {
  id: string;
  title: string;
  summary: string;
  source: string;
}

export interface DeduplicatedStory {
  title: string;
  summary: string;
  sources: string[];
}

/**
 * Deduplicates and clusters similar news stories across multiple newsletter items
 * using NVIDIA NIM's reasoning capabilities.
 */
export async function deduplicateNewsletters(
  items: NewsItem[]
): Promise<DeduplicatedStory[]> {
  const client = getNvidiaClient();
  const model = getModelName();

  if (!client) {
    console.warn('NVIDIA_NIM_API_KEY not configured. Returning items without deduplication.');
    return items.map((item) => ({
      title: item.title,
      summary: item.summary,
      sources: [item.source],
    }));
  }

  if (items.length === 0) return [];

  const systemPrompt = `You are an expert news editor. You are given a list of news items extracted from different newsletters. Some news items cover the exact same story or event.
Your task is to:
1. Group/cluster similar news items that describe the same real-world event or topic (semantic deduplication).
2. For each unique story:
   - Select or write a single unified and clear headline.
   - Write a short, combined summary (2-3 sentences) integrating details from all sources.
   - List the unique newsletter source names that carried this story.
3. If an item is unique and doesn't group with others, keep it as its own story.
4. Output the result ONLY as a valid JSON array of objects. Do not include markdown code block syntax (like \`\`\`json) or any conversational text.

Each object in the array must strictly have these fields:
- "title" (string): The unified headline.
- "summary" (string): The combined description.
- "sources" (array of strings): The list of original source names (e.g. ["TechCrunch", "TLDR"]).

Example output structure:
[
  {
    "title": "OpenAI Launches SearchGPT",
    "summary": "OpenAI has officially entered the search engine market with the prototype SearchGPT. It offers real-time answers with clear source attribution.",
    "sources": ["TLDR Tech", "ByteByteGo"]
  }
]`;

  const userContent = JSON.stringify(
    items.map((it) => ({
      id: it.id,
      title: it.title,
      summary: it.summary,
      source: it.source,
    })),
    null,
    2
  );

  try {
    const response = await client.chat.completions.create({
      model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userContent },
      ],
      temperature: 0.2,
      max_tokens: 2000,
    });

    const rawJson = response.choices[0]?.message?.content?.trim() || '[]';
    
    // Clean potential markdown output formatting (e.g. ```json ... ```)
    const cleanedJson = rawJson
      .replace(/^```json/i, '')
      .replace(/^```/m, '')
      .replace(/```$/m, '')
      .trim();

    const result = JSON.parse(cleanedJson);
    if (Array.isArray(result)) {
      return result as DeduplicatedStory[];
    }
    
    throw new Error('Response is not a JSON array');
  } catch (error) {
    console.error('Error deduplicating newsletters via NVIDIA NIM:', error);
    
    // Simple fallback: group items by exact title match or just list them separately
    const fallbackMap = new Map<string, DeduplicatedStory>();
    items.forEach((item) => {
      const key = item.title.toLowerCase().trim();
      if (fallbackMap.has(key)) {
        const existing = fallbackMap.get(key)!;
        if (!existing.sources.includes(item.source)) {
          existing.sources.push(item.source);
        }
      } else {
        fallbackMap.set(key, {
          title: item.title,
          summary: item.summary,
          sources: [item.source],
        });
      }
    });

    return Array.from(fallbackMap.values());
  }
}
