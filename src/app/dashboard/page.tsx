'use client';

import React, { useEffect, useState, useRef } from 'react';
import { 
  Mail, RefreshCw, Send, Sparkles, MessageSquare, 
  CheckCircle2, AlertCircle, Inbox, Briefcase, FileText, 
  Bell, Users, Landmark, Newspaper, ArrowRight, X, ChevronDown, ChevronUp 
} from 'lucide-react';

const DEFAULT_USER_ID = '00000000-0000-0000-0000-000000000000';

interface ThreadSummary {
  id: string;
  subject: string;
  summary: string;
  last_message_at: string;
  representative_category: string;
  latest_sender: string;
}

interface EmailMessage {
  id: string;
  thread_id: string;
  subject: string;
  from_name: string;
  from_email: string;
  to_emails: string[];
  body: string;
  html_body?: string;
  received_at: string;
  category: string;
  summary: string;
}

interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

interface NewsStory {
  title: string;
  summary: string;
  sources: string[];
}

export default function DashboardPage() {
  // Inbox data state
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [activeCategory, setActiveCategory] = useState('All');
  const [categoryCounts, setCategoryCounts] = useState<Record<string, number>>({});
  const [connection, setConnection] = useState<{ email: string; syncStatus: string; lastSyncedAt: string; geminiQuotaExhausted?: boolean } | null>(null);
  
  // Selected Thread Detail State
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<ThreadSummary | null>(null);
  const [emailsInThread, setEmailsInThread] = useState<EmailMessage[]>([]);
  const [expandedEmails, setExpandedEmails] = useState<Record<string, boolean>>({});
  
  // News Digest Deduplication view state
  const [showNewsFeed, setShowNewsFeed] = useState(false);
  const [newsFeed, setNewsFeed] = useState<NewsStory[]>([]);
  const [newsLoading, setNewsLoading] = useState(false);
  
  // Compose and Reply State
  const [replyPrompt, setReplyPrompt] = useState('');
  const [replyDraft, setReplyDraft] = useState('');
  const [draftingMode, setDraftingMode] = useState<'idle' | 'auto-drafting' | 'drafting' | 'sending' | 'success' | 'failed'>('idle');
  const [showRetune, setShowRetune] = useState(false);
  const [composeModalOpen, setComposeModalOpen] = useState(false);
  const [newEmailForm, setNewEmailForm] = useState({ to: '', subject: '', prompt: '', draft: '' });

  // Assistant Drawer State
  const [assistantOpen, setAssistantOpen] = useState(false);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: 'model', text: 'Hello! I am your AI Gmail assistant. I have read all of your synced emails. Ask me any question, for example: \n- "What is discussed about the data migration?"\n- "Summarize important news from newsletters."\n- "List companies that emailed me about job applications."' }
  ]);
  const [chatInput, setChatInput] = useState('');
  const [chatLoading, setChatLoading] = useState(false);
  
  // Sync state
  const [syncing, setSyncing] = useState(false);
  const [statusMessage, setStatusMessage] = useState<string | null>(null);
  const [errorMessage, setErrorMessage] = useState<string | null>(null);

  const chatEndRef = useRef<HTMLDivElement>(null);

  // Fetch threads and connection status on mount
  useEffect(() => {
    fetchThreads();
    
    // Check if redirect has "sync=trigger" query parameter
    const params = new URLSearchParams(window.location.search);
    if (params.get('sync') === 'trigger') {
      triggerSync();
      // Clean up URL query parameters
      window.history.replaceState({}, document.title, window.location.pathname);
    }
  }, [activeCategory]);

  // Poll threads and sync status when syncing is active in the background
  useEffect(() => {
    let timerId: NodeJS.Timeout;
    
    if (connection?.syncStatus === 'syncing') {
      setSyncing(true);
      timerId = setTimeout(() => {
        fetchThreads();
      }, 4000);
    } else if (syncing && connection?.syncStatus === 'completed') {
      setSyncing(false);
      if (connection?.geminiQuotaExhausted) {
        setStatusMessage('Sync complete with warnings: Gemini API Key daily quota limit exceeded. AI features are disabled.');
      } else {
        setStatusMessage('Sync complete! Emails are up to date.');
      }
      fetchThreads(); // Reload threads to show new items
      if (selectedThreadId) {
        loadThreadDetail(selectedThreadId);
      }
      setTimeout(() => setStatusMessage(null), 6000);
    } else if (syncing && connection?.syncStatus === 'failed') {
      setSyncing(false);
      if (connection?.geminiQuotaExhausted) {
        setErrorMessage('Synchronization failed with quota errors: Gemini API Key daily quota limit exceeded.');
      } else {
        setErrorMessage('Synchronization failed. Please check credentials or key configurations.');
      }
      setTimeout(() => setErrorMessage(null), 6000);
    }
    
    return () => {
      if (timerId) clearTimeout(timerId);
    };
  }, [connection?.syncStatus, syncing]);

  useEffect(() => {
    if (assistantOpen) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, assistantOpen]);

  const fetchThreads = async () => {
    try {
      const res = await fetch(`/api/threads?userId=${DEFAULT_USER_ID}&category=${activeCategory}`);
      const data = await res.json();
      if (data.threads) {
        setThreads(data.threads);
        setCategoryCounts(data.categoryCounts || {});
        setConnection(data.connection || null);
      }
    } catch {
      setErrorMessage('Failed to connect to the backend server.');
    }
  };

  const loadThreadDetail = async (threadId: string) => {
    try {
      setSelectedThreadId(threadId);
      setShowNewsFeed(false);
      setReplyDraft('');
      setReplyPrompt('');
      setShowRetune(false);
      const res = await fetch(`/api/threads?userId=${DEFAULT_USER_ID}&threadId=${threadId}`);
      const data = await res.json();
      if (data.emails) {
        setEmailsInThread(data.emails);
        setSelectedThread(data.thread);
        
        // Expand the latest email, collapse the rest by default
        const expandMap: Record<string, boolean> = {};
        data.emails.forEach((email: EmailMessage, idx: number) => {
          expandMap[email.id] = idx === data.emails.length - 1;
        });
        setExpandedEmails(expandMap);

        // Auto-draft: generate a reply immediately using thread context
        generateAutoDraft(threadId, data.thread?.subject || '');
      }
    } catch {
      setErrorMessage('Failed to load thread details.');
    }
  };

  // Auto-generate a smart reply when a thread is opened
  const generateAutoDraft = async (threadId: string, subject: string) => {
    setDraftingMode('auto-drafting');
    try {
      const prompt = `Write a brief, professional acknowledgment or contextually appropriate reply to this email thread. Keep it concise and natural. Subject: ${subject}`;
      const res = await fetch('/api/emails/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft',
          userId: DEFAULT_USER_ID,
          prompt,
          threadId,
        }),
      });
      const data = await res.json();
      if (res.ok && data.draft) {
        setReplyDraft(data.draft);
      }
    } catch {
      // Silent fail — user can still type manually
    } finally {
      setDraftingMode('idle');
    }
  };

  const handleLogout = async () => {
    if (!confirm('Are you sure you want to disconnect your Gmail account? This will purge all synced email data from local storage.')) {
      return;
    }
    
    setSyncing(true);
    setStatusMessage('Disconnecting account and purging email data...');
    setErrorMessage(null);
    try {
      const res = await fetch('/api/oauth/logout', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: DEFAULT_USER_ID }),
      });
      
      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Failed to logout.');
      }
      
      // Clear local states
      setThreads([]);
      setEmailsInThread([]);
      setSelectedThreadId(null);
      setSelectedThread(null);
      setConnection(null);
      
      setStatusMessage('Purge complete. Redirecting...');
      setTimeout(() => {
        window.location.href = '/';
      }, 1000);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to disconnect account.');
    } finally {
      setSyncing(false);
    }
  };

  const triggerSync = async () => {
    setSyncing(true);
    setStatusMessage('Initiating inbox sync...');
    setErrorMessage(null);

    try {
      const res = await fetch('/api/sync', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ userId: DEFAULT_USER_ID, maxThreads: 10 }),
      });
      const data = await res.json();
      
      if (!res.ok) {
        throw new Error(data.error || 'Synchronization failed.');
      }

      setStatusMessage(data.message || 'Sync started in background.');
      await fetchThreads();
    } catch (err: any) {
      setErrorMessage(err.message || 'An error occurred during synchronization.');
      setSyncing(false);
      setStatusMessage(null);
    }
  };

  // Generate Reply Draft using Gemini (used by Re-tune section)
  const generateReply = async () => {
    if (!selectedThreadId) return;
    setDraftingMode('drafting');
    setErrorMessage(null);

    try {
      const prompt = replyPrompt.trim() || `Write a professional, contextually appropriate reply to this thread. Subject: ${selectedThread?.subject || ''}`;
      const res = await fetch('/api/emails/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft',
          userId: DEFAULT_USER_ID,
          prompt,
          threadId: selectedThreadId,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to draft reply.');

      setReplyDraft(data.draft);
      setDraftingMode('idle');
      setShowRetune(false);
    } catch (err: any) {
      setErrorMessage(err.message || 'Drafting failed.');
      setDraftingMode('failed');
    }
  };

  // Send Reply via Gmail API
  const sendReply = async () => {
    if (!replyDraft || !selectedThreadId || !emailsInThread.length) return;
    setDraftingMode('sending');
    setErrorMessage(null);

    const latestEmail = emailsInThread[emailsInThread.length - 1];

    try {
      const res = await fetch('/api/emails/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          userId: DEFAULT_USER_ID,
          to: latestEmail.from_email,
          subject: selectedThread?.subject || latestEmail.subject,
          body: replyDraft,
          threadId: selectedThreadId,
        }),
      });
      
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send reply.');

      setStatusMessage('Reply sent successfully!');
      setReplyDraft('');
      setReplyPrompt('');
      setDraftingMode('success');
      
      // Refresh thread detail (syncs the sent message into the UI thread view)
      setTimeout(() => {
        triggerSync();
        setDraftingMode('idle');
      }, 1500);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to send response.');
      setDraftingMode('failed');
    }
  };

  // Compose New Email Modal Generate Draft
  const generateNewEmailDraft = async () => {
    if (!newEmailForm.prompt) return;
    setDraftingMode('drafting');
    setErrorMessage(null);

    try {
      const res = await fetch('/api/emails/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'draft',
          userId: DEFAULT_USER_ID,
          prompt: newEmailForm.prompt,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to draft email.');

      setNewEmailForm(prev => ({ ...prev, draft: data.draft }));
      setDraftingMode('idle');
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to draft email.');
      setDraftingMode('failed');
    }
  };

  // Compose Send New Email
  const sendNewEmail = async () => {
    if (!newEmailForm.to || !newEmailForm.subject || !newEmailForm.draft) return;
    setDraftingMode('sending');
    setErrorMessage(null);

    try {
      const res = await fetch('/api/emails/compose', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          action: 'send',
          userId: DEFAULT_USER_ID,
          to: newEmailForm.to,
          subject: newEmailForm.subject,
          body: newEmailForm.draft,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to send email.');

      setStatusMessage('New email sent successfully!');
      setComposeModalOpen(false);
      setNewEmailForm({ to: '', subject: '', prompt: '', draft: '' });
      setDraftingMode('idle');
      
      setTimeout(() => triggerSync(), 1500);
    } catch (err: any) {
      setErrorMessage(err.message || 'Failed to send email.');
      setDraftingMode('failed');
    }
  };

  // Fetch News Digest (Newsletter semantic deduplication)
  const fetchNewsDigest = async () => {
    setShowNewsFeed(true);
    setSelectedThreadId(null);
    setNewsLoading(true);
    setErrorMessage(null);

    try {
      const res = await fetch(`/api/news/dedup?userId=${DEFAULT_USER_ID}`);
      const data = await res.json();
      if (data.feed) {
        setNewsFeed(data.feed);
      }
    } catch {
      setErrorMessage('Failed to fetch newsletter digest.');
    } finally {
      setNewsLoading(false);
    }
  };

  // Assistant Chat Query Submission
  const submitChat = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!chatInput.trim()) return;

    const userMsg = chatInput;
    setChatMessages((prev) => [...prev, { role: 'user', text: userMsg }]);
    setChatInput('');
    setChatLoading(true);
    setErrorMessage(null);

    // Filter down chat history structure to matches Gemini API constraints
    const historyPayload = chatMessages.map((m) => ({
      role: m.role,
      text: m.text,
    }));

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId: DEFAULT_USER_ID,
          message: userMsg,
          chatHistory: historyPayload,
        }),
      });

      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Assistant failed to respond.');

      setChatMessages((prev) => [...prev, { role: 'model', text: data.response }]);
    } catch (err: any) {
      setErrorMessage(err.message || 'Error occurred in assistant conversation.');
      setChatMessages((prev) => [
        ...prev,
        { role: 'model', text: 'Sorry, I failed to process that request. Check your API configurations.' }
      ]);
    } finally {
      setChatLoading(false);
    }
  };

  // Custom parser to render Markdown citation links as clickable buttons
  const renderMessageContent = (text: string) => {
    // Regex matches [Source: Subject by Sender on Date](thread:threadId)
    const regex = /\[Source:\s*([^\]]+)\]\(thread:([^\)]+)\)/g;
    const parts = [];
    let lastIndex = 0;
    let match;

    while ((match = regex.exec(text)) !== null) {
      const matchIndex = match.index;
      // Add plain text before the citation
      if (matchIndex > lastIndex) {
        parts.push(text.substring(lastIndex, matchIndex));
      }

      const label = match[1];
      const tId = match[2];

      // Insert clickable button link
      parts.push(
        <button
          key={matchIndex}
          onClick={() => loadThreadDetail(tId)}
          style={styles.citationBadge}
        >
          📄 {label}
        </button>
      );

      lastIndex = regex.lastIndex;
    }

    if (lastIndex < text.length) {
      parts.push(text.substring(lastIndex));
    }

    return (
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: '1.6' }}>
        {parts.length > 0 ? parts : text}
      </div>
    );
  };

  const toggleEmailExpand = (emailId: string) => {
    setExpandedEmails((prev) => ({ ...prev, [emailId]: !prev[emailId] }));
  };

  const getCategoryIcon = (catName: string) => {
    switch (catName) {
      case 'Personal': return <Users size={16} />;
      case 'Work / Professional': return <Briefcase size={16} />;
      case 'Finance': return <Landmark size={16} />;
      case 'Notifications': return <Bell size={16} />;
      case 'Job / Recruitment': return <FileText size={16} />;
      case 'Newsletters': return <Newspaper size={16} />;
      default: return <Inbox size={16} />;
    }
  };

  const getBadgeClass = (category: string) => {
    switch (category) {
      case 'Personal': return 'badge-personal';
      case 'Work / Professional': return 'badge-work';
      case 'Finance': return 'badge-finance';
      case 'Notifications': return 'badge-notifications';
      case 'Job / Recruitment': return 'badge-recruitment';
      case 'Newsletters': return 'badge-newsletters';
      default: return 'badge-uncategorized';
    }
  };

  return (
    <div style={styles.dashboardLayout}>
      
      {/* 1. Sidebar (Left Panel) */}
      <aside style={styles.sidebar} className="glass-panel">
        <div style={styles.sidebarHeader}>
          <div style={styles.sidebarLogoBox}>
            <Sparkles size={20} color="#18181b" />
            <h2 style={styles.logoText}>AETHER</h2>
          </div>
          
          <button 
            onClick={() => setComposeModalOpen(true)} 
            className="glow-button" 
            style={{ width: '100%', padding: '12px', marginTop: '16px' }}
          >
            Compose email
          </button>
        </div>

        {/* Connection status display */}
        <div style={styles.connectionBox}>
          {connection ? (
            <>
              <div style={styles.connectionDetails}>
                <div style={styles.connectionPulse}></div>
                <span style={styles.connectionEmail} title={connection.email}>
                  {connection.email}
                </span>
              </div>
              <div style={styles.syncMeta}>
                Last sync: {connection.lastSyncedAt ? new Date(connection.lastSyncedAt).toLocaleTimeString() : 'Never'}
              </div>
              {connection.geminiQuotaExhausted && (
                <div style={{
                  marginTop: '8px',
                  padding: '6px 8px',
                  borderRadius: '6px',
                  backgroundColor: '#fffbeb',
                  border: '1px solid #fef3c7',
                  color: '#b45309',
                  fontSize: '0.72rem',
                  lineHeight: '1.25'
                }}>
                  ⚠️ Gemini daily limit exceeded. AI features disabled.
                </div>
              )}
            </>
          ) : (
            <span style={{ color: '#ef4444', fontSize: '0.85rem' }}>Gmail not connected.</span>
          )}

          <button 
            onClick={triggerSync} 
            className="secondary-button" 
            style={{ width: '100%', marginTop: '10px', height: '36px' }}
            disabled={syncing}
          >
            <RefreshCw size={14} className={syncing ? 'spin-anim' : ''} style={{ marginRight: '6px' }} />
            {syncing ? 'Syncing...' : 'Sync inbox'}
          </button>

          {connection && (
            <button 
              onClick={handleLogout} 
              className="secondary-button" 
              style={{ width: '100%', marginTop: '8px', height: '36px', borderColor: 'rgba(239, 68, 68, 0.2)', color: '#ef4444' }}
              disabled={syncing}
            >
              Disconnect Gmail
            </button>
          )}
        </div>

        {/* Scrollable middle section: categories + tools */}
        <div style={styles.sidebarScrollable}>
          {/* Category Filters */}
          <nav style={styles.categoryNav}>
            <h4 style={styles.sectionHeading}>INBOX CATEGORIES</h4>
            
            {[
              { name: 'All', icon: <Inbox size={16} /> },
              { name: 'Personal', icon: <Users size={16} /> },
              { name: 'Work / Professional', icon: <Briefcase size={16} /> },
              { name: 'Finance', icon: <Landmark size={16} /> },
              { name: 'Notifications', icon: <Bell size={16} /> },
              { name: 'Job / Recruitment', icon: <FileText size={16} /> },
              { name: 'Newsletters', icon: <Newspaper size={16} /> }
            ].map((cat) => (
              <button
                key={cat.name}
                onClick={() => {
                  setActiveCategory(cat.name);
                  setShowNewsFeed(false);
                }}
                style={{
                  ...styles.categoryBtn,
                  backgroundColor: activeCategory === cat.name && !showNewsFeed ? 'rgba(79, 70, 229, 0.08)' : 'transparent',
                  color: activeCategory === cat.name && !showNewsFeed ? '#4f46e5' : '#475569',
                  borderColor: activeCategory === cat.name && !showNewsFeed ? 'rgba(79, 70, 229, 0.15)' : 'transparent',
                }}
              >
                <div style={styles.catLeft}>
                  {cat.icon}
                  <span>{cat.name}</span>
                </div>
                <span style={styles.catCount}>
                  {categoryCounts[cat.name] || 0}
                </span>
              </button>
            ))}

            {/* Bonus newsletter deduplication view trigger */}
            <h4 style={{ marginTop: '24px', ...styles.sectionHeading }}>INTELLIGENCE TOOLS</h4>
            <button
              onClick={fetchNewsDigest}
              style={{
                ...styles.categoryBtn,
                backgroundColor: showNewsFeed ? 'rgba(8, 145, 178, 0.08)' : 'transparent',
                color: showNewsFeed ? '#0891b2' : '#475569',
                borderColor: showNewsFeed ? 'rgba(8, 145, 178, 0.15)' : 'transparent',
              }}
            >
              <div style={styles.catLeft}>
                <Newspaper size={16} />
                <span>Newsletter Digest</span>
              </div>
              <span style={styles.bonusBadge}>Bonus</span>
            </button>
          </nav>
        </div>

        {/* AI Assistant button — pinned at bottom, always visible */}
        <div style={styles.sidebarFooter}>
          <button
            onClick={() => setAssistantOpen(true)}
            className="glow-button"
            style={{
              background: 'linear-gradient(135deg, #00f2fe 0%, #4facfe 100%)',
              boxShadow: '0 4px 15px rgba(0, 242, 254, 0.25)',
              width: '100%',
            }}
          >
            <MessageSquare size={16} />
            AI assistant
          </button>
        </div>
      </aside>

      {/* 2. Main Content Area */}
      <main style={styles.mainContent}>
        
        {/* Compact notification bar - small, aligned left */}
        {(syncing || statusMessage || errorMessage) && (
          <div style={styles.notificationBar}>
            {syncing && (
              <div style={styles.notifItem}>
                <div style={styles.notifSpinner} />
                <span>Syncing inbox...</span>
              </div>
            )}
            {statusMessage && !syncing && (
              <div style={{ ...styles.notifItem, color: '#059669' }}>
                <CheckCircle2 size={13} />
                <span>{statusMessage}</span>
              </div>
            )}
            {errorMessage && (
              <div style={{ ...styles.notifItem, color: '#dc2626' }}>
                <AlertCircle size={13} />
                <span>{errorMessage}</span>
                <button onClick={() => setErrorMessage(null)} style={styles.notifClose}><X size={12} /></button>
              </div>
            )}
          </div>
        )}

        <div style={styles.workspaceGrid}>
          
          {/* Threads List Panel */}
          <div style={styles.threadsPanel} className="glass-panel">
            <div style={styles.panelHeader}>
              <h3 style={styles.panelTitle}>
                {showNewsFeed ? 'Semantic Newsletter Feed' : `${activeCategory} Threads`}
              </h3>
              <span style={styles.threadBadgeCount}>
                {showNewsFeed ? `${newsFeed.length} Stories` : `${threads.length} Threads`}
              </span>
            </div>

            <div style={styles.scrollableList}>
              {/* Render semantic newsletter digest */}
              {showNewsFeed ? (
                newsLoading ? (
                  <div style={styles.listCenteredText}>
                    <div style={styles.spinner}></div>
                    <p style={{ marginTop: '12px' }}>Deduplicating news stories using NVIDIA Llama 3.1...</p>
                  </div>
                ) : newsFeed.length === 0 ? (
                  <div style={styles.listCenteredText}>No news items found.</div>
                ) : (
                  newsFeed.map((story, idx) => (
                    <div key={idx} style={styles.newsCard}>
                      <div style={styles.newsHeader}>
                        <h4 style={styles.newsStoryTitle}>{story.title}</h4>
                        <div style={styles.sourcesRow}>
                          {story.sources.map((s, sIdx) => (
                            <span key={sIdx} style={styles.newsSourceBadge}>{s}</span>
                          ))}
                        </div>
                      </div>
                      <p style={styles.newsSummary}>{story.summary}</p>
                    </div>
                  ))
                )
              ) : (
                /* Render normal email threads list */
                threads.length === 0 ? (
                  <div style={styles.listCenteredText}>
                    <Inbox size={32} color="#475569" style={{ marginBottom: '8px' }} />
                    No emails synced in this category yet. Click 'Sync Inbox' above to load emails.
                  </div>
                ) : (
                  threads.map((thread) => (
                    <div
                      key={thread.id}
                      onClick={() => loadThreadDetail(thread.id)}
                      style={{
                        ...styles.threadCard,
                        borderLeft: selectedThreadId === thread.id ? '3px solid hsl(var(--primary))' : '1px solid transparent',
                        backgroundColor: selectedThreadId === thread.id ? 'rgba(0,0,0,0.04)' : 'transparent',
                      }}
                    >
                      <div style={styles.threadMetaRow}>
                        <span style={styles.threadSender} title={thread.latest_sender}>
                          {thread.latest_sender}
                        </span>
                        <span style={styles.threadTime}>
                          {new Date(thread.last_message_at).toLocaleDateString()}
                        </span>
                      </div>
                      <h4 style={styles.threadSubject} title={thread.subject}>
                        {thread.subject || '(No Subject)'}
                      </h4>
                      <p style={styles.threadSnippet} title={thread.summary}>
                        {thread.summary || 'Summary pending...'}
                      </p>
                      <div style={styles.threadTags}>
                        <span className={`badge ${getBadgeClass(thread.representative_category)}`}>
                          {getCategoryIcon(thread.representative_category)}
                          <span style={{ marginLeft: '4px' }}>{thread.representative_category}</span>
                        </span>
                      </div>
                    </div>
                  ))
                )
              )}
            </div>
          </div>

          {/* Thread Detail and AI Reply Composer Panel */}
          <div style={styles.detailsPanel} className="glass-panel">
            {selectedThreadId && selectedThread ? (
              <div style={styles.threadWorkspace}>
                
                {/* Scrollable details view */}
                <div style={styles.threadScrollSection}>
                  <div style={styles.threadSubjectHeader}>
                    <h2>{selectedThread.subject || '(No Subject)'}</h2>
                  </div>

                  {/* Top Level AI Conversation Arc summary */}
                  <div style={styles.threadSummaryCard}>
                    <div style={styles.summaryCardHeader}>
                      <Sparkles size={16} color="#c084fc" />
                      <h4>AI THREAD SUMMARY (CONVERSATION ARC)</h4>
                    </div>
                    <p style={styles.summaryText}>
                      {selectedThread.summary || 'Analyzing thread narrative...'}
                    </p>
                  </div>

                  {/* Message stack */}
                  <div style={styles.messageStream}>
                    {emailsInThread.map((email) => {
                      const isExpanded = !!expandedEmails[email.id];
                      return (
                        <div key={email.id} style={styles.emailMsgCard}>
                          {/* Message Header (Click to collapse/expand) */}
                          <div 
                            onClick={() => toggleEmailExpand(email.id)}
                            style={styles.msgCardHeader}
                          >
                            <div style={styles.msgHeaderLeft}>
                              <div style={styles.msgAvatar}>
                                {email.from_name ? email.from_name.charAt(0).toUpperCase() : email.from_email.charAt(0).toUpperCase()}
                              </div>
                              <div>
                                <h5 style={styles.msgFromName}>
                                  {email.from_name || email.from_email}
                                </h5>
                                <span style={styles.msgFromEmail}>
                                  &lt;{email.from_email}&gt;
                                </span>
                              </div>
                            </div>

                            <div style={styles.msgHeaderRight}>
                              <span style={styles.msgTime}>
                                {new Date(email.received_at).toLocaleString()}
                              </span>
                              {isExpanded ? <ChevronUp size={16} /> : <ChevronDown size={16} />}
                            </div>
                          </div>

                          {/* Message Body (Render when expanded) */}
                          {isExpanded && (
                            <div style={styles.msgCardContent}>
                              {/* AI Message Summary */}
                              {email.summary && (
                                <div style={styles.individualMsgSummary}>
                                  <span style={{ fontWeight: 600, color: '#18181b' }}>AI Summary: </span>
                                  {email.summary}
                                </div>
                              )}
                              
                              <div style={styles.msgBodyText}>
                                <iframe
                                  srcDoc={(() => {
                                    if (email.html_body) {
                                      // Inject a minimal CSS reset + base font so HTML emails look clean inside the iframe
                                      const resetStyles = `
                                        <style>
                                          html, body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 14px; color: #1e293b; background: #ffffff; line-height: 1.6; max-width: 100%; }
                                          img { max-width: 100%; height: auto; }
                                          a { color: #4f46e5; }
                                          table { max-width: 100%; }
                                        </style>`;
                                      // Insert reset into <head> if it exists, otherwise prepend it
                                      if (email.html_body.includes('<head>')) {
                                        return email.html_body.replace('<head>', `<head>${resetStyles}`);
                                      } else if (email.html_body.includes('<html')) {
                                        return email.html_body.replace(/(<html[^>]*>)/i, `$1<head>${resetStyles}</head>`);
                                      }
                                      return `<!DOCTYPE html><html><head>${resetStyles}</head><body>${email.html_body}</body></html>`;
                                    }
                                    // Plain text fallback: convert newlines → <br>, wrap in a styled doc
                                    const escaped = (email.body || '(Empty email body)')
                                      .replace(/&/g, '&amp;')
                                      .replace(/</g, '&lt;')
                                      .replace(/>/g, '&gt;')
                                      .replace(/\n/g, '<br>');
                                    return `<!DOCTYPE html><html><head><style>
                                      body { margin: 0; padding: 16px; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Arial, sans-serif; font-size: 14px; color: #334155; background: #ffffff; line-height: 1.7; word-break: break-word; }
                                    </style></head><body>${escaped}</body></html>`;
                                  })()}
                                  sandbox="allow-popups allow-same-origin"
                                  style={{
                                    width: '100%',
                                    border: 'none',
                                    minHeight: '200px',
                                    backgroundColor: '#ffffff',
                                    borderRadius: '8px',
                                    marginTop: '8px',
                                    display: 'block',
                                  }}
                                  onLoad={(e) => {
                                    const iframe = e.currentTarget;
                                    // Auto-resize iframe to fit its content
                                    const resize = () => {
                                      try {
                                        const doc = iframe.contentDocument;
                                        if (doc?.body) {
                                          iframe.style.height = `${doc.body.scrollHeight + 24}px`;
                                        }
                                      } catch {
                                        // cross-origin guard — safe to ignore
                                      }
                                    };
                                    setTimeout(resize, 100);
                                    setTimeout(resize, 500); // second pass for images
                                  }}
                                />
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>

                {/* Reply Composer Section */}
                <div style={styles.replyComposerSection}>
                  <div style={styles.composerHeader}>
                    <Sparkles size={15} color="#18181b" />
                    <span>AI Draft Reply</span>
                    {draftingMode === 'auto-drafting' && (
                      <span style={styles.autoDraftingBadge}>
                        <div style={styles.autoDraftSpinner} />
                        Drafting smart reply...
                      </span>
                    )}
                  </div>

                  {/* Draft textarea — always visible */}
                  <textarea
                    style={styles.draftTextarea}
                    className="glass-input"
                    placeholder={
                      draftingMode === 'auto-drafting'
                        ? 'AI is writing a smart reply...'
                        : connection?.geminiQuotaExhausted
                        ? 'Gemini daily API quota exceeded. AI draft reply could not be generated automatically. You can write your reply manually here.'
                        : 'Edit your reply here...'
                    }
                    value={replyDraft}
                    onChange={(e) => setReplyDraft(e.target.value)}
                    disabled={draftingMode === 'auto-drafting'}
                  />

                  {/* Re-tune section — collapsible */}
                  <div style={styles.retuneSection}>
                    <button
                      onClick={() => setShowRetune(v => !v)}
                      style={styles.retuneToggleBtn}
                    >
                      <Sparkles size={13} color="#18181b" />
                      {showRetune ? 'Hide AI re-tune' : 'Re-tune with AI'}
                      {showRetune ? <ChevronUp size={13} /> : <ChevronDown size={13} />}
                    </button>

                    {showRetune && (
                      <div style={styles.retuneInputRow}>
                        <input
                          style={{ ...styles.input, flex: 1, height: '36px', padding: '8px 12px', fontSize: '0.85rem' }}
                          className="glass-input"
                          placeholder={connection?.geminiQuotaExhausted ? "AI Re-tune disabled (quota exceeded)" : "e.g. 'be more formal', 'decline politely', 'ask for a meeting'"}
                          value={replyPrompt}
                          onChange={(e) => setReplyPrompt(e.target.value)}
                          onKeyDown={(e) => { if (e.key === 'Enter' && !connection?.geminiQuotaExhausted) generateReply(); }}
                          disabled={connection?.geminiQuotaExhausted}
                        />
                        <button
                          onClick={generateReply}
                          className="glow-button"
                          style={{ height: '36px', width: '100px', flexShrink: 0 }}
                          disabled={draftingMode === 'drafting' || connection?.geminiQuotaExhausted}
                        >
                          {draftingMode === 'drafting' ? <div style={styles.miniSpinner} /> : 'Re-draft'}
                        </button>
                      </div>
                    )}
                  </div>

                  {/* Action row */}
                  <div style={styles.composerActionRow}>
                    <button
                      onClick={() => { setReplyDraft(''); setReplyPrompt(''); setShowRetune(false); }}
                      className="secondary-button"
                      style={{ height: '36px' }}
                    >
                      Clear
                    </button>
                    <button
                      onClick={sendReply}
                      className="glow-button"
                      style={{ height: '36px' }}
                      disabled={draftingMode === 'sending' || !replyDraft.trim()}
                    >
                      {draftingMode === 'sending' ? (
                        <div style={styles.miniSpinner} />
                      ) : (
                        <>
                          <Send size={14} />
                          Send reply
                        </>
                      )}
                    </button>
                  </div>
                </div>
              </div>
            ) : (
              <div style={styles.detailsPlaceholder}>
                <Mail size={48} color="#475569" style={{ marginBottom: '16px' }} />
                <h3>No Conversation Selected</h3>
                <p>Select a thread from the list on the left to read conversation content, view AI analysis summaries, and reply using AI prompts.</p>
              </div>
            )}
          </div>
        </div>
      </main>

      {/* 3. AI Chat Assistant Drawer (Right Slideout Panel) */}
      <aside 
        style={{
          ...styles.assistantDrawer,
          transform: assistantOpen ? 'translateX(0)' : 'translateX(100%)',
          boxShadow: assistantOpen ? '-8px 0 25px rgba(0,0,0,0.5)' : 'none',
        }}
        className="glass-panel"
      >
        <div style={styles.drawerHeader}>
          <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
            <Sparkles size={18} color="#22d3ee" />
            <h3 style={{ fontSize: '1.1rem', fontWeight: 600 }}>AI Inbox Assistant</h3>
          </div>
          <button onClick={() => setAssistantOpen(false)} style={styles.closeDrawerBtn}>
            <X size={20} />
          </button>
        </div>

        {/* Chat History Panel */}
        <div style={styles.chatHistorySection}>
          {chatMessages.map((msg, idx) => (
            <div 
              key={idx} 
              style={{
                ...styles.chatBubbleContainer,
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start'
              }}
            >
              <div 
                style={{
                  ...styles.chatBubble,
                  backgroundColor: msg.role === 'user' ? 'rgba(120, 100, 230, 0.85)' : 'rgba(0, 0, 0, 0.04)',
                  borderColor: msg.role === 'user' ? 'rgba(120, 100, 230, 0.9)' : 'rgba(0, 0, 0, 0.06)',
                  color: msg.role === 'user' ? '#ffffff' : '#1e293b',
                  alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
                }}
              >
                {renderMessageContent(msg.text)}
              </div>
            </div>
          ))}
          {chatLoading && (
            <div style={{ ...styles.chatBubbleContainer, justifyContent: 'flex-start' }}>
              <div style={{ ...styles.chatBubble, backgroundColor: 'transparent', border: 'none' }}>
                <div style={styles.miniSpinner}></div>
              </div>
            </div>
          )}
          <div ref={chatEndRef} />
        </div>

        {/* Quick action prompts */}
        <div style={styles.quickPromptsRow}>
          <button 
            onClick={() => setChatInput('What has been discussed about the data migration project?')}
            style={styles.quickPromptBtn}
          >
            Migration discussions
          </button>
          <button 
            onClick={() => setChatInput('Give me an overview of what I know about Kubernetes from my emails.')}
            style={styles.quickPromptBtn}
          >
            Kubernetes summaries
          </button>
          <button 
            onClick={() => setChatInput('Which companies rejected my job application? List them all.')}
            style={styles.quickPromptBtn}
          >
            Job application status
          </button>
        </div>

        {/* Input Form */}
        {connection?.geminiQuotaExhausted && (
          <div style={{
            padding: '8px 12px',
            backgroundColor: '#fffbeb',
            borderTop: '1px solid #fef3c7',
            borderBottom: '1px solid #fef3c7',
            color: '#b45309',
            fontSize: '0.75rem',
            textAlign: 'center'
          }}>
            ⚠️ Gemini daily quota exceeded. Chat assistant is offline.
          </div>
        )}
        <form onSubmit={submitChat} style={styles.chatForm}>
          <input
            style={styles.chatInput}
            className="glass-input"
            type="text"
            placeholder={connection?.geminiQuotaExhausted ? "Chat is disabled due to quota limits." : "Ask AI about your inbox..."}
            value={chatInput}
            onChange={(e) => setChatInput(e.target.value)}
            disabled={chatLoading || connection?.geminiQuotaExhausted}
          />
          <button 
            type="submit" 
            className="glow-button" 
            style={styles.chatSendBtn} 
            disabled={chatLoading || connection?.geminiQuotaExhausted}
          >
            <Send size={15} />
          </button>
        </form>
      </aside>

      {/* 4. Compose New Email Dialog Modal */}
      {composeModalOpen && (
        <div style={styles.modalOverlay}>
          <div style={styles.modalCard} className="glass-panel">
            <div style={styles.modalHeader}>
              <h3>Compose New Email</h3>
              <button onClick={() => setComposeModalOpen(false)} style={styles.closeDrawerBtn}>
                <X size={18} />
              </button>
            </div>

            <div style={styles.modalForm}>
              <div style={styles.inputGroup}>
                <label style={styles.label}>Recipient (To)</label>
                <input
                  style={styles.input}
                  className="glass-input"
                  type="email"
                  placeholder="recipient@domain.com"
                  value={newEmailForm.to}
                  onChange={(e) => setNewEmailForm(p => ({ ...p, to: e.target.value }))}
                />
              </div>

              <div style={styles.inputGroup}>
                <label style={styles.label}>Subject</label>
                <input
                  style={styles.input}
                  className="glass-input"
                  type="text"
                  placeholder="Subject line"
                  value={newEmailForm.subject}
                  onChange={(e) => setNewEmailForm(p => ({ ...p, subject: e.target.value }))}
                />
              </div>

              <div style={styles.inputGroup}>
                <label style={styles.label}>AI Writing Prompt</label>
                <div style={{ display: 'flex', gap: '8px' }}>
                  <input
                    style={{ ...styles.input, flex: 1 }}
                    className="glass-input"
                    type="text"
                    placeholder="e.g. 'Write a follow-up to product team about WWDC launch details'"
                    value={newEmailForm.prompt}
                    onChange={(e) => setNewEmailForm(p => ({ ...p, prompt: e.target.value }))}
                  />
                  <button 
                    onClick={generateNewEmailDraft}
                    className="glow-button"
                    style={{ height: '38px', flexShrink: 0 }}
                    disabled={draftingMode === 'drafting' || !newEmailForm.prompt}
                  >
                    {draftingMode === 'drafting' ? <div style={styles.miniSpinner}></div> : 'Draft'}
                  </button>
                </div>
              </div>

              {newEmailForm.draft && (
                <div style={styles.inputGroup}>
                  <label style={styles.label}>Draft Preview</label>
                  <textarea
                    style={{ ...styles.input, minHeight: '180px', fontFamily: 'inherit' }}
                    className="glass-input"
                    value={newEmailForm.draft}
                    onChange={(e) => setNewEmailForm(p => ({ ...p, draft: e.target.value }))}
                  />
                </div>
              )}

              <div style={styles.modalActionRow}>
                <button 
                  onClick={() => setComposeModalOpen(false)}
                  className="secondary-button"
                  style={{ height: '38px' }}
                >
                  Cancel
                </button>
                <button 
                  onClick={sendNewEmail}
                  className="glow-button"
                  style={{ height: '38px' }}
                  disabled={draftingMode === 'sending' || !newEmailForm.draft || !newEmailForm.to}
                >
                  {draftingMode === 'sending' ? (
                    <div style={styles.miniSpinner}></div>
                  ) : (
                    <>
                      <Send size={14} />
                      Send email
                    </>
                  )}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

    </div>
  );
}

// Visual Inline Style System (supports modern responsive flex grid)
const styles: Record<string, React.CSSProperties> = {
  dashboardLayout: {
    display: 'flex',
    width: '100vw',
    height: '100vh',
    overflow: 'hidden',
    position: 'relative',
  },
  sidebar: {
    width: '260px',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    padding: '24px 18px',
    borderRight: '1px solid var(--glass-border)',
    borderRadius: 0,
    zIndex: 10,
    flexShrink: 0,
  },
  sidebarHeader: {
    marginBottom: '24px',
  },
  sidebarLogoBox: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  logoText: {
    fontSize: '1.25rem',
    fontWeight: 700,
    letterSpacing: '2px',
    background: 'linear-gradient(135deg, #4f46e5 0%, #7c3aed 100%)',
    WebkitBackgroundClip: 'text',
    WebkitTextFillColor: 'transparent',
  },
  connectionBox: {
    background: 'rgba(0, 0, 0, 0.02)',
    border: '1px solid rgba(0, 0, 0, 0.04)',
    borderRadius: '10px',
    padding: '12px 14px',
    marginBottom: '24px',
  },
  connectionDetails: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    overflow: 'hidden',
  },
  connectionPulse: {
    width: '7px',
    height: '7px',
    borderRadius: '50%',
    backgroundColor: '#10b981',
    boxShadow: '0 0 8px #10b981',
    flexShrink: 0,
  },
  connectionEmail: {
    fontSize: '0.85rem',
    fontWeight: 500,
    color: 'var(--text)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  syncMeta: {
    fontSize: '0.75rem',
    color: '#64748b',
    marginTop: '4px',
  },
  sidebarScrollable: {
    flex: 1,
    overflowY: 'auto' as const,
    paddingRight: '2px',   // thin padding so scrollbar doesn't clip buttons
    minHeight: 0,          // essential: allows flex child to shrink below content height
  },
  sidebarFooter: {
    flexShrink: 0,
    paddingTop: '12px',
    borderTop: '1px solid rgba(0,0,0,0.06)',
    marginTop: '4px',
  },
  categoryNav: {
    display: 'flex',
    flexDirection: 'column',
    gap: '4px',
  },
  sectionHeading: {
    fontSize: '0.75rem',
    fontWeight: 600,
    color: '#475569',
    letterSpacing: '1px',
    margin: '12px 0 8px 8px',
  },
  categoryBtn: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '10px 12px',
    borderRadius: '8px',
    border: '1px solid transparent',
    background: 'transparent',
    fontFamily: 'inherit',
    fontSize: '0.88rem',
    cursor: 'pointer',
    transition: 'var(--transition-fast)',
  },
  catLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '10px',
  },
  catCount: {
    fontSize: '0.75rem',
    fontWeight: 500,
    background: 'rgba(0, 0, 0, 0.03)',
    color: '#475569',
    padding: '2px 6px',
    borderRadius: '12px',
  },
  bonusBadge: {
    fontSize: '0.7rem',
    fontWeight: 600,
    background: 'rgba(34, 211, 238, 0.1)',
    color: '#22d3ee',
    border: '1px solid rgba(34, 211, 238, 0.25)',
    padding: '1px 6px',
    borderRadius: '10px',
  },
  mainContent: {
    flex: 1,
    height: '100%',
    padding: '20px 24px',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
    overflow: 'hidden',
  },
  workspaceGrid: {
    display: 'flex',
    gap: '20px',
    flex: 1,
    height: '100%',
    overflow: 'hidden',
  },
  threadsPanel: {
    width: '380px',
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    borderRadius: '12px',
    flexShrink: 0,
    overflow: 'hidden',
  },
  panelHeader: {
    padding: '18px 20px',
    borderBottom: '1px solid var(--border)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  panelTitle: {
    fontSize: '1rem',
    fontWeight: 600,
  },
  threadBadgeCount: {
    fontSize: '0.78rem',
    background: 'rgba(0,0,0,0.03)',
    border: '1px solid var(--border)',
    padding: '3px 8px',
    borderRadius: '12px',
    color: '#475569',
  },
  scrollableList: {
    flex: 1,
    overflowY: 'auto',
    padding: '10px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  listCenteredText: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '200px',
    textAlign: 'center',
    color: '#475569',
    fontSize: '0.85rem',
    padding: '24px',
  },
  threadCard: {
    padding: '14px 16px',
    borderRadius: '10px',
    border: '1px solid rgba(0,0,0,0.03)',
    background: 'rgba(0, 0, 0, 0.01)',
    cursor: 'pointer',
    transition: 'var(--transition-smooth)',
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  threadMetaRow: {
    display: 'flex',
    justifyContent: 'space-between',
    fontSize: '0.78rem',
  },
  threadSender: {
    color: '#1e293b',
    fontWeight: 500,
    maxWidth: '180px',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
  },
  threadTime: {
    color: '#64748b',
  },
  threadSubject: {
    fontSize: '0.9rem',
    color: '#0f172a',
    fontWeight: 500,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  threadSnippet: {
    fontSize: '0.82rem',
    color: '#475569',
    lineHeight: '1.4',
    display: '-webkit-box',
    WebkitLineClamp: 2,
    WebkitBoxOrient: 'vertical',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
  },
  threadTags: {
    display: 'flex',
    marginTop: '4px',
  },
  detailsPanel: {
    flex: 1,
    height: '100%',
    borderRadius: '12px',
    overflow: 'hidden',
  },
  detailsPlaceholder: {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    height: '100%',
    padding: '48px',
    textAlign: 'center',
    color: '#64748b',
    maxWidth: '500px',
    margin: '0 auto',
    gap: '12px',
  },
  threadWorkspace: {
    display: 'flex',
    flexDirection: 'column',
    height: '100%',
  },
  threadScrollSection: {
    flex: 1,
    overflowY: 'auto',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  threadSubjectHeader: {
    paddingBottom: '16px',
    borderBottom: '1px solid var(--border)',
  },
  threadSummaryCard: {
    background: 'rgba(245, 243, 255, 0.85)', // Soft lavender card background
    border: '1px solid rgba(120, 100, 230, 0.2)',
    boxShadow: '0 4px 15px rgba(120, 100, 230, 0.04)',
    borderRadius: '12px',
    padding: '18px 20px',
  },
  summaryCardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    marginBottom: '8px',
    fontSize: '0.82rem',
    fontWeight: 600,
    color: '#5b21b6', // Rich purple header text
    letterSpacing: '0.5px',
  },
  summaryText: {
    fontSize: '0.92rem',
    lineHeight: '1.6',
    color: '#1e293b',
  },
  messageStream: {
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  emailMsgCard: {
    border: '1px solid var(--border)',
    background: 'rgba(0, 0, 0, 0.005)',
    borderRadius: '10px',
    overflow: 'hidden',
  },
  msgCardHeader: {
    padding: '14px 18px',
    background: 'rgba(0, 0, 0, 0.01)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    cursor: 'pointer',
    userSelect: 'none',
  },
  msgHeaderLeft: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
  },
  msgAvatar: {
    width: '32px',
    height: '32px',
    borderRadius: '50%',
    background: 'linear-gradient(135deg, #3f3f46 0%, #18181b 100%)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: '#ffffff',
    fontSize: '0.9rem',
    fontWeight: 600,
  },
  msgFromName: {
    fontSize: '0.88rem',
    color: '#0f172a',
    fontWeight: 500,
    display: 'inline',
  },
  msgFromEmail: {
    fontSize: '0.78rem',
    color: '#64748b',
    marginLeft: '6px',
  },
  msgHeaderRight: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    color: '#64748b',
    fontSize: '0.78rem',
  },
  msgCardContent: {
    padding: '18px',
    borderTop: '1px solid var(--border)',
    background: 'rgba(0, 0, 0, 0.01)',
  },
  individualMsgSummary: {
    background: 'rgba(240, 253, 250, 0.85)', // Soft pastel mint teal background
    border: '1px solid rgba(45, 212, 191, 0.3)',
    padding: '10px 14px',
    borderRadius: '6px',
    fontSize: '0.85rem',
    color: '#0f766e', // Dark teal text
    lineHeight: '1.5',
    marginBottom: '16px',
  },
  msgBodyText: {
    fontSize: '0.9rem',
    color: '#334155',
    lineHeight: '1.6',
    whiteSpace: 'pre-wrap',
  },
  replyComposerSection: {
    borderTop: '1px solid var(--border)',
    padding: '20px 24px',
    background: 'rgba(0, 0, 0, 0.01)',
    display: 'flex',
    flexDirection: 'column',
    gap: '12px',
  },
  composerHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '0.82rem',
    fontWeight: 500,
    color: '#18181b',
  },
  autoDraftingBadge: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '0.75rem',
    color: '#64748b',
    fontWeight: 400,
    marginLeft: '4px',
  },
  autoDraftSpinner: {
    width: '11px',
    height: '11px',
    border: '1.5px solid rgba(24, 24, 27, 0.15)',
    borderTop: '1.5px solid #18181b',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
    flexShrink: 0,
  },
  retuneSection: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  retuneToggleBtn: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    fontSize: '0.8rem',
    color: '#18181b',
    fontFamily: 'inherit',
    fontWeight: 500,
    padding: '4px 0',
    width: 'fit-content',
    transition: 'var(--transition-fast)',
  },
  retuneInputRow: {
    display: 'flex',
    gap: '8px',
    alignItems: 'center',
    animation: 'fadeIn 0.2s ease-out',
  },
  promptArea: {
    display: 'flex',
    gap: '10px',
  },
  composerTextarea: {
    flex: 1,
    height: '42px',
    resize: 'none' as const,
    minHeight: '42px',
    padding: '10px 14px',
  },
  composerBtn: {
    height: '42px',
    width: '120px',
  },
  draftPreviewBox: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
    animation: 'fadeIn 0.3s ease-out',
  },
  draftPreviewHeader: {
    fontSize: '0.8rem',
    color: '#94a3b8',
    fontWeight: 500,
  },
  draftTextarea: {
    width: '100%',
    height: '160px',
    fontFamily: 'inherit',
    lineHeight: '1.5',
    resize: 'vertical' as const,
  },
  composerActionRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
  },
  assistantDrawer: {
    position: 'fixed',
    top: 0,
    right: 0,
    width: '380px',
    height: '100%',
    borderRadius: 0,
    zIndex: 100,
    borderLeft: '1px solid var(--glass-border)',
    padding: '24px',
    display: 'flex',
    flexDirection: 'column',
    transition: 'transform 0.4s cubic-bezier(0.16, 1, 0.3, 1)',
    backgroundColor: '#ffffff', // Solid background to prevent transparency overlap issues
    boxShadow: '-4px 0 20px rgba(0, 0, 0, 0.05)',
  },
  drawerHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    marginBottom: '20px',
  },
  closeDrawerBtn: {
    background: 'transparent',
    border: 'none',
    color: '#94a3b8',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  chatHistorySection: {
    flex: 1,
    overflowY: 'auto',
    display: 'flex',
    flexDirection: 'column',
    gap: '14px',
    paddingRight: '4px',
    marginBottom: '14px',
  },
  chatBubbleContainer: {
    display: 'flex',
    width: '100%',
  },
  chatBubble: {
    maxWidth: '85%',
    padding: '12px 14px',
    borderRadius: '12px',
    border: '1px solid transparent',
    fontSize: '0.88rem',
    color: '#1e293b',
  },
  citationBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    background: 'rgba(139, 92, 246, 0.1)',
    border: '1px solid rgba(139, 92, 246, 0.3)',
    color: '#c084fc',
    padding: '2px 6px',
    borderRadius: '6px',
    fontSize: '0.78rem',
    margin: '0 4px',
    cursor: 'pointer',
    fontFamily: 'inherit',
    fontWeight: 500,
  },
  quickPromptsRow: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
    marginBottom: '12px',
  },
  quickPromptBtn: {
    background: 'rgba(79, 70, 229, 0.04)',
    border: '1px solid rgba(79, 70, 229, 0.12)',
    borderRadius: '8px',
    padding: '8px 12px',
    color: '#4f46e5',
    fontSize: '0.8rem',
    textAlign: 'left' as const,
    cursor: 'pointer',
    fontFamily: 'inherit',
    transition: 'var(--transition-fast)',
  },
  chatForm: {
    display: 'flex',
    gap: '8px',
  },
  chatInput: {
    flex: 1,
  },
  chatSendBtn: {
    width: '42px',
    height: '42px',
    padding: 0,
    flexShrink: 0,
  },
  notificationBar: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    padding: '6px 12px',
    marginBottom: '12px',
    background: 'rgba(255,255,255,0.8)',
    border: '1px solid hsl(var(--border))',
    borderRadius: '8px',
    fontSize: '0.8rem',
    fontWeight: 500,
    color: '#475569',
    alignSelf: 'flex-start',
    maxWidth: 'fit-content',
    backdropFilter: 'blur(8px)',
    boxShadow: '0 1px 4px rgba(0,0,0,0.06)',
    flexWrap: 'wrap' as const,
  },
  notifItem: {
    display: 'flex',
    alignItems: 'center',
    gap: '5px',
    color: '#475569',
  },
  notifSpinner: {
    width: '12px',
    height: '12px',
    border: '1.5px solid rgba(79, 70, 229, 0.2)',
    borderTop: '1.5px solid #4f46e5',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
    flexShrink: 0,
  },
  notifClose: {
    background: 'transparent',
    border: 'none',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    color: '#dc2626',
    padding: '0 2px',
  },
  toastStatus: {
    display: 'none',
  },
  toastError: {
    display: 'none',
  },
  toastClose: {
    display: 'none',
  },
  modalOverlay: {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    background: 'rgba(0, 0, 0, 0.6)',
    backdropFilter: 'blur(4px)',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    zIndex: 9999,
  },
  modalCard: {
    width: '100%',
    maxWidth: '560px',
    padding: '28px',
    display: 'flex',
    flexDirection: 'column',
    gap: '20px',
  },
  modalHeader: {
    display: 'flex',
    justifyContent: 'space-between',
    alignItems: 'center',
    borderBottom: '1px solid var(--border)',
    paddingBottom: '12px',
  },
  modalForm: {
    display: 'flex',
    flexDirection: 'column',
    gap: '16px',
  },
  modalActionRow: {
    display: 'flex',
    justifyContent: 'flex-end',
    gap: '8px',
    borderTop: '1px solid var(--border)',
    paddingTop: '16px',
  },
  newsCard: {
    background: 'rgba(255,255,255,0.01)',
    border: '1px solid var(--border)',
    borderRadius: '10px',
    padding: '16px',
    display: 'flex',
    flexDirection: 'column',
    gap: '8px',
  },
  newsHeader: {
    display: 'flex',
    flexDirection: 'column',
    gap: '6px',
  },
  newsStoryTitle: {
    fontSize: '0.95rem',
    fontWeight: 600,
    color: '#0f172a', // Dark text for light mode
  },
  sourcesRow: {
    display: 'flex',
    flexWrap: 'wrap',
    gap: '6px',
  },
  newsSourceBadge: {
    fontSize: '0.72rem',
    background: 'rgba(8, 145, 178, 0.1)',
    border: '1px solid rgba(8, 145, 178, 0.25)',
    color: '#0891b2',
    padding: '1px 6px',
    borderRadius: '8px',
  },
  newsSummary: {
    fontSize: '0.85rem',
    color: '#475569',
    lineHeight: '1.5',
  },
  spinner: {
    width: '24px',
    height: '24px',
    border: '2px solid rgba(24, 24, 27, 0.1)',
    borderTop: '2px solid #18181b',
    borderRadius: '50%',
    animation: 'spin 1s linear infinite',
  },
  miniSpinner: {
    width: '18px',
    height: '18px',
    border: '2px solid rgba(255, 255, 255, 0.25)',
    borderTop: '2px solid #ffffff',
    borderRadius: '50%',
    animation: 'spin 0.8s linear infinite',
  },
  inputGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  label: {
    fontSize: '0.82rem',
    fontWeight: 500,
    color: '#475569',
    letterSpacing: '0.2px',
  },
  input: {
    width: '100%',
    padding: '10px 14px',
    borderRadius: '8px',
    border: '1px solid var(--border)',
    background: '#ffffff',
    color: 'hsl(var(--text))',
    fontFamily: 'inherit',
    fontSize: '0.95rem',
    outline: 'none',
  },
};
