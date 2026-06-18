'use client';

import React, { useEffect, useState } from 'react';
import { Settings, Mail, ShieldAlert, Sparkles, CheckCircle2, RotateCcw } from 'lucide-react';

interface ConfigState {
  supabaseUrl: string;
  supabaseAnonKey: string;
  supabaseServiceKey: string;
  googleClientId: string;
  googleClientSecret: string;
  googleRedirectUri: string;
  geminiApiKey: string;
  nvidiaNimApiKey: string;
  nvidiaNimModel: string;
}

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000'; // Default UUID for local demo simplification

export default function OnboardingPage() {
  const [isConfigured, setIsConfigured] = useState<boolean | null>(null);
  const [showConfigForm, setShowConfigForm] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [form, setForm] = useState<ConfigState>({
    supabaseUrl: '',
    supabaseAnonKey: '',
    supabaseServiceKey: '',
    googleClientId: '',
    googleClientSecret: '',
    googleRedirectUri: 'http://localhost:3000/api/oauth/callback',
    geminiApiKey: '',
    nvidiaNimApiKey: '',
    nvidiaNimModel: 'meta/llama-3.1-70b-instruct',
  });

  // Check config status on mount
  useEffect(() => {
    fetchConfig();
    
    // Check if error query param is present (passed from oauth callback on failure)
    const params = new URLSearchParams(window.location.search);
    const errParam = params.get('error');
    if (errParam) {
      setError(decodeURIComponent(errParam));
    }
  }, []);

  const fetchConfig = async () => {
    try {
      const res = await fetch('/api/config');
      const data = await res.json();
      setIsConfigured(data.isComplete);
      if (!data.isComplete) {
        setShowConfigForm(true);
      }
      // Populate fields with masked/existing values
      if (data.config) {
        setForm((prev) => ({
          ...prev,
          supabaseUrl: data.config.supabaseUrl || '',
          googleRedirectUri: data.config.googleRedirectUri || 'http://localhost:3000/api/oauth/callback',
          nvidiaNimModel: data.config.nvidiaNimModel || 'meta/llama-3.1-70b-instruct',
        }));
      }
    } catch {
      setError('Failed to fetch application configurations.');
    }
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => {
    const { name, value } = e.target;
    setForm((prev) => ({ ...prev, [name]: value }));
  };

  const saveConfig = async (e: React.FormEvent) => {
    e.preventDefault();
    setLoading(true);
    setError(null);
    setSuccess(null);

    try {
      const res = await fetch('/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(form),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to save configuration.');
      }

      setSuccess('Configuration saved successfully! Environment variables initialized.');
      setIsConfigured(true);
      setShowConfigForm(false);
    } catch (err: any) {
      setError(err.message || 'Error occurred while saving configurations.');
    } finally {
      setLoading(false);
    }
  };

  const connectGmail = async () => {
    setLoading(true);
    setError(null);

    try {
      const res = await fetch(`/api/oauth/url?userId=${DEFAULT_USER_ID}`);
      const data = await res.json();

      if (!res.ok || !data.url) {
        throw new Error(data.error || 'Failed to generate consent URL.');
      }

      // Redirect user to Google Consent Screen
      window.location.href = data.url;
    } catch (err: any) {
      setError(err.message || 'Failed to trigger OAuth redirect.');
      setLoading(false);
    }
  };

  if (isConfigured === null) {
    return (
      <div style={styles.loadingContainer}>
        <div style={styles.spinner}></div>
        <p style={{ marginTop: '16px', color: '#94a3b8' }}>Loading visual interface...</p>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      {/* Background visual glow orbs */}
      <div style={styles.orbPurple}></div>
      <div style={styles.orbIndigo}></div>

      <div style={styles.card}>
        <div style={styles.logoSection}>
          <div style={styles.logoIcon}>
            <Sparkles size={32} color="#a78bfa" />
          </div>
          <h1 style={styles.title}>AETHER</h1>
          <p style={styles.subtitle}>AI-Powered Gmail Intelligence Platform</p>
        </div>

        {error && (
          <div style={styles.alertError}>
            <ShieldAlert size={20} color="#f43f5e" style={{ flexShrink: 0 }} />
            <span>{error}</span>
          </div>
        )}

        {success && (
          <div style={styles.alertSuccess}>
            <CheckCircle2 size={20} color="#10b981" style={{ flexShrink: 0 }} />
            <span>{success}</span>
          </div>
        )}

        {showConfigForm ? (
          <form onSubmit={saveConfig} style={styles.form}>
            <h2 style={styles.formTitle}>
              <Settings size={18} style={{ marginRight: '8px' }} />
              Local Configuration Settings
            </h2>
            <p style={styles.formDesc}>
              To run the application locally, paste your keys below. This writes them to a local configuration file.
            </p>

            <div style={styles.inputGroup}>
              <label style={styles.label}>Supabase Project URL</label>
              <input
                style={styles.input}
                type="text"
                name="supabaseUrl"
                placeholder="https://xxxx.supabase.co"
                value={form.supabaseUrl}
                onChange={handleInputChange}
                required
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>Supabase Anon Key</label>
              <input
                style={styles.input}
                type="password"
                name="supabaseAnonKey"
                placeholder="Paste public anon key..."
                value={form.supabaseAnonKey}
                onChange={handleInputChange}
                required
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>Supabase Service Role Key</label>
              <input
                style={styles.input}
                type="password"
                name="supabaseServiceKey"
                placeholder="Paste private service role key..."
                value={form.supabaseServiceKey}
                onChange={handleInputChange}
                required
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>Google OAuth Client ID</label>
              <input
                style={styles.input}
                type="password"
                name="googleClientId"
                placeholder="xxxx.apps.googleusercontent.com"
                value={form.googleClientId}
                onChange={handleInputChange}
                required
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>Google OAuth Client Secret</label>
              <input
                style={styles.input}
                type="password"
                name="googleClientSecret"
                placeholder="Paste client secret..."
                value={form.googleClientSecret}
                onChange={handleInputChange}
                required
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>Google Redirect URI</label>
              <input
                style={styles.input}
                type="text"
                name="googleRedirectUri"
                value={form.googleRedirectUri}
                onChange={handleInputChange}
                required
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>Google Gemini API Key</label>
              <input
                style={styles.input}
                type="password"
                name="geminiApiKey"
                placeholder="AIzaSy..."
                value={form.geminiApiKey}
                onChange={handleInputChange}
                required
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>NVIDIA NIM API Key</label>
              <input
                style={styles.input}
                type="password"
                name="nvidiaNimApiKey"
                placeholder="nvapi-..."
                value={form.nvidiaNimApiKey}
                onChange={handleInputChange}
                required
              />
            </div>

            <div style={styles.inputGroup}>
              <label style={styles.label}>NVIDIA NIM Model</label>
              <select
                style={styles.select}
                name="nvidiaNimModel"
                value={form.nvidiaNimModel}
                onChange={handleInputChange}
              >
                <option value="meta/llama-3.1-70b-instruct">meta/llama-3.1-70b-instruct</option>
                <option value="nvidia/llama-3.1-nemotron-70b-instruct">nvidia/llama-3.1-nemotron-70b-instruct</option>
                <option value="meta/llama-3.1-8b-instruct">meta/llama-3.1-8b-instruct</option>
              </select>
            </div>

            <button type="submit" className="glow-button" style={styles.btnFull} disabled={loading}>
              {loading ? <div style={styles.miniSpinner}></div> : 'Save configuration'}
            </button>
            
            {isConfigured && (
              <button 
                type="button" 
                className="secondary-button" 
                style={{ ...styles.btnFull, marginTop: '8px' }} 
                onClick={() => setShowConfigForm(false)}
              >
                Cancel
              </button>
            )}
          </form>
        ) : (
          <div style={styles.readySection}>
            <div style={styles.statusBox}>
              <div style={styles.greenPulse}></div>
              <span style={{ fontSize: '0.9rem', color: '#34d399', fontWeight: 500 }}>
                API credentials configured successfully
              </span>
            </div>

            <p style={styles.descText}>
              Aether is ready to connect. Link your Gmail account to begin secure indexing and unlock AI-driven insights, summarization, and chat capabilities.
            </p>

            <button 
              onClick={connectGmail} 
              className="glow-button" 
              style={{ ...styles.btnFull, height: '50px', borderRadius: '12px', fontSize: '1rem' }} 
              disabled={loading}
            >
              {loading ? (
                <div style={styles.miniSpinner}></div>
              ) : (
                <>
                  <Mail size={18} />
                  Connect Gmail account
                </>
              )}
            </button>
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    width: '100%',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '24px',
    background: 'radial-gradient(circle at center, #f9fafb 0%, #f3f4f6 100%)',
    position: 'relative',
    overflow: 'hidden',
  },
  orbPurple: {
    position: 'absolute',
    width: '350px',
    height: '350px',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(24, 24, 27, 0.03) 0%, rgba(24, 24, 27, 0) 70%)',
    filter: 'blur(60px)',
    top: '15%',
    left: '10%',
    pointerEvents: 'none',
    zIndex: 1,
  },
  orbIndigo: {
    position: 'absolute',
    width: '450px',
    height: '450px',
    borderRadius: '50%',
    background: 'radial-gradient(circle, rgba(24, 24, 27, 0.02) 0%, rgba(24, 24, 27, 0) 70%)',
    filter: 'blur(80px)',
    bottom: '10%',
    right: '10%',
    pointerEvents: 'none',
    zIndex: 1,
  },
  card: {
    width: '100%',
    maxWidth: '480px',
    padding: '40px',
    borderRadius: '24px',
    background: 'rgba(255, 255, 255, 0.8)',
    border: '1px solid rgba(24, 24, 27, 0.08)',
    boxShadow: '0 20px 40px rgba(0, 0, 0, 0.04), inset 0 1px 0 rgba(255, 255, 255, 0.6)',
    backdropFilter: 'blur(24px)',
    WebkitBackdropFilter: 'blur(24px)',
    animation: 'fadeIn 0.5s ease-out',
    zIndex: 5,
    color: '#18181b',
  },
  logoSection: {
    textAlign: 'center',
    marginBottom: '32px',
  },
  logoIcon: {
    width: '64px',
    height: '64px',
    borderRadius: '16px',
    background: 'rgba(24, 24, 27, 0.05)',
    border: '1px solid rgba(24, 24, 27, 0.15)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    margin: '0 auto 20px auto',
    boxShadow: '0 4px 12px rgba(0, 0, 0, 0.03)',
  },
  title: {
    fontSize: '2.5rem',
    fontWeight: 800,
    letterSpacing: '4px',
    background: 'linear-gradient(135deg, #09090b 30%, #52525b 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
    marginBottom: '8px',
  },
  subtitle: {
    fontSize: '0.9rem',
    color: '#71717a',
    marginTop: '6px',
    fontWeight: 400,
    letterSpacing: '0.5px',
  },
  alertError: {
    background: 'rgba(239, 68, 68, 0.08)',
    border: '1px solid rgba(239, 68, 68, 0.18)',
    padding: '12px 16px',
    borderRadius: '10px',
    color: '#b91c1c',
    fontSize: '0.85rem',
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    marginBottom: '20px',
    lineHeight: '1.4',
  },
  alertSuccess: {
    background: 'rgba(16, 185, 129, 0.08)',
    border: '1px solid rgba(16, 185, 129, 0.18)',
    padding: '12px 16px',
    borderRadius: '10px',
    color: '#047857',
    fontSize: '0.85rem',
    display: 'flex',
    gap: '12px',
    alignItems: 'center',
    marginBottom: '20px',
  },
  form: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  formTitle: {
    fontSize: '1.1rem',
    fontWeight: 600,
    display: 'flex',
    alignItems: 'center',
    color: '#18181b',
  },
  formDesc: {
    fontSize: '0.85rem',
    color: '#52525b',
    lineHeight: '1.5',
    marginBottom: '8px',
  },
  inputGroup: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  label: {
    fontSize: '0.8rem',
    fontWeight: 500,
    color: '#52525b',
  },
  input: {
    width: '100%',
    fontFamily: 'inherit',
    background: '#ffffff',
    border: '1px solid #d4d4d8',
    borderRadius: '10px',
    color: '#18181b',
    padding: '12px 16px',
    fontSize: '0.95rem',
    outline: 'none',
    transition: 'border-color 0.2s',
  },
  select: {
    background: '#ffffff',
    border: '1px solid #d4d4d8',
    borderRadius: '10px',
    color: '#18181b',
    padding: '12px 16px',
    fontSize: '0.95rem',
    fontFamily: 'inherit',
    outline: 'none',
    cursor: 'pointer',
    width: '100%',
  },
  btnFull: {
    width: '100%',
    marginTop: '12px',
  },
  readySection: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    textAlign: 'center',
    padding: '12px 0',
  },
  statusBox: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '8px 16px',
    borderRadius: '30px',
    background: 'rgba(16, 185, 129, 0.08)',
    border: '1px solid rgba(16, 185, 129, 0.25)',
    marginBottom: '24px',
  },
  greenPulse: {
    width: '8px',
    height: '8px',
    borderRadius: '50%',
    background: '#10b981',
    boxShadow: '0 0 12px #10b981',
  },
  descText: {
    fontSize: '0.95rem',
    color: '#52525b',
    lineHeight: '1.6',
    marginBottom: '32px',
  },
  loadingContainer: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: 'radial-gradient(circle at center, #f9fafb 0%, #f3f4f6 100%)',
  },
  spinner: {
    width: '40px',
    height: '40px',
    border: '3px solid rgba(24, 24, 27, 0.08)',
    borderTop: '3px solid #18181b',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  miniSpinner: {
    width: '18px',
    height: '18px',
    border: '2px solid rgba(255, 255, 255, 0.2)',
    borderTop: '2px solid #ffffff',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
};

