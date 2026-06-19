# Aether: AI-Powered Gmail Intelligence Platform

Aether is a secure, state-of-the-art email automation, summarization, and reasoning platform. Built with Next.js, React 19, and Supabase, it securely indexes your Gmail messages via Google OAuth 2.0, performs semantic analysis, and runs a Retrieval-Augmented Generation (RAG) assistant over your emails using Mistral and NVIDIA NIM models.

---

## 🌟 Key Features

1. **Multi-Account Dynamic Separation**: Aether supports connecting multiple Gmail accounts simultaneously. Each connection is assigned a unique client-side UUID, ensuring that emails, threads, and vector embeddings remain segregated in Supabase and that users only see their own emails.
2. **Fast Two-Phase Sync**: 
   - **Phase 1 (Instant Sync)**: Raw emails are fetched and saved to the database immediately (takes 1–2 seconds). The UI sync loader completes, allowing you to read your emails instantly.
   - **Phase 2 (Background AI Enrichment)**: AI email summarization, categorization, and chunk vector embedding generation run asynchronously in the background.
3. **Smart Email Composer**: Generates contextually accurate draft replies by analyzing the thread history. Sends responses with proper `In-Reply-To` and `References` headers to maintain Gmail threading.
4. **Email Categorization**: Automatically groups emails into 6 categories (*Newsletters, Job/Recruitment, Finance, Notifications, Personal, Work*) using Llama 3.1 70B via NVIDIA NIM.
5. **Hybrid Vector RAG Chat Assistant**: Chat directly with your inbox! The assistant runs a vector search using NVIDIA NIM text-embeddings and references the exact sources with clickable citation links that open corresponding email threads in the dashboard.
6. **Smart Sync Pagination**: Ingests your inbox incrementally. Each sync click fetches the newest emails first. If there are no new emails, it automatically pages back to sync your older emails in batches of 10, keeping rate-limit quotas safe.

---

## 🛠 Tech Stack

- **Framework**: Next.js 16 (TypeScript, App Router, React 19)
- **Styling**: Responsive Vanilla CSS Modules
- **Database**: Supabase PostgreSQL with `pgvector`
- **AI Suite (NVIDIA NIM & Mistral)**: 
  - `mistralai/mistral-medium-3.5-128b` (or other Mistral models) for email/thread summaries, draft replies, search query parsing, and conversational RAG.
  - `nvidia/nv-embedqa-e5-v5` for 768-dimensional truncated text embeddings.
  - `meta/llama-3.1-70b-instruct` (or Nemotron) for zero-shot email categorization and newsletter topic deduplication.

---

## 📋 Pre-requisites & Account Configuration

Before starting, you must retrieve API credentials from the following platforms:

### 1. Supabase Project Setup
1. Create a free project at [Supabase](https://supabase.com).
2. Go to the **SQL Editor** tab in your Supabase dashboard and click **New Query**.
3. Copy the contents of [`schema.sql`](file:///c:/Users/troog/Downloads/Mail/gmailautomaton/schema.sql), paste it into the editor, and click **Run**. This sets up your tables, vector indexes, and semantic search RPC.
4. Navigate to **Project Settings** -> **API** to obtain:
   - **Project URL**
   - **Anon Public API Key**
   - **Service Role Secret Key** (required to bypass Row Level Security for administrative synchronization)

### 2. Google Cloud Console (OAuth & Gmail API)
1. Go to the [Google Cloud Console](https://console.cloud.google.com).
2. Create a project and enable the **Gmail API** under **APIs & Services** -> **Library**.
3. Configure the **OAuth Consent Screen**:
   - Select **External** user type.
   - Add scopes: `.../auth/gmail.readonly`, `.../auth/gmail.send`, and `.../auth/userinfo.email`.
   - Set publish status to **Production** or add your target Gmail accounts under the **Test Users** section.
4. Go to **Credentials** -> **Create Credentials** -> **OAuth Client ID**:
   - Select **Web Application**.
   - Add **Authorized Redirect URIs**:
     - Local development: `http://localhost:3000/api/oauth/callback`
     - Production deployment: `https://YOUR-APP.vercel.app/api/oauth/callback`
   - Copy the generated **Client ID** and **Client Secret**.

### 3. AI Platform Keys
- **NVIDIA NIM API Key**: Register and generate a key (`nvapi-...`) at [NVIDIA Build](https://build.nvidia.com) to power all Mistral text generation and E5 embeddings.

---

## 🚀 Step-by-Step Setup Instructions

### Local Development Setup

1. **Clone the Repository & Install Dependencies**:
   ```bash
   cd gmailautomaton
   npm install
   ```

2. **Configure Environment Variables**:
   You can configure the app in one of two ways:
   
   - **Option A (Setup Wizard)**: Simply run the application (Step 3). Since no `.env.local` exists, you will be redirected to an onboarding configuration screen. Enter your keys, and the application will write them to a local, git-ignored `local_config.json` file.
   
   - **Option B (Manual Environment File)**: Create a `.env.local` file in the root of the project with the following:
     ```env
     NEXT_PUBLIC_SUPABASE_URL=https://your-project-ref.supabase.co
     NEXT_PUBLIC_SUPABASE_ANON_KEY=your-anon-key
     SUPABASE_SERVICE_ROLE_KEY=your-service-role-key
     GOOGLE_CLIENT_ID=your-client-id.apps.googleusercontent.com
     GOOGLE_CLIENT_SECRET=your-client-secret
     GOOGLE_REDIRECT_URI=http://localhost:3000/api/oauth/callback
     NVIDIA_NIM_API_KEY=nvapi-your-nvidia-key
     NVIDIA_NIM_MODEL=mistralai/mistral-medium-3.5-128b
     ```

3. **Start the Dev Server**:
   ```bash
   npm run dev
   ```
4. **Open the Application**:
   Navigate to `http://localhost:3000`. Click **Connect Gmail account** to link your inbox.

---

### Production Deployment to Vercel

1. **Link Google OAuth Redirect URI**:
   Ensure you have added your Vercel URL `https://YOUR-APP.vercel.app/api/oauth/callback` to the Authorized Redirect URIs in your Google Cloud Console.

2. **Deploy via Vercel CLI**:
   Install the Vercel CLI, login, and initialize the project:
   ```bash
   npm install -g vercel
   vercel login
   vercel --prod
   ```

3. **Set Production Environment Variables**:
   Add all keys listed in the `.env.local` section to **Vercel Dashboard** -> **Project Settings** -> **Environment Variables**.
   *Note: Ensure `GOOGLE_REDIRECT_URI` on Vercel is set to `https://YOUR-APP.vercel.app/api/oauth/callback`.*

4. **Add URL Configuration in Supabase**:
   Go to **Supabase Dashboard** -> **Authentication** -> **URL Configuration**:
   - Set **Site URL** to `https://YOUR-APP.vercel.app`.
   - Add `https://YOUR-APP.vercel.app/**` to **Redirect URLs**.

5. **Redeploy**:
   ```bash
   vercel --prod
   ```

---

## 📂 Project Structure

```text
├── schema.sql           # Database tables, pgvector indices, and search RPC
├── Architecture.md      # Detailed system architecture document
├── README.md            # App setup guide and documentation
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
        ├── supabase.ts  # Dynamic connection Proxy wrappers
        ├── gmail.ts     # Google API helpers and MIME body parser
        ├── mistral.ts   # Summarization, RAG prompts, and embedding models
        └── nvidia.ts    # NVIDIA NIM categorization and news deduplication
```

---

## ⚙️ How Synchronization and Paging Works Under the Hood

The background synchronization logic is located in [`src/lib/sync.ts`](file:///c:/Users/troog/Downloads/Mail/gmailautomaton/src/lib/sync.ts):

1. **New Email Detection**: When you click the **Sync** button, the worker checks the first page (newest 10 threads) of your Gmail inbox. If it detects any thread that has not been saved in `email_threads`, it ingests the new threads.
2. **Inbox Paging (Older Sync)**: If there are no new emails on the first page, the sync reads the `last_history_id` column (which stores the Google API `nextPageToken`). It uses this token to fetch the next page of 10 older threads. This allows users to page backward in time and sync their entire historical inbox in manageable increments of 10 emails per click.
3. **Non-blocking Status Update**: The moment raw emails are successfully inserted into Supabase (Phase 1), `sync_status` is updated to `'completed'`. The HTTP request resolves immediately, releasing the client UI loader. The heavy processing (generating summaries and computing embeddings) continues to execute asynchronously in the background.
