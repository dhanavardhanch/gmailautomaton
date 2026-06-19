import { NextResponse } from 'next/server';
import { getAppConfig, saveAppConfig, isConfigComplete, AppConfig } from '@/lib/config';

export async function GET() {
  try {
    const config = getAppConfig();
    const complete = isConfigComplete();

    // Mask sensitive secrets for UI display
    const mask = (val: string) => {
      if (!val) return '';
      if (val.length <= 8) return '********';
      return `${val.slice(0, 4)}...${val.slice(-4)}`;
    };

    return NextResponse.json({
      isComplete: complete,
      config: {
        supabaseUrl: config.supabaseUrl,
        supabaseAnonKey: mask(config.supabaseAnonKey),
        supabaseServiceKey: mask(config.supabaseServiceKey),
        googleClientId: mask(config.googleClientId),
        googleClientSecret: mask(config.googleClientSecret),
        googleRedirectUri: config.googleRedirectUri,
        nvidiaNimApiKey: mask(config.nvidiaNimApiKey),
        nvidiaNimModel: config.nvidiaNimModel,
      },
    });
  } catch (error: any) {
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}

export async function POST(request: Request) {
  try {
    const newConfig: AppConfig = await request.json();

    // Validate properties
    if (
      !newConfig.supabaseUrl ||
      !newConfig.supabaseAnonKey ||
      !newConfig.supabaseServiceKey ||
      !newConfig.googleClientId ||
      !newConfig.googleClientSecret ||
      !newConfig.nvidiaNimApiKey
    ) {
      return NextResponse.json({ error: 'All primary configurations are required.' }, { status: 400 });
    }

    saveAppConfig(newConfig);

    return NextResponse.json({ success: true, message: 'Configuration saved successfully.' });
  } catch (error: any) {
    console.error('Error saving configuration:', error);
    return NextResponse.json({ error: error.message || String(error) }, { status: 500 });
  }
}
