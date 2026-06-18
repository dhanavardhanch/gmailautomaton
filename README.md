# Aether: AI-Powered Gmail Intelligence Platform

Aether is an intelligent email automation and reasoning web application. It securely links to a user's Gmail inbox via OAuth 2.0, syncs email data incrementally into a Supabase PostgreSQL database (equipped with pgvector), and features a RAG (Retrieval-Augmented Generation) assistant that acts as a secure knowledge base over the user's emails.

---

## Key Features

1. **Gmail Integration**: Secure OAuth 2.0 connection that incrementally syncs inbox threads, messages, and headers. Includes exponential backoff retries to manage Google API rate-limiting (429s).
2. **Conversation Arc Summarization**: Computes individual email summaries (Gemini 2.5) and generates chronological thread conversation summaries.
3. **Smart Email Composer**: Generates professional replies with complete conversation context from short prompts, sending emails using appropriate `In-Reply-To` and `References` headers to preserve threading.
4. **Email Categorization**: Classifies emails automatically into 6 categories (Newsletters, Job/Recruitment, Finance, Notifications, Personal, Work) using Llama 3.1 70B via NVIDIA NIM.
5. **AI Chat Assistant drawer**: An inbox chat agent implementing hybrid search (vector matching on text-embedding-004 + metadata filters). Supports source clarity with clickable citations that open referenced threads in the dashboard.
6. **Newsletter Deduplication**: Clusters duplicate news stories across multiple subscription newsletters semantically using NVIDIA NIM.

---

## Tech Stack

- **Frontend & Backend**: Next.js (TypeScript, App Router, React 19)
- **Styling**: Custom responsive CSS (Vanilla CSS Modules / Globals)
- **Database**: Supabase PostgreSQL with `pgvector`
- **Primary AI Model**: Google Gemini API (`gemini-2.5-flash` & `text-embedding-004`)
- **Secondary AI Model**: NVIDIA NIM (`meta/llama-3.1-70b-instruct` or `nvidia/llama-3.1-nemotron-70b-instruct`)

---

## Step-by-Step Setup Guide

### 1. Database Setup (Supabase)
1. Sign up for a free project at [Supabase](https://supabase.com).
2. Open your project dashboard, navigate to the **SQL Editor**, and create a new query.
3. Open [schema.sql](file:///c:/Users/troog/Downloads/Mail/gmailautomaton/schema.sql) from this project, paste the content into the Supabase SQL editor, and click **Run**.
4. Under **Project Settings** -> **API**, locate your:
   - **Project URL**
   - **Anon Public API Key**
   - **Service Role Secret Key** (required for background data ingestion)

### 2. Google OAuth Credentials Setup
1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. Create a new project, navigate to **APIs & Services** -> **Library**, and search for and **Enable** the **Gmail API**.
3. Go to **OAuth Consent Screen**:
   - Choose **External** user type.
   - Set up developer emails and app details.
   - Add scopes: `.../auth/gmail.readonly`, `.../auth/gmail.send`, and `.../auth/userinfo.email`.
   - Publish your app to Testing status and add your test Gmail address to the Test Users list.
4. Navigate to **Credentials** -> **Create Credentials** -> **OAuth Client ID**:
   - Select **Web Application**.
   - Add Authorized Redirect URI: `http://localhost:3000/api/oauth/callback`
   - Retrieve your **Client ID** and **Client Secret**.

### 3. API Keys
- Obtain a Gemini API Key from Google AI Studio.
- Obtain an NVIDIA NIM API Key (`nvapi-...`) from build.nvidia.com.

### 4. Running Locally
1. Start the application:
   ```bash
   npm run dev
   ```
2. Navigate to `http://localhost:3000` in your web browser.
3. If credentials are not set in your `.env.local` file, you will be greeted by a **Setup Wizard** page. Enter your Supabase, Google, Gemini, and NVIDIA NIM keys and click **Save**. This creates a local configuration file.
4. Once configured, click **Connect Gmail account** to authorize the application. Google will redirect you back, initiating the synchronization!

---

## Project Structure

```text
├── schema.sql           # Database tables, pgvector indices, and search RPC
├── local_config.json    # Local credentials configuration file (ignored by git)
├── Architecture.md      # Detailed system architecture document
└── src/
    ├── app/             # Next.js App Router (pages and API Route Handlers)
    │   ├── api/
    │   │   ├── chat/    # RAG assistant conversation pipeline
    │   │   ├── config/  # Reads/Writes dynamic client setups
    │   │   ├── oauth/   # Google OAuth redirects and callbacks
    │   │   ├── sync/    # Ingests Gmail messages incrementally
    │   │   ├── news/    # Extracts and deduplicates newsletters
    │   │   └── emails/  # Generates drafts and sends emails
    │   ├── dashboard/   # Centered inbox dashboard UI
    │   ├── globals.css  # CSS styling design system variables
    │   ├── layout.tsx   # Global Next.js page layout
    │   └── page.tsx     # Onboarding setup forms
    └── lib/             # Helper libraries
        ├── config.ts    # Config loaders (env vs local config file)
        ├── supabase.ts  # Dynamic ES6 connection Proxy wrappers
        ├── gmail.ts     # Google API helpers and MIME body parser
        ├── gemini.ts    # Summarization, RAG prompts, and embedding models
        └── nvidia.ts    # NVIDIA NIM categorization and news deduplication
```
