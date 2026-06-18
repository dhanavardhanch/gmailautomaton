import fs from 'fs';
import path from 'path';

const CONFIG_FILE_PATH = path.join(process.cwd(), 'local_config.json');

export interface AppConfig {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceKey: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  geminiApiKey: string;
  nvidiaNimApiKey: string;
  nvidiaNimModel: string;
  geminiQuotaExhausted?: boolean;
  geminiQuotaExhaustedKey?: string;
}

/**
 * Loads configuration, prioritizing process.env, and falling back to local_config.json.
 */
export function getAppConfig(): AppConfig {
  let localConfig: Partial<AppConfig> = {};
  
  try {
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      const fileData = fs.readFileSync(CONFIG_FILE_PATH, 'utf-8');
      localConfig = JSON.parse(fileData);
    }
  } catch (err) {
    console.error('Error reading local_config.json, using environment:', err);
  }

  return {
    supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL || localConfig.supabaseUrl || '',
    supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY || localConfig.supabaseAnonKey || '',
    supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY || localConfig.supabaseServiceKey || '',
    googleClientId: process.env.GOOGLE_CLIENT_ID || localConfig.googleClientId || '',
    googleClientSecret: process.env.GOOGLE_CLIENT_SECRET || localConfig.googleClientSecret || '',
    googleRedirectUri: process.env.GOOGLE_REDIRECT_URI || localConfig.googleRedirectUri || 'http://localhost:3000/api/oauth/callback',
    geminiApiKey: process.env.GEMINI_API_KEY || localConfig.geminiApiKey || '',
    nvidiaNimApiKey: process.env.NVIDIA_NIM_API_KEY || localConfig.nvidiaNimApiKey || '',
    nvidiaNimModel: process.env.NVIDIA_NIM_MODEL || localConfig.nvidiaNimModel || 'meta/llama-3.1-70b-instruct',
    geminiQuotaExhausted: localConfig.geminiQuotaExhausted || false,
    geminiQuotaExhaustedKey: localConfig.geminiQuotaExhaustedKey || '',
  };
}

/**
 * Saves configuration to local_config.json.
 */
export function saveAppConfig(config: AppConfig): void {
  try {
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(config, null, 2), 'utf-8');
    // Set them in process.env dynamically so they are immediately available
    process.env.NEXT_PUBLIC_SUPABASE_URL = config.supabaseUrl;
    process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = config.supabaseAnonKey;
    process.env.SUPABASE_SERVICE_ROLE_KEY = config.supabaseServiceKey;
    process.env.GOOGLE_CLIENT_ID = config.googleClientId;
    process.env.GOOGLE_CLIENT_SECRET = config.googleClientSecret;
    process.env.GOOGLE_REDIRECT_URI = config.googleRedirectUri;
    process.env.GEMINI_API_KEY = config.geminiApiKey;
    process.env.NVIDIA_NIM_API_KEY = config.nvidiaNimApiKey;
    process.env.NVIDIA_NIM_MODEL = config.nvidiaNimModel;
  } catch (err) {
    console.error('Failed to write local_config.json:', err);
    throw new Error('Failed to save configuration file locally.');
  }
}

/**
 * Validates if the configuration contains all required keys.
 */
export function isConfigComplete(): boolean {
  const config = getAppConfig();
  return !!(
    config.supabaseUrl &&
    config.supabaseAnonKey &&
    config.supabaseServiceKey &&
    config.googleClientId &&
    config.googleClientSecret &&
    config.geminiApiKey
  );
}

/**
 * Updates the Gemini daily quota limit status in local_config.json.
 */
export function updateGeminiQuotaStatus(exhausted: boolean, key: string): void {
  try {
    let currentConfig: any = {};
    if (fs.existsSync(CONFIG_FILE_PATH)) {
      currentConfig = JSON.parse(fs.readFileSync(CONFIG_FILE_PATH, 'utf-8'));
    }
    currentConfig.geminiQuotaExhausted = exhausted;
    currentConfig.geminiQuotaExhaustedKey = key;
    fs.writeFileSync(CONFIG_FILE_PATH, JSON.stringify(currentConfig, null, 2), 'utf-8');
  } catch (err) {
    console.error('Failed to update Gemini quota status in config:', err);
  }
}

