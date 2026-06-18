import { GoogleGenAI } from '@google/genai';
import { getAppConfig } from './config';

async function main() {
  try {
    const config = getAppConfig();
    const apiKey = config.geminiApiKey;
    console.log("Using API Key:", apiKey ? `${apiKey.trim().slice(0, 10)}...` : "NONE");
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash',
      contents: 'Say Hello!',
    });
    console.log("Generation response:", response.text);
  } catch (error) {
    console.error("Error listing models:", error);
  }
}

main();
